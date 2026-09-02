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

  test("并发释放后新请求放行", async () => {
    const upstream = { token: async () => "t", proxy: async () => new Response("{}", { status: 200 }) } as unknown as Upstream;
    const gw = new McpGateway({ baseUrl: "http://x", upstream, lookup: async () => keyRow({ concurrency: 1 }) });
    const r1 = await gw.handle(mcpReq());
    expect(r1.status).toBe(200);
    const r2 = await gw.handle(mcpReq());
    expect(r2.status).toBe(200);
  });
});
