import { mkdirSync, existsSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Config } from "../config";
import { docsDir, incomingDir } from "../config";
import { runGbrain, pageExists } from "../gbrain-cli";
import { DOC_TYPE, EntityGraphService, entitySlug as entitySlugPath, extractWikilinkTargets } from "../entity-graph";
import { resolveParserFor } from "./resolver";
import { convertWithFallback, parserLogFor } from "./fallback";

export interface IngestJob {
  id: string;
  kbId: string;
  type: "file" | "url" | "md" | "bulk";
  sourceRef: string;
  title: string | null;
}

export interface IngestOutcome {
  status: "done" | "done_with_warnings" | "failed";
  outcome?: "created" | "updated";
  docSlug?: string;
  error?: string;
  /** 解析路径记录（primary 或回退链，md 直传为空） */
  parserLog?: string;
  /** 建图阶段异常（不阻断文档导入成功，仅记录） */
  graphLog?: string;
  /** bulk：导入摘要 JSON（import + extract links 计数），写入 rag_jobs.result_summary */
  resultSummary?: string;
}

/**
 * slug 尾段的 UTF-8 字节预算。文件系统单个文件名上限 255 字节，且 slug 会被
 * write-through 落成 `${slug}.md`——故按**字节**而非字符控制（CJK 每字符 3 字节，
 * 按字符放宽会在中文名上撞 255 上限）。留出 `.md` 与目录余量。
 */
export const SLUG_MAX_BYTES = 200;
const SLUG_HASH_LEN = 8;

const utf8Len = (s: string): number => Buffer.byteLength(s, "utf8");

/** 截断后用于消歧的短哈希：取**完整规范化名**的 sha256 前 8 hex */
function slugDisambiguator(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex").slice(0, SLUG_HASH_LEN);
}

/**
 * 文件名 → slug 尾段。
 *
 * **超长名必须抗撞车**：直接截断会让「前缀相同、仅尾部不同」的两个文件映射到
 * **同一个 slug** → 后者静默覆盖前者（文档丢失，实测可复现）。故超长时截断并附
 * **完整名的短哈希**：不同长名得到不同 slug，且同名重复导入仍幂等（哈希稳定）。
 */
export function slugifyName(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length === 0) return "doc";
  if (utf8Len(s) <= SLUG_MAX_BYTES) return s;

  // 按字符累积到字节预算内（避免截断多字节字符），再拼哈希
  const budget = SLUG_MAX_BYTES - SLUG_HASH_LEN - 1; // 留 "-<hash>"
  let head = "";
  let used = 0;
  for (const ch of s) {
    const b = utf8Len(ch);
    if (used + b > budget) break;
    head += ch;
    used += b;
  }
  head = head.replace(/-+$/g, "");
  return `${head}-${slugDisambiguator(s)}`;
}

export function deriveSlug(kbId: string, baseName: string): string {
  return `${kbId}/docs/${slugifyName(baseName)}`;
}

/** 剥离 body 已有的 YAML frontmatter（若有），统一替换为本服务的元数据块 */
export function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end === -1) return md;
  return md.slice(md.indexOf("\n", end + 1) + 1).replace(/^\n+/, "");
}

export function buildMarkdown(
  md: string,
  meta: { title: string; kb: string; sourceFile?: string; sourceUrl?: string; convertedAt?: string },
): string {
  const body = stripFrontmatter(md);
  const lines = [
    "---",
    `title: ${JSON.stringify(meta.title)}`,
    // 008：显式钉定文档类型（不依赖引擎按 slug 路径推断——本服务 slug 为
    // <kb>/docs/<name>，`docs/` 未在任何 pack 中声明 → 推断会落 concept）
    `type: ${DOC_TYPE}`,
    `kb: ${meta.kb}`,
    ...(meta.sourceFile ? [`source_file: ${JSON.stringify(meta.sourceFile)}`] : []),
    ...(meta.sourceUrl ? [`source_url: ${JSON.stringify(meta.sourceUrl)}`] : []),
    ...(meta.convertedAt ? [`converted_at: ${meta.convertedAt}`] : []),
    "---",
    "",
    body.trimStart(),
  ];
  return lines.join("\n");
}

/** 执行单个摄取任务：建图预置 → 转换 → 规范化 → put(upsert, 连带 embed + auto_link) → 提取兜底 → 回收。抛错即任务失败（worker 负责重试） */
export async function processIngestJob(
  cfg: Config,
  job: IngestJob,
  deps?: { entityGraph?: EntityGraphService },
): Promise<IngestOutcome> {
  let md: string;
  let baseName: string;
  let sourceFile: string | undefined;
  let sourceUrl: string | undefined;
  let parserLog: string | undefined;
  let graphLog: string | undefined;

  if (job.type === "md") {
    const rawPath = path.join(incomingDir(cfg), job.sourceRef);
    const raw = readFileSync(rawPath, "utf8");
    md = raw;
    baseName = job.title ?? job.sourceRef.replace(/\.md$/i, "");
    sourceFile = job.sourceRef;
  } else if (job.type === "url") {
    const r = await resolveParserFor(cfg).url!.convertUrl(job.sourceRef);
    md = r.md;
    baseName = (job.title ?? slugifyName(new URL(job.sourceRef).pathname.split("/").filter(Boolean).pop() ?? "")) || new URL(job.sourceRef).hostname;
    sourceUrl = job.sourceRef;
  } else {
    const rawPath = path.join(incomingDir(cfg), job.sourceRef);
    if (!existsSync(rawPath)) throw new Error(`incoming file missing: ${job.sourceRef}`);
    const bytes = readFileSync(rawPath);
    const conv = await convertWithFallback(resolveParserFor(cfg), new Uint8Array(bytes), path.basename(rawPath));
    md = conv.md;
    parserLog = parserLogFor(conv);
    baseName = job.title ?? path.basename(rawPath);
    sourceFile = job.sourceRef;
  }

  const title = baseName.trim() || "untitled";
  const slug = deriveSlug(job.kbId, title);
  const markdown = buildMarkdown(md, {
    title,
    kb: job.kbId,
    sourceFile,
    sourceUrl,
    convertedAt: new Date().toISOString(),
  });

  // ─── 008 建图层（顺序关键，见 specs/008-entity-graph-layer/plan.md）─────
  // 引擎的双链解析要求目标页存在，且 put 的 auto_link 后钩子在写入时即建边
  // ⇒ 必须**先建实体页、再 put 文档**。
  // 全过程 best-effort：建图失败不回滚文档（文档导入成功与否只取决于文档本身）。
  const graph = deps?.entityGraph ?? new EntityGraphService(cfg);
  const wikilinks = extractWikilinkTargets(md);
  const referenced = new Set(wikilinks.targets.map((t) => entitySlugPath(job.kbId, t.slug)));
  try {
    if (wikilinks.targets.length > 0) await graph.ensureEntityPages(job.kbId, wikilinks.targets);
  } catch (e) {
    graphLog = `entity_pages: ${(e as Error).message.slice(0, 200)}`;
  }

  const existed = await pageExists(cfg, job.kbId, slug);

  let status: IngestOutcome["status"] = "done";
  let error: string | undefined;
  try {
    await runGbrain(cfg, {
      args: ["put", slug, "--content", markdown],
      source: job.kbId,
      timeoutMs: cfg.JOB_TIMEOUT_MS,
    });
  } catch (e) {
    const msg = (e as Error).message;
    // 存储层错误（repo/磁盘/写盘失败）= 页面未写入的真失败——绝不降级 warning
    if (/repo_not_found|storage_error|could not be written|no such file|ENOENT/i.test(msg)) {
      throw e;
    }
    // 其余 put 失败：gbrain put 会连带 embed——embedding 端点不可达时 CLI 非零退出但页面可能已写入。
    // 复核存在性：已写入则降级 done_with_warnings（关键词检索可用），否则真失败。
    if (await pageExists(cfg, job.kbId, slug)) {
      return {
        status: "done_with_warnings",
        outcome: existed ? "updated" : "created",
        docSlug: slug,
        error: `put partially failed (embed/unreachable?): ${msg.slice(0, 300)}`,
        parserLog,
        graphLog,
      };
    }
    throw e;
  }

  // 注：不另跑显式 embed——gbrain put 已连带 embed（source 由 put 上下文正确解析）。
  // 引擎 embed 命令忽略 GBRAIN_SOURCE env 且无公开 --source（帮助未列），显式调用恒以
  // source=default 失败并误报 done_with_warnings；put 连带 embed 失败时上方 pageExists
  // 复核分支已降级处理（页面写入但未索引 → 关键词可检索）。

  // ─── 008 建图收尾：显式提取（幂等兜底）+ 孤儿回收 ─────────────────────
  // put 的 auto_link 已建边；显式提取覆盖 auto_link 被关闭/首次失败的情形。
  // 回收必须**在提取成功之后**——否则提取异常会让全库卡片看起来都无引用而被误删；
  // 且 referencedByCurrentDoc 护栏：本次文档引用的实体若成为孤儿，说明该文档建图
  // 未生效 ⇒ 整体放弃回收。
  if (wikilinks.targets.length > 0) {
    try {
      const rec = await graph.settleGraph(job.kbId, { referencedByCurrentDoc: referenced });
      if (rec.aborted) {
        console.log(JSON.stringify({ evt: "entity_reclaim_aborted", kb: job.kbId, reason: rec.aborted, candidates: rec.candidates }));
      }
    } catch (e) {
      graphLog = graphLog
        ? `${graphLog}; graph_finish: ${(e as Error).message.slice(0, 200)}`
        : `graph_finish: ${(e as Error).message.slice(0, 200)}`;
    }
  }

  // 归档原始文件（md/url 类型仅在 md 有暂存文件时归档）
  if (job.type === "file") {
    const src = path.join(incomingDir(cfg), job.sourceRef);
    const destDir = docsDir(cfg, job.kbId);
    mkdirSync(destDir, { recursive: true });
    renameSync(src, path.join(destDir, `${slugifyName(title)}${path.extname(job.sourceRef) || ".bin"}`));
  } else if (job.type === "md") {
    const src = path.join(incomingDir(cfg), job.sourceRef);
    const destDir = docsDir(cfg, job.kbId);
    mkdirSync(destDir, { recursive: true });
    renameSync(src, path.join(destDir, `${slugifyName(title)}.md`));
  }

  return { status, outcome: existed ? "updated" : "created", docSlug: slug, error, parserLog, graphLog };
}
