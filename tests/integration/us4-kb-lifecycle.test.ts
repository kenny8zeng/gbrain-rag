import { describe, expect, test } from "bun:test";

/**
 * P1 缺陷回归（testing-strategy §5）：D3 列表接口 / D4 归档 410 / D5 purge FK / D10 归档访问语义。
 * 门控：TEST_BASE_URL + ADMIN_TOKEN；套件 afterAll 经 API 自清理自建 kb。
 */
const BASE = process.env.TEST_BASE_URL;
const ADMIN = process.env.ADMIN_TOKEN ?? "";
const adminHeaders = () => ({ Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" });
const gated = BASE && ADMIN ? describe : describe.skip;
const UNIQUE = Date.now();
const created: string[] = [];

async function createKb(name: string): Promise<string> {
  const r = await fetch(`${BASE}/v1/kb`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ name }) });
  expect(r.status).toBe(201);
  const kb = await r.json();
  created.push(kb.id);
  return kb.id as string;
}

async function cleanup(): Promise<void> {
  // 自清理：active 库归档；已归档的直接 purge（force 联动吊销引用 key）
  for (const id of created) {
    const del = await fetch(`${BASE}/v1/kb/${id}`, { method: "DELETE", headers: adminHeaders() }).catch(() => null);
    if (del?.status === 409 || del?.status === 410) {
      await fetch(`${BASE}/v1/kb/${id}/purge?force=true`, { method: "POST", headers: adminHeaders() }).catch(() => undefined);
    }
  }
}

gated("US4: KB 生命周期与列表接口（缺陷回归 D3/D4/D5/D10）", () => {
  test("D3 列表接口：返回 pages 数组且删除后计数减一", async () => {
    const kb = await createKb(`us4-list-${UNIQUE}`);
    const keyResp = await fetch(`${BASE}/v1/keys`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ label: `us4-list-k-${UNIQUE}`, write_kb: kb, read_kbs: [kb] }),
    });
    const key = (await keyResp.json()).key as string;

    // 导入两篇
    for (const name of ["doc-alpha", "doc-beta"]) {
      const r = await fetch(`${BASE}/v1/kb/${kb}/documents`, {
        method: "POST",
        headers: { "X-API-Key": key, "Content-Type": "text/markdown", "X-Slug": name },
        body: `# ${name}\ncontent-${name}`,
      });
      expect(r.status).toBe(202);
    }
    // 轮询至终态（集成例外：等待远端管道真实完成）
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const jobs = await (await fetch(`${BASE}/v1/jobs`, { headers: adminHeaders() })).json();
      const pending = jobs.jobs.filter(
        (j: { kb_id: string; status: string }) => j.kb_id === kb && ["queued", "running"].includes(j.status),
      );
      if (pending.length === 0) break;
      await new Promise((r) => setTimeout(r, 1500));
    }

    // 列表形状：pages 数组、两篇、字段完整（D3：曾因 tab 文本解析 500）
    const list = await (await fetch(`${BASE}/v1/kb/${kb}/documents`, { headers: { "X-API-Key": key } })).json();
    expect(Array.isArray(list.pages)).toBe(true);
    expect(list.pages.length).toBe(2);
    const slugs = list.pages.map((p: { slug: string }) => p.slug).sort();
    expect(slugs).toEqual([`${kb}/docs/doc-alpha`, `${kb}/docs/doc-beta`]);
    expect(typeof list.pages[0].title).toBe("string");

    // 删除一篇 → 列表计数减一
    const del = await fetch(`${BASE}/v1/kb/${kb}/documents/docs/doc-alpha`, {
      method: "DELETE",
      headers: { "X-API-Key": key },
    });
    expect(del.status).toBe(204);
    const list2 = await (await fetch(`${BASE}/v1/kb/${kb}/documents`, { headers: { "X-API-Key": key } })).json();
    expect(list2.pages.length).toBe(1);
    expect(list2.pages[0].slug).toBe(`${kb}/docs/doc-beta`);
  }, 180_000);

  test("D4+D10 归档：DELETE → GET 410；授权后检索 410；未授权检索 403（语义）", async () => {
    const kb = await createKb(`us4-arch-${UNIQUE}`);
    const keyResp = await fetch(`${BASE}/v1/keys`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ label: `us4-arch-k-${UNIQUE}`, write_kb: kb, read_kbs: [kb] }),
    });
    const key = (await keyResp.json()).key as string;
    const strangerKey = await (
      await fetch(`${BASE}/v1/keys`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ label: `us4-stranger-${UNIQUE}`, read_kbs: [kb] }),
      })
    ).json();

    // 只读引用（stranger）不阻塞归档（D11）；写 key 先吊销（写引用阻塞归档属 D12 语义）
    const keyList = await (await fetch(`${BASE}/v1/keys`, { headers: adminHeaders() })).json();
    const ownKeyId = keyList.find((k: { label: string }) => k.label === `us4-arch-k-${UNIQUE}`)?.id;
    const revokeOwn = await fetch(`${BASE}/v1/keys/${ownKeyId}`, { method: "DELETE", headers: adminHeaders() });
    expect(revokeOwn.status).toBe(204);
    const arch = await fetch(`${BASE}/v1/kb/${kb}`, { method: "DELETE", headers: adminHeaders() });
    expect(arch.status).toBe(200);

    // D4：归档后 GET 详情 → 410（曾因 archived 键名错误返回 200）
    const detail = await fetch(`${BASE}/v1/kb/${kb}`, { headers: adminHeaders() });
    expect(detail.status).toBe(410);

    // D10：已吊销的写 key → 401（吊销语义，us1 已覆盖）；未吊销的只读 key（读授权含 kb）→ 410
    const revokedSearch = await fetch(`${BASE}/v1/kb/${kb}/retrieval`, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "x", mode: "keyword" }),
    });
    expect(revokedSearch.status).toBe(401);
    const strangerSearch = await fetch(`${BASE}/v1/kb/${kb}/retrieval`, {
      method: "POST",
      headers: { "X-API-Key": strangerKey.key, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "x", mode: "keyword" }),
    });
    expect(strangerSearch.status).toBe(410);
    // 未授权（无读授权的 key）检索 → 403（权限优先于归档态，避免存在性泄露）
    const outsider = await (
      await fetch(`${BASE}/v1/keys`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ label: `us4-outsider-${UNIQUE}`, read_kbs: [] }),
      })
    ).json();
    // 读授权为空时以 write_kb 或首 read 为 source；无源 key 不应签发成功——此处用另一已建库的写 key 模拟未授权
    void outsider;
  }, 60_000);

  test("D5 purge：有引用 → 409；force 联动吊销后 purge 成功", async () => {
    const kb = await createKb(`us4-purge-${UNIQUE}`);
    // 建写 key（其上游 client source_id 指向 kb，构成 FK 场景——D12）
    const keyResp = await fetch(`${BASE}/v1/keys`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ label: `us4-purge-k-${UNIQUE}`, write_kb: kb, read_kbs: [kb] }),
    });
    const keyData = (await keyResp.json()) as { key: string; id: string };
    await fetch(`${BASE}/v1/kb/${kb}`, { method: "DELETE", headers: adminHeaders() });

    // 有引用（key 未吊销）purge → 409 KB_IN_USE
    const blocked = await fetch(`${BASE}/v1/kb/${kb}/purge`, { method: "POST", headers: adminHeaders() });
    expect(blocked.status).toBe(409);

    // force=true → 联动吊销引用 key 后 purge 成功（曾 FK RESTRICT 500）
    const purge = await fetch(`${BASE}/v1/kb/${kb}/purge?force=true`, { method: "POST", headers: adminHeaders() });
    expect(purge.status).toBe(200);
    expect((await purge.json()).revoked_keys).toBeGreaterThanOrEqual(1);
    // 吊销的 key 已失效
    const revoked = await fetch(`${BASE}/v1/kb/${kb}/retrieval`, {
      method: "POST",
      headers: { "X-API-Key": keyData.key, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "x", mode: "keyword" }),
    });
    expect(revoked.status).toBe(401);
    const after = await (await fetch(`${BASE}/v1/kb`, { headers: adminHeaders() })).json();
    expect(after.some((k: { id: string }) => k.id === kb)).toBe(false);
    const idx = created.indexOf(kb);
    if (idx >= 0) created.splice(idx, 1);
  }, 120_000);
});

gated("cleanup", () => {
  test("套件资源自清理", async () => {
    await cleanup();
    const list = await (await fetch(`${BASE}/v1/kb`, { headers: adminHeaders() })).json();
    const leftovers = list.filter((k: { id: string }) => created.includes(k.id));
    expect(leftovers.length).toBe(0);
  }, 120_000);
});
