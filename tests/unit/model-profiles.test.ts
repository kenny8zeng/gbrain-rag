import { describe, expect, test } from "bun:test";
import { PROVIDER_FACTS, checkModelChoice, planModelAssembly } from "../../packages/core/src/model-profiles";

const dash = PROVIDER_FACTS["dashscope"]!;
const or = PROVIDER_FACTS["openrouter"]!;

describe("checkModelChoice（白名单/通道路由预检）", () => {
  test("dashscope rerank 白名单内 → direct", () => {
    const c = checkModelChoice(dash, "rerank", "qwen3-rerank");
    expect(c.ok).toBe(true);
    expect(c.route).toBe("direct");
    expect(c.providerModel).toBe("dashscope-rerank:qwen3-rerank");
    expect(c.warnings?.[0]).toContain("provider_base_urls.dashscope-rerank");
  });

  test("dashscope rerank 白名单外 → 拒", () => {
    const c = checkModelChoice(dash, "rerank", "bge-reranker-v2");
    expect(c.ok).toBe(false);
    expect(c.error).toContain("认证清单");
  });

  test("dashscope embedding 白名单内 → direct 带维度", () => {
    const c = checkModelChoice(dash, "embedding", "text-embedding-v3");
    expect(c.ok).toBe(true);
    expect(c.route).toBe("direct");
    expect(c.dim).toBe(1024);
  });

  test("dashscope embedding 白名单外（qwen3.7）→ alias 通道 llama-server: + 提示", () => {
    const c = checkModelChoice(dash, "embedding", "qwen3.7-text-embedding");
    expect(c.ok).toBe(true);
    expect(c.route).toBe("alias");
    expect(c.providerModel).toBe("llama-server:qwen3.7-text-embedding");
    expect(c.dim).toBe(1024);
    expect(c.envRequired).toContain("EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1");
  });

  test("openrouter rerank 白名单（cohere 系）→ direct", () => {
    const c = checkModelChoice(or, "rerank", "cohere/rerank-v3.5");
    expect(c.ok).toBe(true);
    expect(c.providerModel).toBe("openrouter:cohere/rerank-v3.5");
    expect(c.warnings).toBeUndefined(); // 默认端点正确，无 base_url 覆盖
  });

  test("openrouter embedding 白名单窄（small 在册）", () => {
    const c = checkModelChoice(or, "embedding", "openai/text-embedding-3-small");
    expect(c.ok).toBe(true);
    expect(c.route).toBe("direct");
    expect(c.dim).toBe(1536);
  });

  test("chat 宽放行（openrouter）vs 拒绝（dashscope）", () => {
    expect(checkModelChoice(or, "chat", "deepseek/deepseek-v4-flash").ok).toBe(true);
    expect(checkModelChoice(dash, "chat", "qwen-max").ok).toBe(false);
  });
});

describe("planModelAssembly（装配指令：config set + env 清单）", () => {
  test("dashscope 全装配：rerank enabled/model/base_url config set", () => {
    const plan = planModelAssembly(dash, {
      chatModel: "",
      embeddingModel: "qwen3.7-text-embedding",
      rerankModel: "qwen3-rerank",
    });
    const keys = plan.actions.map((a) => a.key);
    expect(keys).toContain("search.reranker.model");
    expect(keys).toContain("search.reranker.enabled");
    expect(keys).toContain("provider_base_urls.dashscope-rerank");
    expect(plan.actions.find((a) => a.key === "search.reranker.model")?.value).toBe("dashscope-rerank:qwen3-rerank");
    expect(plan.actions.find((a) => a.key === "search.reranker.enabled")?.value).toBe("true");
    expect(plan.envRequired).toContain("DASHSCOPE_API_KEY");
    expect(plan.envRequired).toContain("GBRAIN_EMBEDDING_MODEL=llama-server:qwen3.7-text-embedding");
  });

  test("rerank 未指定 → 档案默认模型装配", () => {
    const plan = planModelAssembly(dash, { embeddingModel: "text-embedding-v3" });
    expect(plan.actions.find((a) => a.key === "search.reranker.model")?.value).toBe("dashscope-rerank:qwen3-rerank");
  });

  test("openrouter 装配：无 base_url 覆盖（默认端点正确）", () => {
    const plan = planModelAssembly(or, { rerankModel: "cohere/rerank-v3.5" });
    expect(plan.actions.map((a) => a.key)).not.toContain("provider_base_urls.openrouter");
    expect(plan.envRequired).toContain("OPENROUTER_API_KEY");
  });
});
