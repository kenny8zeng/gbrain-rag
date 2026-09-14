import type { Config } from "./config";
import { runGbrainJson } from "./gbrain-cli";
import { DOC_TYPE, isDocSlug } from "./entity-graph";
import type { GraphExpansionOptions, GraphHit } from "./retrieval-graph";

export interface RetrievalHit {
  slug: string;
  title: string;
  snippet: string;
  score: number;
  source_id: string | null;
}

export interface RetrievalResponse {
  results: RetrievalHit[];
  mode: "hybrid" | "keyword";
  degraded: string[];
  /** 图谱增强检索发现的相关文档（仅当请求带 `graph` 参数时出现） */
  graph_results?: GraphHit[];
}

type RawHit = Record<string, unknown>;

interface RawQueryOutput {
  // gbrain --json 输出形如数组或 {results|hits: [...]}，防御性兼容
  results?: RawHit[];
  hits?: RawHit[];
  degraded?: unknown;
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function normalizeHits(raw: RawHit[]): RetrievalHit[] {
  const hits = raw.map((h) => ({
    slug: str(h.slug),
    title: str(h.title, str(h.slug)),
    snippet: str(h.chunk_text, str(h.text, str(h.snippet))).slice(0, 2000),
    score: num(h.score),
    source_id: str(h.source_id) || null,
  }));
  // 按 slug 去重（保留最高分）：hybrid 双臂（keyword+vector）可能各自返回同页，重复结果干扰消费方
  const seen = new Map<string, RetrievalHit>();
  for (const h of hits) {
    const prev = seen.get(h.slug);
    if (!prev || h.score > prev.score) seen.set(h.slug, h);
  }
  return [...seen.values()];
}

export interface RetrievalInput {
  query: string;
  mode?: "hybrid" | "keyword";
  topK?: number;
  /** 图谱增强检索参数；缺省 = 纯向量/关键词 */
  graph?: GraphExpansionOptions;
}

/**
 * 文档面过滤（008）：结构兜底——只保留 `<kb>/docs/` 分区的命中。
 * 类型过滤负责召回质量，这里负责**正确性**（不依赖类型是否正确/是否漂移）。
 * 同时按 top_k 截断（P10：引擎的 adaptive/多查询会超量返回）。
 */
export function filterDocumentHits(kbId: string, hits: RetrievalHit[], topK?: number): RetrievalHit[] {
  const docs = hits.filter((h) => isDocSlug(kbId, h.slug));
  return topK && topK > 0 ? docs.slice(0, topK) : docs;
}

/**
 * 实体页与文档页竞争同一批结果位次 ⇒ 过取补偿（引擎上限 100）。
 * 无 topK 时不过取（调用方只要默认档位）。
 */
export function overFetchLimit(topK: number | undefined, factor = 4): number | null {
  if (!topK || topK <= 0) return null;
  return Math.min(Math.max(topK * factor, topK), 100);
}

/**
 * T049 降级封装：优先常驻 serve 通道，故障回退 CLI spawn（CHK021）。
 * 日志事件 retrieval_fallback 供运维观测降级频率。
 */
export async function retrieveWithFallback(
  cfg: Config,
  serveRetriever: (kbId: string, input: RetrievalInput) => Promise<RetrievalResponse>,
  kbId: string,
  input: RetrievalInput,
): Promise<RetrievalResponse> {
  try {
    return await serveRetriever(kbId, input);
  } catch (e) {
    console.log(JSON.stringify({ evt: "retrieval_fallback", kb: kbId, error: (e as Error).message.slice(0, 200) }));
    return retrieve(cfg, kbId, input);
  }
}

export async function retrieve(
  cfg: Config,
  kbId: string,
  input: RetrievalInput,
): Promise<RetrievalResponse> {
  const mode = input.mode ?? "hybrid";
  const args =
    mode === "keyword"
      ? ["search", input.query]
      : ["query", input.query];
  // 文档面：类型过滤（召回质量）+ 过取（补偿与实体页的位次竞争）
  args.push("--types", DOC_TYPE);
  const fetchLimit = overFetchLimit(input.topK);
  if (fetchLimit !== null) args.push("--limit", String(fetchLimit));

  const j = await runGbrainJson<RawHit[] | RawQueryOutput>(cfg, {
    args,
    source: kbId,
    timeoutMs: 30_000,
  });

  const arr = Array.isArray(j) ? j : (j.results ?? j.hits ?? []);
  const degraded = !Array.isArray(j) && Array.isArray((j as RawQueryOutput).degraded)
    ? ((j as RawQueryOutput).degraded as unknown[]).map(String)
    : [];
  const hits = filterDocumentHits(kbId, normalizeHits(arr).map((h) => ({ ...h, source_id: kbId })), input.topK);
  return { results: hits, mode, degraded };
}
