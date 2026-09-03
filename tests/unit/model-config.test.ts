import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../packages/core/src/config";
import { modelConfigState, validateModelConfig } from "../../packages/core/src/model-config";

const base = {
  ADMIN_TOKEN: "test-token-0123456789",
  DATABASE_URL: "postgres://stub@127.0.0.1:5/stub",
  DOCLING_URL: "https://docling.test",
} as Record<string, string>;

describe("modelConfigState（A：中立配置面判定）", () => {
  test("未配置 → 三者 false", () => {
    const st = modelConfigState(loadConfig(base));
    expect(st).toEqual({ embedding: false, rerank: false, chat: false });
  });

  test("中立三件套（EMBEDDING_*）→ embedding true", () => {
    const st = modelConfigState(loadConfig({ ...base, EMBEDDING_MODEL: "my-model", EMBEDDING_DIMENSIONS: "1024", EMBEDDING_BASE_URL: "http://gw:8080/v1" }));
    expect(st.embedding).toBe(true);
    expect(st.rerank).toBe(false);
  });

  test("dashscope-rerank provider（DASHSCOPE_API_KEY，无端点变量）→ rerank true", () => {
    const st = modelConfigState(loadConfig({
      ...base,
      GBRAIN_RERANKER_MODEL: "dashscope-rerank:qwen3-rerank",
      DASHSCOPE_API_KEY: "sk-test",
    }));
    expect(st.rerank).toBe(true);
    expect(st.embedding).toBe(false);
  });

  test("中立映射派生等价（llama-server:x vs x）→ 无 conflict 警告", () => {
    const ws = validateModelConfig(loadConfig({ ...base, GBRAIN_EMBEDDING_MODEL: "llama-server:my-model", EMBEDDING_MODEL: "my-model", LLAMA_SERVER_BASE_URL: "http://gw:1/v1", EMBEDDING_BASE_URL: "http://gw:1/v1" }));
    expect(ws.filter((w) => w.kind === "conflict")).toEqual([]);
  });

  test("原生变量（GBRAIN_* + LLAMA_SERVER_*）→ embedding/rerank true", () => {
    const st = modelConfigState(loadConfig({
      ...base,
      GBRAIN_EMBEDDING_MODEL: "llama-server:qwen3-embedding-4b",
      GBRAIN_EMBEDDING_DIMENSIONS: "2560",
      LLAMA_SERVER_BASE_URL: "http://ls:8080/v1",
      GBRAIN_RERANKER_MODEL: "qwen3-reranker-0.6b",
      LLAMA_SERVER_RERANKER_BASE_URL: "http://ls:8080/v1",
      GBRAIN_CHAT_MODEL: "deepseek:deepseek-v4-flash",
    }));
    expect(st).toEqual({ embedding: true, rerank: true, chat: true });
  });
});

describe("validateModelConfig（C：预检警告，不改配置）", () => {
  test("原生与中立并存值不同 → conflict 警告", () => {
    const ws = validateModelConfig(loadConfig({ ...base, LLAMA_SERVER_BASE_URL: "http://a:1/v1", EMBEDDING_BASE_URL: "http://b:1/v1" }));
    expect(ws.some((w) => w.kind === "conflict" && w.message.includes("LLAMA_SERVER_BASE_URL"))).toBe(true);
  });

  test("模型已设维度缺失 → missing_dims 警告", () => {
    const ws = validateModelConfig(loadConfig({ ...base, EMBEDDING_MODEL: "some-model" }));
    expect(ws.some((w) => w.kind === "missing_dims")).toBe(true);
  });

  test("已知模型维度不匹配 → dims_mismatch 警告", () => {
    const ws = validateModelConfig(loadConfig({ ...base, GBRAIN_EMBEDDING_MODEL: "openai:text-embedding-3-large", GBRAIN_EMBEDDING_DIMENSIONS: "1024" }));
    expect(ws.some((w) => w.kind === "dims_mismatch" && w.message.includes("3072"))).toBe(true);
  });

  test("原生优先：仅原生设置 → 无冲突警告", () => {
    const ws = validateModelConfig(loadConfig({ ...base, LLAMA_SERVER_BASE_URL: "http://a:1/v1", GBRAIN_EMBEDDING_MODEL: "llama-server:m", GBRAIN_EMBEDDING_DIMENSIONS: "2560" }));
    expect(ws.filter((w) => w.kind === "conflict")).toEqual([]);
  });
});
