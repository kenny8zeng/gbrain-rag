import { describe, expect, test } from "bun:test";
import { deriveSlotEnv, readEndpointModelEnv, capabilityGaps } from "../../packages/core/src/model-router";

function env(over: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...over };
}

const FULL = {
  CHAT_BASE_URL: "https://api.deepseek.com/v1",
  CHAT_MODEL: "deepseek-v4-flash",
  CHAT_API_KEY: "sk-chat",
  EMBEDDING_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  EMBEDDING_MODEL: "qwen3.7-text-embedding",
  EMBEDDING_API_KEY: "sk-emb",
  RERANK_BASE_URL: "https://dashscope.aliyuncs.com/compatible-api/v1",
  RERANK_MODEL: "qwen3-rerank",
  RERANK_API_KEY: "sk-rer",
};

describe("readEndpointModelEnv / capabilityGaps", () => {
  test("三要素读取与缺口（用户语言：缺哪行）", () => {
    const u = readEndpointModelEnv(env({ CHAT_MODEL: "m" }));
    expect(u.chat.model).toBe("m");
    expect(capabilityGaps(u.chat, "CHAT")).toEqual(["CHAT_BASE_URL", "CHAT_API_KEY"]);
    expect(capabilityGaps(u.embedding, "EMBEDDING")).toEqual(["EMBEDDING_BASE_URL", "EMBEDDING_MODEL", "EMBEDDING_API_KEY"]);
  });
});

describe("deriveSlotEnv（端点三要素 → 引擎槽位）", () => {
  test("chat → openrouter 槽（任意 OpenAI 兼容端点 + 纯模型名）", () => {
    const out = deriveSlotEnv(env(FULL));
    expect(out.derived["OPENROUTER_BASE_URL"]).toBe("https://api.deepseek.com/v1");
    expect(out.derived["GBRAIN_CHAT_MODEL"]).toBe("openrouter:deepseek-v4-flash");
    expect(out.derived["OPENROUTER_API_KEY"]).toBe("sk-chat");
  });

  test("embedding → llama-server 槽（维度=探测默认）", () => {
    const out = deriveSlotEnv(env(FULL), { embedding: { ok: true, dim: 1024 } });
    expect(out.derived["LLAMA_SERVER_BASE_URL"]).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(out.derived["GBRAIN_EMBEDDING_MODEL"]).toBe("llama-server:qwen3.7-text-embedding");
    expect(out.derived["GBRAIN_EMBEDDING_DIMENSIONS"]).toBe("1024");
  });

  test("embedding 显式维度优先于探测", () => {
    const out = deriveSlotEnv(env({ ...FULL, EMBEDDING_DIMENSIONS: "2048" }), { embedding: { ok: true, dim: 1024 } });
    expect(out.derived["GBRAIN_EMBEDDING_DIMENSIONS"]).toBe("2048");
  });

  test("rerank /reranks → dashscope-rerank 槽（config set 标记 + key 复制）", () => {
    const out = deriveSlotEnv(env(FULL), { rerank: { ok: true, path: "reranks" } });
    expect(out.rerankConfigRequired).toBe(true);
    expect(out.rerankModel).toBe("dashscope-rerank:qwen3-rerank");
    expect(out.rerankBaseUrl).toBe("https://dashscope.aliyuncs.com/compatible-api/v1");
    expect(out.derived["DASHSCOPE_API_KEY"]).toBe("sk-rer");
  });

  test("rerank /rerank 单数 → llama-server-reranker 槽（端点 env）", () => {
    const out = deriveSlotEnv(env(FULL), { rerank: { ok: true, path: "rerank" } });
    expect(out.rerankConfigRequired).toBe(false);
    expect(out.derived["LLAMA_SERVER_RERANKER_BASE_URL"]).toBe("https://dashscope.aliyuncs.com/compatible-api/v1");
    expect(out.derived["GBRAIN_RERANKER_MODEL"]).toBe("llama-server-reranker:qwen3-rerank");
  });

  test("rerank 形态未知（探测失败）→ 不派生模型槽（留给自愈重探），但 key 已备", () => {
    const out = deriveSlotEnv(env(FULL));
    expect(out.rerankConfigRequired).toBe(false);
    expect(out.derived["GBRAIN_RERANKER_MODEL"]).toBeUndefined();
    expect(out.derived["DASHSCOPE_API_KEY"]).toBe("sk-rer");
  });

  test("显式引擎变量优先（不覆盖）", () => {
    const out = deriveSlotEnv(env(FULL), { embedding: { ok: true, dim: 1024 } }, { GBRAIN_EMBEDDING_MODEL: "custom:x" });
    expect(out.derived["GBRAIN_EMBEDDING_MODEL"]).toBeUndefined();
  });

  test("无端点三要素 → 零派生", () => {
    const out = deriveSlotEnv(env({ DATABASE_URL: "x" }));
    expect(Object.keys(out.derived).length).toBe(0);
  });
});
