import type { Config } from "./config";
import { runGbrainJson } from "./gbrain-cli";

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
  return raw.map((h) => ({
    slug: str(h.slug),
    title: str(h.title, str(h.slug)),
    snippet: str(h.chunk_text, str(h.text, str(h.snippet))).slice(0, 2000),
    score: num(h.score),
    source_id: str(h.source_id) || null,
  }));
}

export interface RetrievalInput {
  query: string;
  mode?: "hybrid" | "keyword";
  topK?: number;
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
  if (input.topK && input.topK > 0) args.push("--limit", String(Math.min(input.topK, 100)));

  const j = await runGbrainJson<RawHit[] | RawQueryOutput>(cfg, {
    args,
    source: kbId,
    timeoutMs: 30_000,
  });

  const arr = Array.isArray(j) ? j : (j.results ?? j.hits ?? []);
  const degraded = !Array.isArray(j) && Array.isArray((j as RawQueryOutput).degraded)
    ? ((j as RawQueryOutput).degraded as unknown[]).map(String)
    : [];
  return { results: normalizeHits(arr), mode, degraded };
}
