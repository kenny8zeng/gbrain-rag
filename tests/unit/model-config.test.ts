import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../packages/core/src/config";
import { modelConfigState, validateModelConfig } from "../../packages/core/src/model-config";

const base = {
  ADMIN_TOKEN: "test-token-0123456789",
  DATABASE_URL: "postgres://stub@127.0.0.1:5/stub",
  DOCLING_URL: "https://docling.test",
} as Record<string, string>;

describe("modelConfigState（端点三要素就绪判定）", () => {
  test("未配置 → 三能力 false", () => {
    expect(modelConfigState(loadConfig(base))).toEqual({ chat: false, embedding: false, rerank: false });
  });

  test("三要素齐 → ready；缺 key → 不 ready", () => {
    const full = loadConfig({
      ...base,
      CHAT_BASE_URL: "https://api.deepseek.com/v1",
      CHAT_MODEL: "deepseek-v4-flash",
      CHAT_API_KEY: "sk-c",
      EMBEDDING_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      EMBEDDING_MODEL: "qwen3.7-text-embedding",
      EMBEDDING_API_KEY: "sk-e",
      RERANK_BASE_URL: "https://dashscope.aliyuncs.com/compatible-api/v1",
      RERANK_MODEL: "qwen3-rerank",
      RERANK_API_KEY: "sk-r",
    });
    expect(modelConfigState(full)).toEqual({ chat: true, embedding: true, rerank: true });
    const partial = loadConfig({ ...base, CHAT_BASE_URL: "https://x/v1", CHAT_MODEL: "m" });
    expect(modelConfigState(partial).chat).toBe(false);
  });
});

describe("validateModelConfig（缺口清单，非名单预检）", () => {
  test("半配置能力 → partial_capability 警告列出缺行", () => {
    const ws = validateModelConfig(loadConfig({ ...base, CHAT_BASE_URL: "https://x/v1", CHAT_MODEL: "m" }));
    expect(ws.some((w) => w.kind === "partial_capability" && w.message.includes("CHAT_API_KEY"))).toBe(true);
  });

  test("完整配置 → 无警告", () => {
    const ws = validateModelConfig(loadConfig({
      ...base,
      CHAT_BASE_URL: "https://x/v1", CHAT_MODEL: "m", CHAT_API_KEY: "k",
      EMBEDDING_BASE_URL: "https://y/v1", EMBEDDING_MODEL: "e", EMBEDDING_API_KEY: "k",
      RERANK_BASE_URL: "https://z/v1", RERANK_MODEL: "r", RERANK_API_KEY: "k",
    }));
    expect(ws).toEqual([]);
  });

  test("完全未配置 → 无警告", () => {
    expect(validateModelConfig(loadConfig(base))).toEqual([]);
  });
});
