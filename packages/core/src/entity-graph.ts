/**
 * 008 实体图层：文档双链 → 实体页 + 图谱边（详见 specs/008-entity-graph-layer/）。
 *
 * 引擎事实（v0.47.6.0，实证见 research.md）：
 * - gbrain 只有"页"一种对象，`links` 两端硬绑定页 id ⇒ 实体必须是页
 * - 双链解析要求**目标页存在**，否则被 `skipped_missing_target` 丢弃
 * - 实体页放 `<kb>/entities/`；裸双链按 basename 解析需引擎开启
 *   `link_resolution.global_basename`（默认关，关时 0 边）
 * - `put` 的 auto_link 后钩子会自动建边 ⇒ **必须先建实体页，再 put 文档**
 * - `import` 不落盘（无 write-through）⇒ 实体页不进备份；重导文档即可重建
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Config } from "./config";
import { runGbrain, runGbrainJson, type CliInvocation, type CliResult } from "./gbrain-cli";

/** 文档页类型：内置声明类型（`gbrain-base-v2`），免疫 pack catch-all 收敛 */
export const DOC_TYPE = "note";
/** 实体页类型：内置声明类型，同理免疫收敛 */
export const ENTITY_TYPE = "concept";
/** 文档分区（slug 第二段，与磁盘目录一致） */
export const DOC_DIR = "docs";
/** 实体分区（slug 第二段） */
export const ENTITY_DIR = "entities";

/** 来源标记：只有带此标记的实体页参与回收（与用户/外部写入的页区分） */
export const ENTITY_MARKER_KEY = "auto_generated";
export const ENTITY_MARKER_VALUE = "wikilink-stub";

/** 引擎配置键：裸双链按 basename 解析（实体页在子目录时必需） */
export const GLOBAL_BASENAME_KEY = "link_resolution.global_basename";

/** 单次导入最多创建的实体页（防御异常语料） */
export const MAX_ENTITIES_PER_RUN = 2000;
/** 单次回收最多校验/删除的实体页（每页一次 get 校验标记） */
export const MAX_RECLAIM_PER_RUN = 50;

export type CliExec = (inv: CliInvocation) => Promise<CliResult>;

export interface EntityTarget {
  /** 规范化后的 slug 尾段 */
  slug: string;
  /** 原始双链文本（作为页标题，保留大小写） */
  title: string;
}

export function entitySlug(kbId: string, name: string): string {
  return `${kbId}/${ENTITY_DIR}/${name}`;
}

export function isEntitySlug(kbId: string, slug: string): boolean {
  return slug.startsWith(`${kbId}/${ENTITY_DIR}/`);
}

export function isDocSlug(kbId: string, slug: string): boolean {
  return slug.startsWith(`${kbId}/${DOC_DIR}/`);
}

// ─── 引擎算法镜像（纯函数） ─────────────────────────────────────

/**
 * 镜像引擎 `slugifySegment`（src/core/sync.ts:627）——逐字符等价。
 * 不一致则双链解析不中（引擎的 basename 索引按此算法建键）。
 */
const SEGMENT_KEEP_RE = /[^\p{Ll}\p{Lm}\p{Lo}\p{M}\p{N}.\s_-]/gu;

export function slugifyEntityName(raw: string): string {
  return raw
    .replace(/\.mdx?$/i, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u0591-\u05c7]/g, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(SEGMENT_KEEP_RE, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** 镜像引擎 `stripCodeBlocks`（src/core/markdown-code.ts）：代码块内双链不算 */
export function stripCodeBlocks(content: string): string {
  let out = "";
  let i = 0;
  while (i < content.length) {
    if (content.startsWith("```", i)) {
      const end = content.indexOf("```", i + 3);
      if (end === -1) {
        out += " ".repeat(content.length - i);
        break;
      }
      out += " ".repeat(end + 3 - i);
      i = end + 3;
      continue;
    }
    if (content[i] === "`") {
      const end = content.indexOf("`", i + 1);
      if (end === -1 || content.slice(i + 1, end).includes("\n")) {
        out += content[i];
        i++;
        continue;
      }
      out += " ".repeat(end + 1 - i);
      i = end + 1;
      continue;
    }
    out += content[i];
    i++;
  }
  return out;
}

/** 镜像引擎 `WIKILINK_GENERIC_RE`（src/core/link-extraction.ts）：`[[目标|别名]]` 取目标 */
const WIKILINK_RE = /\[\[([^|\]#\n[]+?)(?:#[^|\]]*?)?(?:\|[^\]]+?)?\]\]/g;

/**
 * 扫描正文双链目标。跳过代码块；跳过限定语法（含 `:` 的 `[[source:slug]]`）
 * 与目录形态（含 `/`）——后两者由引擎按各自规则解析，本服务不为它们建扁平实体页。
 */
export function extractWikilinkTargets(md: string): { targets: EntityTarget[]; skipped: number } {
  const body = stripCodeBlocks(md);
  const seen = new Map<string, string>();
  let skipped = 0;
  for (const m of body.matchAll(WIKILINK_RE)) {
    const raw = (m[1] ?? "").trim();
    if (!raw || raw.includes(":") || raw.includes("/")) {
      skipped++;
      continue;
    }
    const slug = slugifyEntityName(raw);
    if (!slug) {
      skipped++;
      continue;
    }
    if (!seen.has(slug)) seen.set(slug, raw);
  }
  return { targets: [...seen].map(([slug, title]) => ({ slug, title })), skipped };
}

/** 纯决策：目标中尚无对应实体页的部分（已存在页一律不动，含用户自建页） */
export function missingEntityTargets(
  kbId: string,
  targets: EntityTarget[],
  existingSlugs: ReadonlySet<string>,
): EntityTarget[] {
  return targets
    .filter((t) => !existingSlugs.has(entitySlug(kbId, t.slug)))
    .slice(0, MAX_ENTITIES_PER_RUN);
}

/**
 * 纯决策：从孤儿列表中选出可回收的候选。
 *
 * 护栏：① 必须在 `entities/` 分区 ② 若这些候选里出现了"本次文档刚引用的实体"，
 * 说明该文档的建图未生效 ⇒ 放弃回收（`aborted`），防误删全库卡片。
 */
export function selectReclaimCandidates(
  kbId: string,
  orphans: readonly string[],
  referencedByCurrentDoc?: ReadonlySet<string>,
): { candidates: string[]; aborted: string | null } {
  const candidates = orphans.filter((s) => s && isEntitySlug(kbId, s));
  if (candidates.length === 0) return { candidates: [], aborted: null };
  if (referencedByCurrentDoc && candidates.some((s) => referencedByCurrentDoc.has(s))) {
    return { candidates, aborted: "graph_incomplete" };
  }
  return { candidates, aborted: null };
}

/** 引擎回显的 frontmatter 是否带来源标记（正则容忍引号/空格） */
export function hasEntityMarkerIn(content: string): boolean {
  const end = content.indexOf("\n---", 3);
  const fm = end === -1 ? content.slice(0, 600) : content.slice(0, end);
  return new RegExp(`^${ENTITY_MARKER_KEY}\\s*:\\s*["']?${ENTITY_MARKER_VALUE}`, "m").test(fm);
}

function entityStub(title: string): string {
  return [
    "---",
    `title: ${JSON.stringify(title)}`,
    `type: ${ENTITY_TYPE}`,
    `${ENTITY_MARKER_KEY}: ${ENTITY_MARKER_VALUE}`,
    "---",
    "",
    `# ${title}`,
    "",
    "Entity node auto-created from a document wikilink; used for graph linking.",
    "",
  ].join("\n");
}

// ─── 引擎调用（可注入 exec 以便单测） ───────────────────────────

export interface EnsureEntityResult {
  created: string[];
  existing: number;
}

export interface ExtractLinksResult {
  linksCreated: number;
  skippedMissing: number;
  skippedCrossSource: number;
  pagesProcessed: number;
}

export interface ReconcileResult {
  /** `entities/` 分区中"零存活入边"的候选数 */
  candidates: number;
  reclaimed: string[];
  /** 非空表示放弃回收（护栏触发） */
  aborted: string | null;
}

export class EntityGraphService {
  private readonly exec: CliExec;

  constructor(
    private readonly cfg: Config,
    deps?: { exec?: CliExec },
  ) {
    this.exec = deps?.exec ?? ((inv) => runGbrain(cfg, inv));
  }

  /** 追加 --json 并解析（经注入的 exec，保证可测） */
  private async execJson<T>(inv: CliInvocation): Promise<T> {
    const r = await this.exec({ ...inv, args: [...inv.args, "--json"] });
    return JSON.parse(r.stdout) as T;
  }

  /** 全部页 slug（1 次 list；存在性判定用，不逐页 get） */
  async listKbSlugs(kbId: string): Promise<Set<string>> {
    const r = await this.exec({ args: ["list", "--limit", "10000"], source: kbId, timeoutMs: 60_000 });
    const out = new Set<string>();
    for (const line of r.stdout.split("\n")) {
      const slug = line.split("\t")[0]?.trim();
      if (slug) out.add(slug);
    }
    return out;
  }

  /** 为缺失的双链目标建实体页（`import --no-embed`：批量、零嵌入、不落盘） */
  async ensureEntityPages(kbId: string, targets: EntityTarget[]): Promise<EnsureEntityResult> {
    if (targets.length === 0) return { created: [], existing: 0 };
    const existingSlugs = await this.listKbSlugs(kbId);
    const missing = missingEntityTargets(kbId, targets, existingSlugs);
    if (missing.length === 0) return { created: [], existing: targets.length };

    const root = mkdtempSync(path.join(tmpdir(), "gbrain-entities-"));
    try {
      const dir = path.join(root, kbId, ENTITY_DIR);
      mkdirSync(dir, { recursive: true });
      for (const t of missing) writeFileSync(path.join(dir, `${t.slug}.md`), entityStub(t.title), "utf8");
      await this.exec({ args: ["import", root, "--no-embed"], source: kbId, timeoutMs: this.cfg.JOB_TIMEOUT_MS });
      return { created: missing.map((t) => entitySlug(kbId, t.slug)), existing: targets.length - missing.length };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  /** 显式提取（幂等）：`--source db` 必须——实体页不在磁盘，fs 模式扫不到 */
  async runLinkExtraction(kbId: string): Promise<ExtractLinksResult> {
    const j = await this.execJson<Record<string, unknown>>({
      args: ["extract", "links", "--source", "db", "--source-id", kbId],
      source: kbId,
      timeoutMs: this.cfg.JOB_TIMEOUT_MS,
    });
    return {
      linksCreated: Number(j.links_created ?? 0),
      skippedMissing: Number(j.skipped_missing_target ?? 0),
      skippedCrossSource: Number(j.skipped_cross_source ?? 0),
      pagesProcessed: Number(j.pages_processed ?? 0),
    };
  }

  /** 读页 frontmatter 标记（读不到即 fail-closed 返回 false，绝不误删） */
  async hasEntityMarker(kbId: string, slug: string): Promise<boolean> {
    try {
      const r = await this.exec({ args: ["get", slug, "--include-content"], source: kbId, timeoutMs: 30_000 });
      return hasEntityMarkerIn(r.stdout);
    } catch {
      return false;
    }
  }

  /**
   * 回收"不再被任何存活页引用"的自动创建实体页。
   * 三重护栏：① `entities/` 分区 ② frontmatter 来源标记 ③ 引擎报告零存活入边
   * （`orphans --mode inbound`——默认的 islanded 模式会漏掉"有出边但无入边"的页）。
   */
  async reconcileEntityStubs(
    kbId: string,
    opts: { referencedByCurrentDoc?: ReadonlySet<string> } = {},
  ): Promise<ReconcileResult> {
    const j = await this.execJson<{ orphans?: Array<{ slug?: unknown }> }>({
      args: ["orphans", "--mode", "inbound", "--source", kbId],
      source: kbId,
      timeoutMs: 60_000,
    });
    const orphans = (j.orphans ?? []).map((o) => String(o.slug ?? ""));
    const { candidates, aborted } = selectReclaimCandidates(kbId, orphans, opts.referencedByCurrentDoc);
    if (aborted || candidates.length === 0) return { candidates: candidates.length, reclaimed: [], aborted };

    const reclaimed: string[] = [];
    for (const slug of candidates.slice(0, MAX_RECLAIM_PER_RUN)) {
      if (!(await this.hasEntityMarker(kbId, slug))) continue;
      try {
        await this.exec({ args: ["delete", slug], source: kbId, timeoutMs: 30_000 });
        reclaimed.push(slug);
      } catch {
        /* best-effort：单页失败不影响其余 */
      }
    }
    return { candidates: candidates.length, reclaimed, aborted: null };
  }

  /**
   * 文档删除后的回收：先重跑提取（使图与"删除后"的事实一致），再回收孤儿。
   * 提取失败即抛出——否则"提取坏了"会让全库卡片看起来都无引用而被误删。
   */
  async reclaimAfterDocDelete(kbId: string): Promise<ReconcileResult> {
    await this.runLinkExtraction(kbId);
    return this.reconcileEntityStubs(kbId);
  }

  /** 建库/启动时确保引擎开启裸双链 basename 解析（幂等） */
  async ensureGlobalBasename(): Promise<void> {
    await this.exec({ args: ["config", "set", GLOBAL_BASENAME_KEY, "true"], timeoutMs: 30_000 });
  }
}
