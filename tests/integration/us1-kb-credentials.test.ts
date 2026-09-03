import { afterAll, describe, expect, test } from "bun:test";

/**
 * 集成测试 US1：建库 → 发凭证（写 A 读 A,B）→ 越权 403 → rescope 即时生效 → 吊销 401。
 * 门控：TEST_BASE_URL + ADMIN_TOKEN。
 */
const BASE = process.env.TEST_BASE_URL;
const ADMIN = process.env.ADMIN_TOKEN ?? "";
const adminHeaders = () => ({ Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" });

const gated = BASE && ADMIN ? describe : describe.skip;
const createdKbs: string[] = [];
const createdKeyIds: string[] = [];

async function createKb(name: string): Promise<string> {
  const r = await fetch(`${BASE}/v1/kb`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ name }) });
  expect(r.status).toBe(201);
  const id = (await r.json()).id as string;
  createdKbs.push(id);
  return id;
}

async function issueKey(label: string, writeKb: string | null, readKbs: string[]): Promise<{ id: string; key: string }> {
  createdKeyIds.length = 0;
  const r = await fetch(`${BASE}/v1/keys`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ label, write_kb: writeKb ?? undefined, read_kbs: readKbs }),
  });
  expect(r.status).toBe(201);
  return await r.json();
}

gated("US1: 建库与授权", () => {
  test("场景 1-5 全链路", async () => {
    // 1. 建两个库
    const kbA = await createKb(`us1-a-${Date.now()}`);
    const kbB = await createKb(`us1-b-${Date.now()}`);
    expect(kbA).toMatch(/^kb-[0-9a-f]{8}$/);

    // 2. 签发 {写=A, 读=[A,B]}
    const key = await issueKey(`us1-key-${Date.now()}`, kbA, [kbA, kbB]);
    expect(key.key).toMatch(/^gbrag_/);

    // 2b. 凭证可检索写分区（此时为空但不应 403）
    const read = await fetch(`${BASE}/v1/kb/${kbA}/retrieval`, {
      method: "POST",
      headers: { "X-API-Key": key.key, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "anything" }),
    });
    expect(read.status).toBe(200);

    // 3. 未授权分区 C → 403（新建 C）
    const kbC = await createKb(`us1-c-${Date.now()}`);
    const forbidden = await fetch(`${BASE}/v1/kb/${kbC}/retrieval`, {
      method: "POST",
      headers: { "X-API-Key": key.key, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "anything" }),
    });
    expect(forbidden.status).toBe(403);

    // 3b. 未授权分区导入 → 403（写权限外的导入被拒）
    const xwrite = await fetch(`${BASE}/v1/kb/${kbB}/documents`, {
      method: "POST",
      headers: { "X-API-Key": key.key, "Content-Type": "text/markdown" },
      body: "# x",
    });
    expect(xwrite.status).toBe(403);

    // 4. rescope 读授权收缩为 [A] → B 即时不可见（403）
    const list = await (await fetch(`${BASE}/v1/keys`, { headers: adminHeaders() })).json();
    const keyId = list.find((k: { id: string }) => k.id === key.id)?.id ?? key.id;
    const patched = await fetch(`${BASE}/v1/keys/${keyId}`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ read_kbs: [kbA] }),
    });
    expect([200, 201]).toContain(patched.status);
    const afterRescope = await fetch(`${BASE}/v1/kb/${kbB}/retrieval`, {
      method: "POST",
      headers: { "X-API-Key": key.key, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "anything" }),
    });
    expect(afterRescope.status).toBe(403);

    // 5. 吊销 → 全部请求 401
    const del = await fetch(`${BASE}/v1/keys/${keyId}`, { method: "DELETE", headers: adminHeaders() });
    expect(del.status).toBe(204);
    const afterRevoke = await fetch(`${BASE}/v1/kb/${kbA}/retrieval`, {
      method: "POST",
      headers: { "X-API-Key": key.key, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "anything" }),
    });
    expect(afterRevoke.status).toBe(401);
  });
});

// C2：测试残留清理——归档本文件创建的 KB（key 已在场景内吊销；兜底吊销）
afterAll(async () => {
  for (const kid of createdKbs) {
    await fetch(`${BASE}/v1/kb/${kid}`, {
      method: "DELETE",
      headers: adminHeaders(),
      body: JSON.stringify({ force: true }),
    }).catch(() => undefined);
  }
  for (const id of createdKeyIds) {
    await fetch(`${BASE}/v1/keys/${id}`, { method: "DELETE", headers: adminHeaders() }).catch(() => undefined);
  }
});
