/**
 * 容器 entrypoint 调用：端点三要素（CHAT/EMBEDDING/RERANK_BASE_URL+MODEL+API_KEY）
 * → 引擎槽位 env 派生。rerank 路径形态需真实探测（/rerank vs /reranks），失败时
 * 不派生 rerank（由服务启动自愈重探并给出明确状态）。
 * 输出 `export K='V'` 行（bash eval 安全）；无端点三要素时无输出。
 */
import { readEndpointModelEnv, deriveSlotEnv } from "./model-router";
import { probeEmbedding, probeRerank } from "./endpoint-probe";

const env = process.env as Record<string, string | undefined>;
const explicitKeys = [
  "OPENROUTER_BASE_URL",
  "OPENROUTER_API_KEY",
  "GBRAIN_CHAT_MODEL",
  "LLAMA_SERVER_BASE_URL",
  "LLAMA_SERVER_API_KEY",
  "GBRAIN_EMBEDDING_MODEL",
  "GBRAIN_EMBEDDING_DIMENSIONS",
  "LLAMA_SERVER_RERANKER_BASE_URL",
  "LLAMA_SERVER_RERANKER_API_KEY",
  "GBRAIN_RERANKER_MODEL",
  "DASHSCOPE_API_KEY",
];
const explicit: Record<string, string | undefined> = {};
for (const k of explicitKeys) explicit[k] = env[k];

async function main(): Promise<void> {
  const u = readEndpointModelEnv(env);
  const embeddingEnabled = Boolean(u.embedding.baseUrl && u.embedding.model);
  const embeddingDimsExplicit = Boolean(u.embedding.dims || explicit["GBRAIN_EMBEDDING_DIMENSIONS"]);

  // embedding 维度自动探测：引擎 init 对空维度 schema 不做默认（embed 需确切维度）。
  // 显式维度缺失时对端点发一次真实请求取默认输出维度（引擎不发 dimension 参数 → 恒为端点默认）。
  let embeddingDim: number | undefined;
  if (embeddingEnabled && !embeddingDimsExplicit) {
    try {
      const r = await probeEmbedding(u.embedding.baseUrl, u.embedding.model, u.embedding.apiKey);
      if (r.ok && r.dim) embeddingDim = r.dim;
      else console.error(`[model-router] embedding dim probe failed (${r.error ?? "unknown"}); vector ingest will fail until EMBEDDING_DIMENSIONS is set explicitly`);
    } catch {
      console.error("[model-router] embedding dim probe error; vector ingest will fail until EMBEDDING_DIMENSIONS is set explicitly");
    }
  }

  let rerankPath: "rerank" | "reranks" | undefined;
  if (u.rerank.baseUrl && u.rerank.model) {
    try {
      const r = await probeRerank(u.rerank.baseUrl, u.rerank.model, u.rerank.apiKey);
      if (r.ok && r.path) rerankPath = r.path;
      else console.error(`[model-router] rerank probe failed (${r.error ?? "unknown"}); rerank deferred to service self-heal`);
    } catch {
      console.error("[model-router] rerank probe error; rerank deferred to service self-heal");
    }
  }

  const out = deriveSlotEnv(
    env,
    {
      embedding: embeddingDim ? { ok: true, dim: embeddingDim } : undefined,
      rerank: rerankPath ? { ok: true, path: rerankPath } : undefined,
    },
    explicit,
  );
  if (out.rerankConfigRequired) {
    console.log(`export GBRAIN_RERANKER_CONFIG_REQUIRED='1'`);
  }
  for (const [k, v] of Object.entries(out.derived)) {
    const safe = v.replace(/'/g, "'\\''");
    console.log(`export ${k}='${safe}'`);
  }
}

void main();
