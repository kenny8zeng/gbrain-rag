import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config";
import { buildMarkdown, slugifyName, type IngestJob, type IngestOutcome } from "./pipeline";
import { DOC_DIR, ENTITY_DIR, MAX_ENTITIES_PER_RUN, entityStub, extractWikilinkTargets } from "../entity-graph";
import { runGbrain } from "../gbrain-cli";

/**
 * bulk 批量导入（009）：
 * 归档（tar -xf 可自动探测的格式）→ 解包 → 仅收 *.md → slug 归位 docs/<slug>.md
 * → 双链目标实体页 entities/ → 单次 `gbrain import`（含 embed）→ 单次 `extract links` 建边。
 *
 * 与逐篇管道的分工边界：
 * - bulk 不经过解析器链（md 直通语义；格式转换是客户端责任）
 * - import 不建双链边 → 边由事后一次 extract links 统一补齐（幂等，语义与 put auto_link 一致：
 *   目标页不存在的引用永不持久化）
 * - upsert 语义：归档里没有的旧文档不会被删除（镜像语义需先 purge）
 */

/** import 单进程内并行 embed 数（节点 4 核；进程整体只占 CLI 闸门 1 个槽） */
const BULK_WORKERS = 4;
/**
 * bulk 任务级超时：单次 import 覆盖 BULK_MAX_FILES（500）文件配额的上限。
 * 与 JOB_TIMEOUT_MS（面向单篇，docling 110s 档）解耦——重试时 import 按内容
 * checkpoint 续传，不会重复 embed 已完成页。
 */
const BULK_IMPORT_TIMEOUT_MS = 900_000;

export interface BulkDocPlan {
  /** 归档内相对路径（已剥前缀） */
  rel: string;
  /** slugifyName(文件名 stem)，与逐篇管道同名文件产出同一 slug */
  slug: string;
  title: string;
}

export interface BulkSkipped {
  rel: string;
  reason: string;
}

export interface BulkCollision {
  slug: string;
  rels: string[];
}

/** tar -tf 输出（每行一个成员名）校验：拒绝绝对路径与 `..` 穿越 */
export function validateArchiveMemberNames(names: string[]): string[] {
  const violations: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name === "") continue;
    if (name.startsWith("/")) violations.push(`${name}: absolute path`);
    const segments = name.split("/");
    if (segments.some((seg) => seg === "..")) violations.push(`${name}: parent traversal`);
  }
  return violations;
}

/** tar -tvf 输出校验：拒绝符号链接（l）与硬链接（h）成员（防写出归档目录外的 tar slip） */
export function validateArchiveMemberTypes(tvfLines: string[]): string[] {
  const violations: string[] = [];
  for (const line of tvfLines) {
    const typeChar = line.charAt(0);
    if (typeChar === "l") violations.push(`${line.slice(6).trim() || line}: symlink member`);
    if (typeChar === "h") violations.push(`${line.slice(6).trim() || line}: hardlink member`);
  }
  return violations;
}

/** 剥离归档内公共前缀：显式 strip 优先；否则自动探测「全部成员共享的唯一顶层目录」 */
export function applyStrip(names: string[], strip?: string): string[] {
  if (names.length === 0) return names;
  if (strip !== undefined && strip !== "") {
    return names.map((n) => (n.startsWith(strip) ? n.slice(strip.length) : n));
  }
  const first = names.map((n) => n.split("/")[0] ?? "");
  const root = first[0]!;
  const canStrip = root !== "" && first.every((seg) => seg === root) && names.every((n) => n.includes("/"));
  if (!canStrip) return names;
  return names.map((n) => n.slice(root.length + 1));
}

/** 规划：md 过滤 + 垃圾剔除 + slug 派生 + 冲突检测（纯函数，不触盘） */
export function planBulkDocs(names: string[]): { docs: BulkDocPlan[]; skipped: BulkSkipped[]; collisions: BulkCollision[] } {
  const docs: BulkDocPlan[] = [];
  const skipped: BulkSkipped[] = [];
  const bySlug = new Map<string, BulkDocPlan[]>();
  for (const rel of names) {
    const segments = rel.split("/");
    if (segments.some((seg) => seg.startsWith(".") || seg === "__MACOSX")) {
      skipped.push({ rel, reason: "hidden/junk" });
      continue;
    }
    if (!/\.md$/i.test(rel)) {
      skipped.push({ rel, reason: "not markdown" });
      continue;
    }
    // slug 规则与逐篇管道一致：title = 展平的完整相对路径 stem（/ → -），
    // 同名 basename 在不同目录下天然错开，冲突只剩真正的归一化撞车
    const title = rel.replace(/\.md$/i, "");
    const slug = slugifyName(title);
    if (slug === "") {
      skipped.push({ rel, reason: "slugifies to empty" });
      continue;
    }
    const doc: BulkDocPlan = { rel, slug, title };
    docs.push(doc);
    const group = bySlug.get(slug) ?? [];
    group.push(doc);
    bySlug.set(slug, group);
  }
  const collisions: BulkCollision[] = [...bySlug.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([slug, group]) => ({ slug, rels: group.map((d) => d.rel) }));
  return { docs, skipped, collisions };
}

function walkRel(dir: string, pre = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isFile()) return [`${pre}${entry.name}`];
    if (entry.isDirectory()) return walkRel(path.join(dir, entry.name), `${pre}${entry.name}/`);
    return [];
  });
}

export interface BulkStageResult {
  entities: Array<{ slug: string; title: string }>;
  totalBytes: number;
}

/**
 * 产出 canonical staging 树：<stage>/<kb>/docs/<slug>.md + <stage>/<kb>/entities/<name>.md。
 * 实体页由服务端从双链目标统一派生（auto_generated 标记），客户端不参与。
 */
export function buildBulkStage(opts: {
  rawDir: string;
  stageDir: string;
  kbId: string;
  docs: BulkDocPlan[];
  maxTotalBytes: number;
  /** stripped rel → 归档内原始路径（前缀剥离只影响 slug 派生；读文件需还原） */
  resolveSrc: (rel: string) => string;
}): BulkStageResult {
  const { rawDir, stageDir, kbId, docs, maxTotalBytes, resolveSrc } = opts;
  const docsOut = path.join(stageDir, kbId, DOC_DIR);
  const entitiesOut = path.join(stageDir, kbId, ENTITY_DIR);
  mkdirSync(docsOut, { recursive: true });
  mkdirSync(entitiesOut, { recursive: true });

  const targets = new Map<string, string>();
  let totalBytes = 0;
  for (const doc of docs) {
    const srcPath = path.join(rawDir, resolveSrc(doc.rel));
    const raw = readFileSync(srcPath, "utf8");
    totalBytes += statSync(srcPath).size;
    if (totalBytes > maxTotalBytes) {
      rmSync(stageDir, { recursive: true, force: true });
      throw new Error(`bulk payload exceeds ${maxTotalBytes} bytes uncompressed`);
    }
    const { targets: docTargets } = extractWikilinkTargets(raw);
    for (const t of docTargets) if (!targets.has(t.slug)) targets.set(t.slug, t.title);
    // 不写 converted_at：md 直通无转换时点语义；缺失该行使同语料 staging 字节稳定，
    // 重复 bulk 触发 import 的 checkpoint 跳过（不重复 embed）
    const md = buildMarkdown(raw, { title: doc.title, kb: kbId, sourceFile: doc.rel });
    writeFileSync(path.join(docsOut, `${doc.slug}.md`), md, "utf8");
  }

  if (targets.size > MAX_ENTITIES_PER_RUN) {
    rmSync(stageDir, { recursive: true, force: true });
    throw new Error(`wikilink targets (${targets.size}) exceed MAX_ENTITIES_PER_RUN (${MAX_ENTITIES_PER_RUN})`);
  }
  const entities: Array<{ slug: string; title: string }> = [];
  for (const [slug, title] of targets) {
    writeFileSync(path.join(entitiesOut, `${slug}.md`), entityStub(title), "utf8");
    entities.push({ slug, title });
  }
  return { entities, totalBytes };
}

/** 解析 `gbrain import` 文本摘要（非 --json 路径，版本间文案稳定字段用宽松正则） */
export function parseImportSummary(text: string): { imported: number; unchanged: number; errors: number; chunks: number } | null {
  const imported = /(\d+) pages imported/.exec(text);
  if (!imported) return null;
  const skipped = /(\d+) pages skipped \((\d+) unchanged, (\d+) errors\)/.exec(text);
  const chunks = /(\d+) chunks created/.exec(text);
  return {
    imported: Number(imported[1]),
    unchanged: skipped ? Number(skipped[2]) : 0,
    errors: skipped ? Number(skipped[3]) : 0,
    chunks: chunks ? Number(chunks[1]) : 0,
  };
}

/** 解析 `gbrain extract links` 摘要 */
export function parseLinkSummary(text: string): { created: number; skipped: number } | null {
  const created = /created (\d+) from (\d+) pages?/.exec(text);
  if (!created) return null;
  const skipped = /Skipped (\d+) candidate/.exec(text);
  return { created: Number(created[1]), skipped: skipped ? Number(skipped[1]) : 0 };
}

/**
 * bulk 任务执行体：staging 已在提交接口完成（sourceRef = stage 目录）。
 * 成功后清理 staging；失败保留（重试时 import 按内容 checkpoint 续传）。
 */
export async function processBulkJob(cfg: Config, job: IngestJob): Promise<IngestOutcome> {
  const stageDir = job.sourceRef;
  const started = Date.now();
  const imp = await runGbrain(cfg, {
    args: ["import", stageDir, "--source-id", job.kbId, "--workers", String(BULK_WORKERS)],
    source: job.kbId,
    timeoutMs: BULK_IMPORT_TIMEOUT_MS,
  });
  const impSummary = parseImportSummary(`${imp.stdout}\n${imp.stderr}`);
  const links = await runGbrain(cfg, {
    args: ["extract", "links", "--source", "db", "--source-id", job.kbId],
    source: job.kbId,
    timeoutMs: BULK_IMPORT_TIMEOUT_MS,
  });
  const linkSummary = parseLinkSummary(`${links.stdout}\n${links.stderr}`);
  const resultSummary = JSON.stringify({ import: impSummary, links: linkSummary, duration_ms: Date.now() - started });
  rmSync(stageDir, { recursive: true, force: true });

  const warnings: string[] = [];
  if (impSummary === null) warnings.push("import summary unparsed");
  else if (impSummary.errors > 0) warnings.push(`import reported ${impSummary.errors} file error(s)`);
  if (linkSummary === null) warnings.push("extract links summary unparsed");
  return {
    status: warnings.length > 0 ? "done_with_warnings" : "done",
    error: warnings.length > 0 ? warnings.join("; ") : undefined,
    resultSummary,
  };
}

/** 解包 + staging 的临时目录都建在 incoming 下（与既有上传暂存同盘，进程崩溃后由 tmpfs 回收） */
export function newBulkTempDir(incomingDir: string, kind: "raw" | "stage"): string {
  return mkdtempSync(path.join(incomingDir, `bulk-${kind}-`));
}

/** 递归收集相对路径（仅常规文件） */
export function listArchiveFiles(rootDir: string): string[] {
  return walkRel(rootDir);
}
