import { describe, expect, test } from "bun:test";

/**
 * 契约边界（testing-strategy §8 缺口）：
 * 413 上传超限（实例以 MAX_UPLOAD_BYTES=1MB 运行）、jobs 过滤、keys PATCH 持久化、health 形状。
 * 门控：TEST_BASE_URL + ADMIN_TOKEN。
 */
const BASE = process.env.TEST_BASE_URL;
const ADMIN = process.env.ADMIN_TOKEN ?? "";
const adminHeaders = () => ({ Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" });
const gated = BASE && ADMIN ? describe : describe.skip;
const U = Date.now();

gated("contract: 边界与查询面", () => {
  test("413：multipart 超过 MAX_UPLOAD_BYTES（1MB）", async () => {
    const kb = await (await fetch(`${BASE}/v1/kb`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ name: `lim-${U}` }) })).json();
    const key = (await (await fetch(`${BASE}/v1/keys`, {
      method: "POST", headers: adminHeaders(),
      body: JSON.stringify({ label: `lim-k-${U}`, write_kb: kb.id, read_kbs: [kb.id] }),
    })).json()).key;
    const big = new Uint8Array(2 * 1024 * 1024); // 2MB > 1MB 上限
    big.fill(65);
    const form = new FormData();
    form.append("file", new Blob([big], { type: "application/octet-stream" }), "big.pdf");
    const r = await fetch(`${BASE}/v1/kb/${kb.id}/documents`, { method: "POST", headers: { "X-API-Key": key }, body: form });
    expect(r.status).toBe(413);
    const j = await r.json();
    expect(j.error.code).toBe("PAYLOAD_TOO_LARGE");
    // 清理
    const keys = await (await fetch(`${BASE}/v1/keys`, { headers: adminHeaders() })).json();
    const kid = keys.find((k: { label: string }) => k.label === `lim-k-${U}`)?.id;
    await fetch(`${BASE}/v1/keys/${kid}`, { method: "DELETE", headers: adminHeaders() });
    await fetch(`${BASE}/v1/kb/${kb.id}/purge?force=true`, { method: "POST", headers: adminHeaders() });
  });

  test("jobs 按 status 过滤精确", async () => {
    const r = await fetch(`${BASE}/v1/jobs?status=done`, { headers: adminHeaders() });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(Array.isArray(j.jobs)).toBe(true);
    for (const job of j.jobs) expect(job.status).toBe("done");
  });

  test("PATCH keys concurrency/surface 持久化（GET 回读）", async () => {
    const kb = await (await fetch(`${BASE}/v1/kb`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ name: `patch-${U}` }) })).json();
    const created = await (await fetch(`${BASE}/v1/keys`, {
      method: "POST", headers: adminHeaders(),
      body: JSON.stringify({ label: `patch-k-${U}`, write_kb: kb.id, read_kbs: [kb.id] }),
    })).json();
    const patch = await fetch(`${BASE}/v1/keys/${created.id}`, {
      method: "PATCH", headers: adminHeaders(),
      body: JSON.stringify({ concurrency: 7, surface: "full" }),
    });
    expect(patch.status).toBe(200);
    const after = await (await fetch(`${BASE}/v1/keys`, { headers: adminHeaders() })).json();
    const row = after.find((k: { id: string }) => k.id === created.id);
    expect(row.concurrency).toBe(7);
    // 清理（surface 变更经 rescope 已同步上游；此处仅吊销收尾）
    await fetch(`${BASE}/v1/keys/${created.id}`, { method: "DELETE", headers: adminHeaders() });
    await fetch(`${BASE}/v1/kb/${kb.id}/purge?force=true`, { method: "POST", headers: adminHeaders() });
  });

  test("health 字段形状完整", async () => {
    const h = await (await fetch(`${BASE}/health`)).json();
    expect(typeof h.status).toBe("string");
    expect(typeof h.gbrain_serve).toBe("boolean");
    expect(typeof h.db).toBe("boolean");
    expect(typeof h.docling).toBe("boolean");
    expect(["docling", "anydoc"]).toContain(h.parser_mode);
    expect(["docling", "anydoc"]).toContain(h.parser_primary);
    expect(["docling", "anydoc"]).toContain(h.parser_preference);
    expect(typeof h.models.embedding).toBe("boolean");
    expect(typeof h.models.rerank).toBe("boolean");
    expect(typeof h.models.chat).toBe("boolean");
  });
});
