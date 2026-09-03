import type { ProbeResults } from "./endpoint-probe";

/**
 * 端点三要素派生（model-router）：用户配置 = 每能力三行（BASE_URL + MODEL + API_KEY，
 * 仅 OpenAI 兼容 API）。服务把端点探测结果映射到引擎槽位——用户不接触任何引擎概念。
 *
 * 槽位映射（引擎实证，见 specs/006 research.md）：
 *   chat      → openrouter 槽（OPENROUTER_BASE_URL 可指向任意 OpenAI 兼容端点，chat 无白名单）
 *   embedding → llama-server 槽（无白名单；维度 = 探测默认输出，引擎不发 dimensions 参数）
 *   rerank    → 探测路径形态：/reranks 复数 → dashscope-rerank 槽（config set 装配）；
 *               /rerank 单数 → llama-server-reranker 槽（端点 env）
 *
 * 派生为纯函数（probe 结果注入，可单测）；探测编排在 CLI/API 层。
 */

export interface EndpointModelEnv {
  chat: { baseUrl: string; model: string; apiKey: string };
  embedding: { baseUrl: string; model: string; apiKey: string; dims?: string };
  rerank: { baseUrl: string; model: string; apiKey: string };
}

export function readEndpointModelEnv(env: Record<string, string | undefined>): EndpointModelEnv {
  const pick = (p: "CHAT" | "EMBEDDING" | "RERANK") => ({
    baseUrl: env[`${p}_BASE_URL`] ?? "",
    model: env[`${p}_MODEL`] ?? "",
    apiKey: env[`${p}_API_KEY`] ?? "",
  });
  const c = pick("CHAT");
  const e = pick("EMBEDDING");
  const r = pick("RERANK");
  return {
    chat: { ...c, model: env["CHAT_MODEL"] ?? c.model },
    embedding: { ...e, model: env["EMBEDDING_MODEL"] ?? e.model, dims: env["EMBEDDING_DIMENSIONS"] ?? undefined },
    rerank: { ...r, model: env["RERANK_MODEL"] ?? r.model },
  };
}

export interface DerivedSlotEnv {
  /** 注入进程 env 的派生（export 行来源） */
  derived: Record<string, string>;
  /** 启动自愈 config set 待办（rerank /reranks 槽） */
  rerankConfigRequired: boolean;
  rerankModel?: string;
  rerankBaseUrl?: string;
}

export function capabilityEnabled(c: { baseUrl: string; model: string; apiKey: string }): boolean {
  return Boolean(c.baseUrl && c.model);
}

/** 就绪判定：三要素齐（端点 + 模型 + key） */
export function capabilityReady(c: { baseUrl: string; model: string; apiKey: string }): boolean {
  return Boolean(c.baseUrl && c.model && c.apiKey);
}

export function capabilityGaps(c: { baseUrl: string; model: string; apiKey: string }, label: string): string[] {
  const gaps: string[] = [];
  if (!c.baseUrl) gaps.push(`${label}_BASE_URL`);
  if (!c.model) gaps.push(`${label}_MODEL`);
  if (!c.apiKey) gaps.push(`${label}_API_KEY`);
  return gaps;
}

/**
 * 端点三要素 → 引擎槽位派生。probe 提供探测结果（rerank 路径形态、embedding 维度）。
 * 显式引擎变量（explicit）优先——派生不覆盖。
 */
export function deriveSlotEnv(
  env: Record<string, string | undefined>,
  probe: Partial<ProbeResults> = {},
  explicit: Record<string, string | undefined> = {},
): DerivedSlotEnv {
  const u = readEndpointModelEnv(env);
  const derived: Record<string, string> = {};
  const setIfAbsent = (target: string, value: string | undefined) => {
    if (!value) return;
    if (explicit[target]) return;
    derived[target] = value;
  };

  // ---- chat → openrouter 槽 ----
  if (capabilityEnabled(u.chat)) {
    setIfAbsent("OPENROUTER_BASE_URL", u.chat.baseUrl);
    setIfAbsent("OPENROUTER_API_KEY", u.chat.apiKey);
    setIfAbsent("GBRAIN_CHAT_MODEL", `openrouter:${u.chat.model}`);
  }

  // ---- embedding → llama-server 槽（维度 = 探测默认 或 显式）----
  if (capabilityEnabled(u.embedding)) {
    setIfAbsent("LLAMA_SERVER_BASE_URL", u.embedding.baseUrl);
    setIfAbsent("LLAMA_SERVER_API_KEY", u.embedding.apiKey);
    setIfAbsent("GBRAIN_EMBEDDING_MODEL", `llama-server:${u.embedding.model}`);
    const dims = u.embedding.dims ?? (probe.embedding?.dim !== undefined ? String(probe.embedding.dim) : undefined);
    if (dims) setIfAbsent("GBRAIN_EMBEDDING_DIMENSIONS", dims);
  }

  // ---- rerank → 按探测路径形态选槽 ----
  const out: DerivedSlotEnv = { derived, rerankConfigRequired: false };
  if (capabilityEnabled(u.rerank)) {
    // key 注入独立于形态探测：/reranks 槽（dashscope-rerank recipe）恒需 DASHSCOPE_API_KEY
    setIfAbsent("DASHSCOPE_API_KEY", u.rerank.apiKey);
    if (probe.rerank?.path === "reranks") {
      // dashscope-rerank 槽：config set 装配（启动自愈执行）
      out.rerankConfigRequired = true;
      out.rerankModel = `dashscope-rerank:${u.rerank.model}`;
      out.rerankBaseUrl = u.rerank.baseUrl;
      setIfAbsent("DASHSCOPE_API_KEY", u.rerank.apiKey);
    } else if (probe.rerank?.path === "rerank") {
      // llama-server-reranker 槽（单数路径端点，如 llama.cpp）
      setIfAbsent("LLAMA_SERVER_RERANKER_BASE_URL", u.rerank.baseUrl);
      setIfAbsent("LLAMA_SERVER_RERANKER_API_KEY", u.rerank.apiKey);
      setIfAbsent("GBRAIN_RERANKER_MODEL", `llama-server-reranker:${u.rerank.model}`);
    }
    // 形态未知（探测失败/未探）→ 不派生 rerank：宁可明确"未配置"，不错配通道静默失效
  }

  return out;
}
