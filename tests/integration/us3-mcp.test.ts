import { describe, expect, test } from "bun:test";

/**
 * 集成测试 US3 / SC-003：MCP 网关隔离——
 * federated-read [A,B] 凭证一次检索跨源命中；仅 [A] 凭证不可见 B；slug 栅栏拒越权写；吊销即 401。
 * 门控：TEST_BASE_URL + ADMIN_TOKEN。
 */
const BASE = process.env.TEST_BASE_URL;
const ADMIN = process.env.ADMIN_TOKEN ?? "";
const adminHeaders = () => ({ Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" });
const gated = BASE && ADMIN ? describe : describe.skip;
const UNIQUE = Date.now();
const MARKER = `mcp-us3-${UNIQUE}`;

async function createKb(name: string): Promise<string> {
  const r = await fetch(`${BASE}/v1/kb`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ name }) });
  return (await r.json()).id;
}

async function issueKey(label: string, writeKb: string | null, readKbs: string[]): Promise<string> {
  const r = await fetch(`${BASE}/v1/keys`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ label, write_kb: writeKb ?? undefined, read_kbs: readKbs }),
  });
  expect(r.status).toBe(201);
  return (await r.json()).key;
}

/** 极简 MCP Streamable HTTP 客户端：initialize 捕获会话 → tools/call */
async function mcpCall(apiKey: string, name: string, args: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const init = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "us3-test", version: "1.0" } } }),
  });
  const session = init.headers.get("mcp-session-id");
  if (session) {
    await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": session },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
  }
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  // 上游可能回 SSE 帧（event: message / data: {...}）或纯 JSON
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  const json = JSON.parse(dataLine ? dataLine.slice(6) : text);
  return { status: res.status, json };
}

async function search(apiKey: string, query: string): Promise<{ status: number; text: string }> {
  const { status, json } = await mcpCall(apiKey, "search", { query });
  const content = (json.result as { content?: Array<{ text?: string }> })?.content ?? [];
  return { status, text: content.map((c) => c.text ?? "").join("\n") };
}

gated("US3: MCP 网关隔离（SC-003）", () => {
  test("federated 跨源命中 / 未授权不可见 / 栅栏 / 吊销", async () => {
    const kbA = await createKb(`us3-a-${UNIQUE}`);
    const kbB = await createKb(`us3-b-${UNIQUE}`);
    const seedKey = await issueKey(`us3-seed-${UNIQUE}`, kbA, [kbA, kbB]);

    // 播种：向 A、B 各导一篇含唯一标记的内容（走 US2 通道）
    for (const [kb, word] of [
      [kbA, "alpha"],
      [kbB, "bravo"],
    ] as const) {
      const r = await fetch(`${BASE}/v1/kb/${kb}/documents`, {
        method: "POST",
        headers: { "X-API-Key": seedKey, "Content-Type": "text/markdown" },
        body: `# us3 ${word}\n${MARKER} ${word} 独有内容`,
      });
      expect(r.status).toBe(202);
    }
    // 轮询两侧任务终态（等待远端管道真实完成，同 US2 例外说明）
    const deadline = Date.now() + 120_000;
    const jobsAdmin = await (await fetch(`${BASE}/v1/jobs?status=queued`, { headers: adminHeaders() })).json();
    void jobsAdmin;
    while (Date.now() < deadline) {
      const all = await (await fetch(`${BASE}/v1/jobs`, { headers: adminHeaders() })).json();
      const pending = all.jobs.filter((j: { kb_id: string; status: string }) => [kbA, kbB].includes(j.kb_id) && ["queued", "running"].includes(j.status));
      if (pending.length === 0) break;
      await new Promise((res) => setTimeout(res, 1500));
    }

    // federated [A,B] 凭证：一次 search 同时命中两源
    const fed = await issueKey(`us3-fed-${UNIQUE}`, kbA, [kbA, kbB]);
    const fedSearch = await search(fed, MARKER);
    expect(fedSearch.status).toBe(200);
    expect(fedSearch.text).toContain("alpha");
    expect(fedSearch.text).toContain("bravo");

    // solo 仅 [A]：B 不可见（SC-003 否定断言）
    const solo = await issueKey(`us3-solo-${UNIQUE}`, kbA, [kbA]);
    const soloSearch = await search(solo, MARKER);
    expect(soloSearch.text).toContain("alpha");
    expect(soloSearch.text).not.toContain("bravo");

    // slug 栅栏：写 B 分区前缀被拒
    const fence = await mcpCall(fed, "put_page", { slug: `${kbB}/docs/evil`, content: "no" });
    const errText = JSON.stringify(fence.json);
    expect(/error|denied|not allowed|fenced|slug/i.test(errText) || (fence.json.error !== undefined)).toBe(true);

    // 吊销 federated → 下一请求 401
    const list = await (await fetch(`${BASE}/v1/keys`, { headers: adminHeaders() })).json();
    const fedId = list.find((k: { label: string }) => k.label === `us3-fed-${UNIQUE}`).id;
    const del = await fetch(`${BASE}/v1/keys/${fedId}`, { method: "DELETE", headers: adminHeaders() });
    expect(del.status).toBe(204);
    const after = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "X-API-Key": fed, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    expect(after.status).toBe(401);
  }, 300_000);
});
