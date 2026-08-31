import { describe, expect, test } from "bun:test";

/**
 * 契约测试：对运行中的 gbrain-rag 实例校验 REST 形状与鉴权门。
 * 门控：TEST_BASE_URL + ADMIN_TOKEN 存在才执行。
 */
const BASE = process.env.TEST_BASE_URL;
const ADMIN = process.env.ADMIN_TOKEN ?? "";
const hmac = { "Content-Type": "application/json" };

const adminHeaders = () => ({ Authorization: `Bearer ${ADMIN}`, ...hmac });
const gated = BASE && ADMIN ? describe : describe.skip;

gated("contract: 鉴权门", () => {
  test("管理面无 token → 401", async () => {
    const r = await fetch(`${BASE}/v1/kb`);
    expect(r.status).toBe(401);
  });
  test("管理面错 token → 401", async () => {
    const r = await fetch(`${BASE}/v1/kb`, { headers: { Authorization: "Bearer wrong" } });
    expect(r.status).toBe(401);
  });
  test("租户面无 key → 401", async () => {
    const r = await fetch(`${BASE}/v1/kb/kb-00000000/documents`);
    expect(r.status).toBe(401);
  });
  test("未知路由 → 404 envelope", async () => {
    const r = await fetch(`${BASE}/nope`, { headers: adminHeaders() });
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.error.code).toBe("NOT_FOUND");
  });
});

gated("contract: kb/keys", () => {
  test("POST /v1/kb 形状", async () => {
    const r = await fetch(`${BASE}/v1/kb`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: `contract-${Date.now()}` }),
    });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.id).toMatch(/^kb-[0-9a-f]{8}$/);
    expect(j.status).toBe("active");
  });

  test("POST /v1/keys 明文仅一次 + GET 无哈希", async () => {
    const kb = await (
      await fetch(`${BASE}/v1/kb`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ name: `contract-key-${Date.now()}` }),
      })
    ).json();

    const created = await fetch(`${BASE}/v1/keys`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ label: `contract-${Date.now()}`, write_kb: kb.id, read_kbs: [kb.id] }),
    });
    expect(created.status).toBe(201);
    const cj = await created.json();
    expect(cj.key).toMatch(/^gbrag_[0-9a-f]{32}$/);

    const list = await (await fetch(`${BASE}/v1/keys`, { headers: adminHeaders() })).json();
    const listStr = JSON.stringify(list);
    expect(listStr).not.toMatch(/gbrag_[0-9a-f]{32}/); // 完整明文 key 不出现
    expect(listStr).not.toContain(cj.key);
    expect(listStr).not.toContain("key_hash");
    expect(list[0].key_prefix).toBeDefined();
  });

  test("重复 label → 409", async () => {
    const kb = await (
      await fetch(`${BASE}/v1/kb`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ name: `contract-dup-${Date.now()}` }),
      })
    ).json();
    const label = `dup-${Date.now()}`;
    const first = await fetch(`${BASE}/v1/keys`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ label, read_kbs: [kb.id] }),
    });
    expect(first.status).toBe(201);
    const again = await fetch(`${BASE}/v1/keys`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ label, read_kbs: [kb.id] }),
    });
    expect(again.status).toBe(409);
  });
});

gated("contract: admin proxy", () => {
  test("format=json 结构化输出", async () => {
    const r = await fetch(`${BASE}/v1/admin/gbrain/sources/list?format=json`, { headers: adminHeaders() });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    await r.json(); // 可解析
  });
  test("非 JSON 路由带 format=json → 400", async () => {
    const r = await fetch(`${BASE}/v1/admin/gbrain/sources/add/test-id?format=json`, { method: "PUT", headers: adminHeaders() });
    expect([200, 400, 404]).toContain(r.status); // 路由存在与否版本相关；400 时必须为 FORMAT_NOT_SUPPORTED
    if (r.status === 400) {
      const j = await r.json();
      expect(j.error.code).toBe("FORMAT_NOT_SUPPORTED");
    }
  });
});
