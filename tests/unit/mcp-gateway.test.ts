import { describe, expect, test } from "bun:test";
import { McpGateway } from "../../packages/core/src/mcp-gateway";
import type { Upstream } from "../../packages/core/src/gbrain-upstream";
import type { KeyRow } from "../../packages/core/src/credentials";

function keyRow(over: Partial<KeyRow> = {}): KeyRow {
  return {
    id: "k1",
    keyHash: "h",
    keyPrefix: "gbrag_test1",
    label: "test",
    writeKb: "kb-11111111",
    readKbs: ["kb-11111111"],
    surface: "starter",
    clientId: "gbrain_cl_t",
    clientSecret: "gbrain_cs_t",
    concurrency: 1,
    createdAt: "2026-09-02T00:00:00Z",
    revokedAt: null,
    ...over,
  };
}

function mcpReq(): Request {
  return new Request("http://127.0.0.1:7333/mcp", {
    method: "POST",
    headers: { "X-API-Key": "gbrag_secret", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

describe("McpGateway 鉴权与并发", () => {
  test("无 X-API-Key → 401", async () => {
    const gw = new McpGateway({ baseUrl: "http://x", upstream: { token: async () => "t" } as unknown as Upstream, lookup: async () => null });
    const res = await gw.handle(new Request("http://x/mcp", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  test("无效/已吊销 key → 401", async () => {
    const gw = new McpGateway({
      baseUrl: "http://x",
      upstream: { token: async () => "t" } as unknown as Upstream,
      lookup: async () => keyRow({ revokedAt: "2026-09-01T00:00:00Z" }),
    });
    const res = await gw.handle(mcpReq());
    expect(res.status).toBe(401);
  });

  test("并发超限 → 429（挂起上游确定性验证，CHK 缺口 429）", async () => {
    // 挂起式上游：第一个请求占住并发槽，第二个必须 429
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((r) => (releaseFirst = r));
    const upstream = {
      token: async () => "t",
      proxy: async () => {
        await first; // 挂起直到测试释放
        return new Response("{}", { status: 200 });
      },
    } as unknown as Upstream;

    const gw = new McpGateway({
      baseUrl: "http://127.0.0.1:7333",
      upstream,
      lookup: async () => keyRow({ concurrency: 1 }),
    });

    const p1 = gw.handle(mcpReq());
    await new Promise((r) => setTimeout(r, 20)); // 让 p1 进入 inflight
    const p2 = await gw.handle(mcpReq());
    expect(p2.status).toBe(429);

    releaseFirst?.();
    const res1 = await p1;
    expect(res1.status).toBe(200);
  });

  test("凭证无上游 client（OAuth 缺失）→ 401", async () => {
    const gw = new McpGateway({
      baseUrl: "http://127.0.0.1:7333",
      upstream: { proxy: async () => new Response("unreachable") } as unknown as Upstream,
      lookup: async () => keyRow({ clientId: null, clientSecret: null }),
    });
    const res = await gw.handle(mcpReq());
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toContain("no upstream client");
  });

  test("有效凭证 → 注入上游 client 凭证并代理到 /mcp", async () => {
    const calls: Array<{ path: string; creds: { clientId: string; clientSecret: string } }> = [];
    const gw = new McpGateway({
      baseUrl: "http://127.0.0.1:7333",
      upstream: {
        proxy: async (path: string, creds: { clientId: string; clientSecret: string }, _req: Request) => {
          calls.push({ path, creds });
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
      } as unknown as Upstream,
      lookup: async () => keyRow(),
    });
    const res = await gw.handle(mcpReq());
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]!.path).toBe("/mcp");
    expect(calls[0]!.creds).toEqual({ clientId: "gbrain_cl_t", clientSecret: "gbrain_cs_t" });
  });

  test("上游异常 → 并发槽释放（后续请求可进入）", async () => {
    let calls = 0;
    const gw = new McpGateway({
      baseUrl: "http://127.0.0.1:7333",
      upstream: {
        proxy: async () => {
          calls++;
          if (calls === 1) throw new Error("upstream boom");
          return new Response("ok", { status: 200 });
        },
      } as unknown as Upstream,
      lookup: async () => keyRow({ concurrency: 1 }),
    });
    await expect(gw.handle(mcpReq())).rejects.toThrow("upstream boom");
    const res = await gw.handle(mcpReq());
    expect(res.status).toBe(200);
  });

  test("并发释放后新请求放行", async () => {
    const upstream = { token: async () => "t", proxy: async () => new Response("{}", { status: 200 }) } as unknown as Upstream;
    const gw = new McpGateway({ baseUrl: "http://x", upstream, lookup: async () => keyRow({ concurrency: 1 }) });
    const r1 = await gw.handle(mcpReq());
    expect(r1.status).toBe(200);
    const r2 = await gw.handle(mcpReq());
    expect(r2.status).toBe(200);
  });
});

describe("文档面类型注入（008：MCP 读工具排除实体页）", () => {
  test("search/query 注入 types=[note]", async () => {
    const { rewriteDocPlaneCall } = await import("../../packages/core/src/mcp-gateway");
    for (const tool of ["search", "query"]) {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { query: "battery" } } });
      const out = JSON.parse(rewriteDocPlaneCall(body)!);
      expect(out.params.arguments.types).toEqual(["note"]);
    }
  });

  test("list_pages 注入 type=note（单数参数）", async () => {
    const { rewriteDocPlaneCall } = await import("../../packages/core/src/mcp-gateway");
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_pages", arguments: { limit: 50 } } });
    const out = JSON.parse(rewriteDocPlaneCall(body)!);
    expect(out.params.arguments.type).toBe("note");
  });

  test("调用方显式指定类型时尊重（不过滤）", async () => {
    const { rewriteDocPlaneCall } = await import("../../packages/core/src/mcp-gateway");
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query", arguments: { query: "x", types: ["concept"] } } });
    expect(rewriteDocPlaneCall(body)).toBeNull();
  });

  test("非文档面工具不改写（图工具照常可用）", async () => {
    const { rewriteDocPlaneCall } = await import("../../packages/core/src/mcp-gateway");
    for (const tool of ["traverse_graph", "get_links", "get_backlinks", "entity", "get_page", "get_chunks"]) {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { slug: "kb-x/entities/battery" } } });
      expect(rewriteDocPlaneCall(body)).toBeNull();
    }
  });

  test("非 tools/call 方法不改写（initialize/tools/list 不受影响）", async () => {
    const { rewriteDocPlaneCall } = await import("../../packages/core/src/mcp-gateway");
    for (const method of ["initialize", "tools/list", "notifications/initialized"]) {
      expect(rewriteDocPlaneCall(JSON.stringify({ jsonrpc: "2.0", id: 1, method }))).toBeNull();
    }
  });

  test("批量请求（数组）逐条处理", async () => {
    const { rewriteDocPlaneCall } = await import("../../packages/core/src/mcp-gateway");
    const body = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query: "a" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "traverse_graph", arguments: { slug: "s" } } },
    ]);
    const out = JSON.parse(rewriteDocPlaneCall(body)!);
    expect(out[0].params.arguments.types).toEqual(["note"]);
    expect(out[1].params.arguments.types).toBeUndefined();
  });

  test("非法 JSON 与缺参数安全透传", async () => {
    const { rewriteDocPlaneCall } = await import("../../packages/core/src/mcp-gateway");
    expect(rewriteDocPlaneCall("not json")).toBeNull();
    expect(rewriteDocPlaneCall("null")).toBeNull();
    expect(rewriteDocPlaneCall(JSON.stringify({ method: "tools/call" }))).toBeNull();
    expect(rewriteDocPlaneCall(JSON.stringify({ method: "tools/call", params: { name: "search" } }))).not.toBeNull();
  });
});
