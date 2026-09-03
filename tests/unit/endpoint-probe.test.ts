import { describe, expect, test } from "bun:test";
import { probeChat, probeEmbedding, probeRerank } from "../../packages/core/src/endpoint-probe";

function mockFetch(routes: Array<{ match: (url: string, init?: RequestInit) => boolean; res: () => Response }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    for (const r of routes) {
      if (r.match(u, init)) return r.res();
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("endpoint-probe 真实探测", () => {
  test("chat：模型在目录 → ok", async () => {
    const f = mockFetch([{ match: (u) => u.endsWith("/models"), res: () => json({ data: [{ id: "deepseek-v4-flash" }, { id: "other" }] }) }]);
    const r = await probeChat("https://x.example/v1", "deepseek-v4-flash", "k", f);
    expect(r.ok).toBe(true);
  });

  test("chat：模型不在目录 → MODEL_NOT_FOUND（带建议）", async () => {
    const f = mockFetch([{ match: (u) => u.endsWith("/models"), res: () => json({ data: [{ id: "deepseek-chat" }] }) }]);
    const r = await probeChat("https://x.example/v1", "deepseek-v4-flash", "k", f);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("MODEL_NOT_FOUND");
  });

  test("chat：401 → KEY_REJECTED", async () => {
    const f = mockFetch([{ match: () => true, res: () => new Response("no", { status: 401 }) }]);
    const r = await probeChat("https://x.example/v1", "m", "bad", f);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("KEY_REJECTED");
  });

  test("chat：网络错误 → ENDPOINT_UNREACHABLE", async () => {
    const f = (async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    const r = await probeChat("https://x.example/v1", "m", "k", f);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("ENDPOINT_UNREACHABLE");
  });

  test("embedding：200 → 维度探测（向量长度）", async () => {
    const f = mockFetch([{ match: (u) => u.endsWith("/embeddings"), res: () => json({ data: [{ embedding: new Array(1024).fill(0.1) }] }) }]);
    const r = await probeEmbedding("https://x.example/v1", "qwen3.7-text-embedding", "k", f);
    expect(r.ok).toBe(true);
    expect(r.dim).toBe(1024);
  });

  test("embedding：400（型号不存在）→ MODEL_NOT_FOUND", async () => {
    const f = mockFetch([{ match: () => true, res: () => new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 400, headers: { "Content-Type": "application/json" } }) }]);
    const r = await probeEmbedding("https://x.example/v1", "nope", "k", f);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("MODEL_NOT_FOUND");
  });

  test("rerank：/reranks 200 → path=reranks", async () => {
    const f = mockFetch([{ match: (u) => u.endsWith("/reranks"), res: () => json({ results: [{ index: 0, relevance_score: 0.9 }] }) }]);
    const r = await probeRerank("https://x.example/v1", "qwen3-rerank", "k", f);
    expect(r.ok).toBe(true);
    expect(r.path).toBe("reranks");
  });

  test("rerank：/rerank 404 后 /reranks 404 → CAPABILITY_UNSUPPORTED", async () => {
    const f = mockFetch([{ match: () => true, res: () => new Response("nf", { status: 404 }) }]);
    const r = await probeRerank("https://x.example/v1", "m", "k", f);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("CAPABILITY_UNSUPPORTED");
  });

  test("rerank：/rerank 200（llama.cpp 风格单数）", async () => {
    const f = mockFetch([{ match: (u) => u.endsWith("/rerank"), res: () => json({ results: [{ index: 0, relevance_score: 0.9 }] }) }]);
    const r = await probeRerank("https://x.example/v1", "m", "k", f);
    expect(r.ok).toBe(true);
    expect(r.path).toBe("rerank");
  });
});
