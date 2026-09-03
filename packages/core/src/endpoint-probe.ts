/**
 * 端点真实探测（endpoint-probe）：配置时对 OpenAI 兼容端点发最小请求，
 * 验证 端点可达 / 型号存在 / 凭证有效 / 能力支持，并探测：
 *   - embedding 默认输出维度（引擎不发 dimensions 参数 → 以探测为准）
 *   - rerank 路径形态（/rerank 单数 vs /reranks 复数——各服务不统一）
 * 探测替代"供应商白名单"：真实端点为准，永不过时。
 */

export type ProbeErrorCode =
  | "ENDPOINT_UNREACHABLE"
  | "KEY_REJECTED"
  | "MODEL_NOT_FOUND"
  | "CAPABILITY_UNSUPPORTED"
  | "PROBE_TIMEOUT";

export class ProbeError extends Error {
  constructor(
    public readonly code: ProbeErrorCode,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
  }
}

export interface ProbeResults {
  chat: { ok: boolean; error?: ProbeErrorCode };
  embedding: { ok: boolean; error?: ProbeErrorCode; dim?: number };
  rerank: { ok: boolean; error?: ProbeErrorCode; path?: "rerank" | "reranks" };
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

const PROBE_TIMEOUT_MS = 10_000;

async function req(fetchImpl: FetchImpl, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (e) {
    throw new ProbeError("ENDPOINT_UNREACHABLE", `endpoint unreachable: ${(e as Error).message.slice(0, 120)}`);
  }
}

function classify(res: Response, kind: string): void {
  if (res.status === 401 || res.status === 403) {
    throw new ProbeError("KEY_REJECTED", `${kind}: credential rejected (HTTP ${res.status})`);
  }
}

function base(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * chat 探测：GET {base}/models → 200 + 模型存在；4xx 分类。
 */
export async function probeChat(
  baseUrl: string,
  model: string,
  apiKey: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ ok: boolean; error?: ProbeErrorCode }> {
  try {
    const res = await req(fetchImpl, `${base(baseUrl)}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    classify(res, "chat");
    if (res.status !== 200) {
      throw new ProbeError("ENDPOINT_UNREACHABLE", `chat: GET /models → HTTP ${res.status}`);
    }
    const j = (await res.json()) as { data?: Array<{ id: string }> };
    const ids = j.data?.map((m) => m.id) ?? [];
    if (ids.length > 0 && !ids.includes(model)) {
      const hints = ids.filter((id) => id.toLowerCase().includes(model.toLowerCase())).slice(0, 3);
      throw new ProbeError(
        "MODEL_NOT_FOUND",
        `model "${model}" not in endpoint catalog`,
        hints.length ? `did you mean: ${hints.join(", ")}?` : undefined,
      );
    }
    return { ok: true };
  } catch (e) {
    if (e instanceof ProbeError) return { ok: false, error: e.code };
    return { ok: false, error: "ENDPOINT_UNREACHABLE" };
  }
}

/**
 * embedding 探测：POST {base}/embeddings {model,input:"ping"} → 200 + 向量长度（默认输出维度）。
 */
export async function probeEmbedding(
  baseUrl: string,
  model: string,
  apiKey: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ ok: boolean; error?: ProbeErrorCode; dim?: number }> {
  try {
    const res = await req(fetchImpl, `${base(baseUrl)}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: "ping", encoding_format: "float" }),
    });
    classify(res, "embedding");
    if (res.status !== 200) {
      const body = await res.text().catch(() => "");
      throw new ProbeError(
        "MODEL_NOT_FOUND",
        `embedding: POST /embeddings → HTTP ${res.status}`,
        body.slice(0, 200),
      );
    }
    const j = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const dim = j.data?.[0]?.embedding?.length;
    if (!dim) throw new ProbeError("CAPABILITY_UNSUPPORTED", "embedding response missing vector");
    return { ok: true, dim };
  } catch (e) {
    if (e instanceof ProbeError) return { ok: false, error: e.code };
    return { ok: false, error: "ENDPOINT_UNREACHABLE" };
  }
}

/**
 * rerank 路径探测：先试 {base}/rerank（单数，llama.cpp 风格），404 再试 /reranks（复数）。
 * 识别路径形态并验证模型。
 */
export async function probeRerank(
  baseUrl: string,
  model: string,
  apiKey: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ ok: boolean; error?: ProbeErrorCode; path?: "rerank" | "reranks" }> {
  const body = { model, query: "ping", documents: ["pong"] };
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  // 网络间歇性（socket 中断等）：失败退避重试（0/400/1000ms，共 3 轮），覆盖抖动窗口
  const delays = [0, 400, 1000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, delays[attempt]));
    let saw404 = false;
    let networkFail = false;
    for (const path of ["rerank", "reranks"] as const) {
      try {
        const res = await req(fetchImpl, `${base(baseUrl)}/${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        classify(res, "rerank");
        if (res.status === 200) return { ok: true, path };
        if (res.status === 404) {
          saw404 = true;
          continue; // 试另一形态
        }
        const text = await res.text().catch(() => "");
        return { ok: false, error: "MODEL_NOT_FOUND", path: undefined };
      } catch (e) {
        if (e instanceof ProbeError && e.code === "ENDPOINT_UNREACHABLE") {
          networkFail = true;
          break; // 网络类失败：退避后整体重试
        }
        return { ok: false, error: e instanceof ProbeError ? e.code : "ENDPOINT_UNREACHABLE", path: undefined };
      }
    }
    if (!networkFail) {
      return saw404 ? { ok: false, error: "CAPABILITY_UNSUPPORTED", path: undefined } : { ok: false, error: "ENDPOINT_UNREACHABLE", path: undefined };
    }
  }
  return { ok: false, error: "ENDPOINT_UNREACHABLE", path: undefined };
}

/** 三能力一体探测（配置/启动时编排用） */
export async function probeAll(
  env: {
    chat?: { baseUrl: string; model: string; apiKey: string };
    embedding?: { baseUrl: string; model: string; apiKey: string };
    rerank?: { baseUrl: string; model: string; apiKey: string };
  },
  fetchImpl: FetchImpl = fetch,
): Promise<ProbeResults> {
  const [chat, embedding, rerank] = await Promise.all([
    env.chat?.baseUrl && env.chat?.model
      ? probeChat(env.chat.baseUrl, env.chat.model, env.chat.apiKey, fetchImpl)
      : Promise.resolve({ ok: false, error: undefined as ProbeErrorCode | undefined }),
    env.embedding?.baseUrl && env.embedding?.model
      ? probeEmbedding(env.embedding.baseUrl, env.embedding.model, env.embedding.apiKey, fetchImpl)
      : Promise.resolve({ ok: false, error: undefined as ProbeErrorCode | undefined }),
    env.rerank?.baseUrl && env.rerank?.model
      ? probeRerank(env.rerank.baseUrl, env.rerank.model, env.rerank.apiKey, fetchImpl)
      : Promise.resolve({ ok: false, error: undefined as ProbeErrorCode | undefined }),
  ]);
  return { chat, embedding, rerank };
}
