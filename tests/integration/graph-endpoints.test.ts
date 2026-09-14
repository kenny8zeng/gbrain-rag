import { describe, expect, test } from "bun:test";

/**
 * 008 图谱端点集成：**边列表契约**（D29 回归）。
 *
 * 引擎 `traverse_graph` 的返回形状随 `direction` 变化：不传 → 节点树
 * （`{slug, links[]}`）；传了 → 边列表（`{from_slug, to_slug, link_type, depth}`）。
 * 服务端点契约是边列表，故必须显式补默认 `direction=both`——否则省略该参数会
 * 静默返回空数组（本地实测抓到的真实缺陷）。
 */
const BASE = process.env.TEST_BASE_URL;
const ADMIN = process.env.ADMIN_TOKEN ?? "";
const gated = BASE && ADMIN ? describe : describe.skip;

async function mk(text: string, name: string, kb: string, key: string): Promise<void> {
  const jid = await fetch(`${BASE}/v1/kb/${kb}/documents`, {
    method: "POST",
    headers: { "X-API-Key": key },
    body: (() => {
      const fd = new FormData();
      fd.append("file", new File([text], `${name}.md`, { type: "text/markdown" }));
      fd.append("title", name);
      return fd;
    })(),
  })
    .then((r) => r.json())
    .then((j: { job_id: string }) => j.job_id);
  for (let i = 0; i < 60; i++) {
    const st = await fetch(`${BASE}/v1/kb/${kb}/documents/jobs/${jid}`, { headers: { "X-API-Key": key } })
      .then((r) => r.json())
      .then((j: { status: string }) => j.status);
    if (["done", "done_with_warnings", "failed"].includes(st)) return;
    await Bun.sleep(2000);
  }
}

gated("图谱边列表契约（008）", () => {
  const kb = `kb-${Date.now().toString(16).slice(-8)}`;
  let key = "";

  test("准备：建库 + 两篇共享概念的文档", async () => {
    const created = await fetch(`${BASE}/v1/kb`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: `graph-contract-${Date.now()}` }),
    }).then((r) => r.json());
    expect(created.id).toBeTruthy();
    (globalThis as { __kbId?: string }).__kbId = created.id;

    const k = await fetch(`${BASE}/v1/keys`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ label: `graph-contract-${Date.now()}`, write_kb: created.id, read_kbs: [created.id] }),
    }).then((r) => r.json());
    key = k.key;
    expect(key).toStartWith("gbrag_");

    await mk("---\ntitle: s1\n---\n\n# Brake Noise\n\nCheck the [[Brake]] and [[Brake Fluid]].\n", "s1", created.id, key);
    await mk("---\ntitle: s2\n---\n\n# Brake Type\n\nThe ICT uses a disc [[Brake]].\n", "s2", created.id, key);
  }, 180000);

  test("省略 direction 仍返回边列表（D29 回归）", async () => {
    const kbId = (globalThis as { __kbId?: string }).__kbId!;
    const r = await fetch(`${BASE}/v1/kb/${kbId}/graph/traverse?slug=${kbId}/docs/s1&depth=2`, {
      headers: { "X-API-Key": key },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { paths: Array<Record<string, unknown>> };
    expect(body.paths.length).toBeGreaterThan(0);
    for (const p of body.paths) {
      expect(typeof p.from_slug).toBe("string");
      expect(typeof p.to_slug).toBe("string");
    }
  }, 60000);

  test("省略 direction 能发现共享概念的相邻文档", async () => {
    const kbId = (globalThis as { __kbId?: string }).__kbId!;
    const body = (await fetch(`${BASE}/v1/kb/${kbId}/graph/traverse?slug=${kbId}/docs/s1&depth=2`, {
      headers: { "X-API-Key": key },
    }).then((r) => r.json())) as { paths: Array<{ from_slug: string; to_slug: string }> };
    const touchesSibling = body.paths.some(
      (p) => p.from_slug === `${kbId}/docs/s2` || p.to_slug === `${kbId}/docs/s2`,
    );
    expect(touchesSibling).toBe(true);
  }, 60000);

  test("图谱增强检索：向量漏掉的相邻文档由图谱补出", async () => {
    const kbId = (globalThis as { __kbId?: string }).__kbId!;
    const base = (await fetch(`${BASE}/v1/kb/${kbId}/retrieval`, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "brake noise", mode: "hybrid", top_k: 1 }),
    }).then((r) => r.json())) as { results: unknown[]; graph_results?: unknown[] };
    expect(base.graph_results).toBeUndefined(); // 未请求图谱 → 响应不变

    const withGraph = (await fetch(`${BASE}/v1/kb/${kbId}/retrieval`, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "brake noise", mode: "hybrid", top_k: 1, graph: { depth: 2, max_results: 5 } }),
    }).then((r) => r.json())) as { graph_results?: Array<{ slug: string; via_concepts: string[] }>; degraded: string[] };
    expect(withGraph.degraded).toEqual([]);
    expect(withGraph.graph_results?.length).toBeGreaterThan(0);
    const hit = withGraph.graph_results![0]!;
    expect(hit.slug).toBe(`${kbId}/docs/s2`);
    expect(hit.via_concepts).toContain("brake");
  }, 60000);

  test("清理：purge 建库", async () => {
    const kbId = (globalThis as { __kbId?: string }).__kbId;
    if (!kbId) return;
    await fetch(`${BASE}/v1/kb/${kbId}?force=true`, { method: "DELETE", headers: { Authorization: `Bearer ${ADMIN}` } });
    const r = await fetch(`${BASE}/v1/kb/${kbId}/purge?force=true`, { method: "POST", headers: { Authorization: `Bearer ${ADMIN}` } });
    expect(r.status).toBeLessThan(500);
  }, 120000);
});
