import type { Config } from "./config";

/**
 * 模型配置状态与预检（供应商中立配置面的观测/校验，A/B/C）。
 * 不触碰引擎语义：仅按"端点 + 模型 + 维度"的通用形状判定与提示。
 */

export interface ModelConfigState {
  embedding: boolean;
  rerank: boolean;
  chat: boolean;
}

/** 已配置的端点（原生或经 entrypoint 映射后的中立变量） */
function embeddingEndpoint(cfg: Config): string {
  return cfg.LLAMA_SERVER_BASE_URL || cfg.EMBEDDING_BASE_URL;
}

function embeddingModel(cfg: Config): string {
  return cfg.GBRAIN_EMBEDDING_MODEL || cfg.EMBEDDING_MODEL;
}

/** 模型配置是否就绪（模型存在且至少有维度或端点之一可解析） */
export function modelConfigState(cfg: Config): ModelConfigState {
  const embModel = embeddingModel(cfg);
  const embDim = cfg.GBRAIN_EMBEDDING_DIMENSIONS || cfg.EMBEDDING_DIMENSIONS;
  const rerankModel = cfg.GBRAIN_RERANKER_MODEL || cfg.RERANK_MODEL;
  // rerank 就绪按 provider 形态判定：dashscope-rerank 走 DASHSCOPE_API_KEY（专用 recipe，
  // 非 OpenAI 兼容端点别名）；llama-server-reranker/无前缀中立映射走 rerank 端点变量
  const rerankReady =
    rerankModel.length > 0 &&
    (rerankModel.startsWith("dashscope-rerank:")
      ? cfg.DASHSCOPE_API_KEY.length > 0
      : (cfg.LLAMA_SERVER_RERANKER_BASE_URL || cfg.RERANK_BASE_URL).length > 0);
  return {
    embedding: embModel.length > 0 && (embDim.length > 0 || embeddingEndpoint(cfg).length > 0 || cfg.OPENAI_API_KEY.length > 0),
    rerank: rerankReady,
    chat: cfg.GBRAIN_CHAT_MODEL.length > 0,
  };
}

/** 常用模型维度（实证表；未列出的模型需用户显式填维度） */
const KNOWN_DIMS: Record<string, number> = {
  "openai:text-embedding-3-large": 3072,
  "llama-server:qwen3-embedding-4b": 2560,
};

export interface ModelWarning {
  kind: "conflict" | "missing_dims" | "dims_mismatch";
  message: string;
}

/** 模型配置预检（C：只警告不自动改——维度属引擎 schema 级，误写需全量重索引） */
export function validateModelConfig(cfg: Config): ModelWarning[] {
  const warnings: ModelWarning[] = [];
  const conflicts: Array<{ native: string; neutral: string; nativeValue: string; neutralValue: string }> = [
    { native: "LLAMA_SERVER_BASE_URL", neutral: "EMBEDDING_BASE_URL", nativeValue: cfg.LLAMA_SERVER_BASE_URL, neutralValue: cfg.EMBEDDING_BASE_URL },
    { native: "GBRAIN_EMBEDDING_MODEL", neutral: "EMBEDDING_MODEL", nativeValue: cfg.GBRAIN_EMBEDDING_MODEL, neutralValue: cfg.EMBEDDING_MODEL },
    { native: "GBRAIN_EMBEDDING_DIMENSIONS", neutral: "EMBEDDING_DIMENSIONS", nativeValue: cfg.GBRAIN_EMBEDDING_DIMENSIONS, neutralValue: cfg.EMBEDDING_DIMENSIONS },
  ];
  for (const { native, neutral, nativeValue, neutralValue } of conflicts) {
    if (nativeValue && neutralValue && nativeValue !== neutralValue) {
      // 派生等价（entrypoint 映射产物：原生 = "llama-server:" + 中立模型）不算冲突
      if (native === "GBRAIN_EMBEDDING_MODEL" && neutral === "EMBEDDING_MODEL" && nativeValue === `llama-server:${neutralValue}`) continue;
      warnings.push({
        kind: "conflict",
        message: `${native} 与 ${neutral} 同时设置且值不同（${nativeValue} vs ${neutralValue}）；原生变量优先，请移除其一`,
      });
    }
  }

  const model = embeddingModel(cfg);
  const dimRaw = cfg.GBRAIN_EMBEDDING_DIMENSIONS || cfg.EMBEDDING_DIMENSIONS;
  if (model && !dimRaw) {
    warnings.push({
      kind: "missing_dims",
      message: `已配置 embedding 模型 ${model} 但未设维度（GBRAIN_EMBEDDING_DIMENSIONS）；向量检索可能不可用或错配`,
    });
  } else if (model && dimRaw) {
    const known = KNOWN_DIMS[model];
    if (known && Number(dimRaw) !== known) {
      warnings.push({
        kind: "dims_mismatch",
        message: `模型 ${model} 的已知维度为 ${known}，配置为 ${dimRaw}；不匹配将导致向量检索异常`,
      });
    }
  }
  return warnings;
}
