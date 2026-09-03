import type { Config } from "./config";
import { capabilityEnabled, capabilityGaps, capabilityReady, readEndpointModelEnv } from "./model-router";

/**
 * 模型配置状态与预检（端点三要素心智）。
 * 就绪 = 每能力三要素齐（端点+模型+key）；缺口按行列出（用户语言）。
 * 有效性（可达/型号/凭证）由 endpoint-probe 真实探测判定——此处不做名单预检。
 */

export interface ModelConfigState {
  chat: boolean;
  embedding: boolean;
  rerank: boolean;
}

export function modelConfigState(cfg: Config): ModelConfigState {
  const u = readEndpointModelEnv({
    CHAT_BASE_URL: cfg.CHAT_BASE_URL,
    CHAT_MODEL: cfg.CHAT_MODEL,
    CHAT_API_KEY: cfg.CHAT_API_KEY,
    EMBEDDING_BASE_URL: cfg.EMBEDDING_BASE_URL,
    EMBEDDING_MODEL: cfg.EMBEDDING_MODEL,
    EMBEDDING_API_KEY: cfg.EMBEDDING_API_KEY,
    RERANK_BASE_URL: cfg.RERANK_BASE_URL,
    RERANK_MODEL: cfg.RERANK_MODEL,
    RERANK_API_KEY: cfg.RERANK_API_KEY,
  });
  return {
    chat: capabilityReady(u.chat),
    embedding: capabilityReady(u.embedding),
    rerank: capabilityReady(u.rerank),
  };
}

export interface ModelWarning {
  kind: "partial_capability" | "dims_hint";
  message: string;
}

/** 配置预检：只报缺口/提示，不做白名单判定（有效性由探测负责） */
export function validateModelConfig(cfg: Config): ModelWarning[] {
  const warnings: ModelWarning[] = [];
  const u = readEndpointModelEnv({
    CHAT_BASE_URL: cfg.CHAT_BASE_URL,
    CHAT_MODEL: cfg.CHAT_MODEL,
    CHAT_API_KEY: cfg.CHAT_API_KEY,
    EMBEDDING_BASE_URL: cfg.EMBEDDING_BASE_URL,
    EMBEDDING_MODEL: cfg.EMBEDDING_MODEL,
    EMBEDDING_API_KEY: cfg.EMBEDDING_API_KEY,
    RERANK_BASE_URL: cfg.RERANK_BASE_URL,
    RERANK_MODEL: cfg.RERANK_MODEL,
    RERANK_API_KEY: cfg.RERANK_API_KEY,
  });
  for (const [cap, c] of [
    ["chat", u.chat],
    ["embedding", u.embedding],
    ["rerank", u.rerank],
  ] as const) {
    if (c.baseUrl || c.model || c.apiKey) {
      const gaps = capabilityGaps(c, cap.toUpperCase());
      if (gaps.length > 0) {
        warnings.push({
          kind: "partial_capability",
          message: `${cap} 能力配置不完整，缺：${gaps.join(", ")}（三要素齐备才启用）`,
        });
      }
    }
  }
  return warnings;
}
