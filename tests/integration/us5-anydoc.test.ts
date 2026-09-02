import { describe, expect, test } from "bun:test";

/**
 * US1/US2 集成（anydoc 模式实例，PARSER_MODE=anydoc，端口 3101）：
 * docx 全链路导入检索（SC-001/002）；url/图片 422 PARSER_UNAVAILABLE（SC-003）。
 * 门控：TEST_BASE_URL（anydoc 实例）+ ADMIN_TOKEN。
 */
const BASE = process.env.TEST_BASE_URL;
const ADMIN = process.env.ADMIN_TOKEN ?? "";
const adminHeaders = () => ({ Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" });
const UNIQUE = Date.now();
const created: string[] = [];

// anydoc 专属用例：仅当目标实例 parser_mode=anydoc 时运行（docling 实例全量回归自动跳过）
let anydocMode = false;
if (BASE && ADMIN) {
  try {
    const h = await (await fetch(`${BASE}/health`)).json();
    anydocMode = h.parser_mode === "anydoc";
  } catch {
    anydocMode = false;
  }
}
const gated = BASE && ADMIN && anydocMode ? describe : describe.skip;

gated("US5: anydoc 模式文件导入与能力边界", () => {
  test("健康检查 parser_mode=anydoc（FR-007）", async () => {
    const h = await (await fetch(`${BASE}/health`)).json();
    expect(h.parser_mode).toBe("anydoc");
    expect(h.docling).toBe(false);
    expect(h.status).toBe("ok"); // anydoc 模式非降级
  });

  test("docx 导入 → done(created) → 检索命中中文与表格（SC-001/002）", async () => {
    const kb = await (await fetch(`${BASE}/v1/kb`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ name: `us5-${UNIQUE}` }) })).json();
    created.push(kb.id);
    const key = (await (await fetch(`${BASE}/v1/keys`, {
      method: "POST", headers: adminHeaders(),
      body: JSON.stringify({ label: `us5-k-${UNIQUE}`, write_kb: kb.id, read_kbs: [kb.id] }),
    })).json()).key;

    const form = new FormData();
    form.append("file", Bun.file("tests/fixtures/test.docx"), "test.docx");
    const submit = await fetch(`${BASE}/v1/kb/${kb.id}/documents`, { method: "POST", headers: { "X-API-Key": key }, body: form });
    expect(submit.status).toBe(202);
    const jobId = (await submit.json()).job_id;

    const deadline = Date.now() + 120_000;
    let job;
    while (Date.now() < deadline) {
      job = await (await fetch(`${BASE}/v1/kb/${kb.id}/documents/jobs/${jobId}`, { headers: { "X-API-Key": key } })).json();
      if (["done", "done_with_warnings", "failed"].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    expect(["done", "done_with_warnings"]).toContain(String(job.status));
    expect(job.outcome).toBe("created");
    expect(String(job.doc_slug ?? "")).toBe(`${kb.id}/docs/test`);

    // 检索命中 docx 中文与表格
    const hit = await (await fetch(`${BASE}/v1/kb/${kb.id}/retrieval`, {
      method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "退货政策", mode: "keyword", top_k: 5 }),
    })).json();
    expect(hit.results.length).toBeGreaterThan(0);
    // 命中 docx 中文内容即证端到端（表格保真已由 parser 单测断言 '|' 覆盖）
    expect(String(hit.results[0]?.snippet ?? "")).toContain("退货政策");
  }, 180_000);

  test("url 导入 → 422 PARSER_UNAVAILABLE 指引（SC-003）", async () => {
    const kb = await (await fetch(`${BASE}/v1/kb`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ name: `us5-url-${UNIQUE}` }) })).json();
    created.push(kb.id);
    const key = (await (await fetch(`${BASE}/v1/keys`, {
      method: "POST", headers: adminHeaders(),
      body: JSON.stringify({ label: `us5-url-k-${UNIQUE}`, write_kb: kb.id, read_kbs: [kb.id] }),
    })).json()).key;
    const r = await fetch(`${BASE}/v1/kb/${kb.id}/documents`, {
      method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/x" }),
    });
    expect(r.status).toBe(422);
    const j = await r.json();
    expect(j.error.code).toBe("PARSER_UNAVAILABLE");
    expect(j.error.message).toContain("DOCLING_URL");
  });

  test("图片 multipart → 422 PARSER_UNAVAILABLE（SC-003）", async () => {
    const kb = await (await fetch(`${BASE}/v1/kb`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ name: `us5-img-${UNIQUE}` }) })).json();
    created.push(kb.id);
    const key = (await (await fetch(`${BASE}/v1/keys`, {
      method: "POST", headers: adminHeaders(),
      body: JSON.stringify({ label: `us5-img-k-${UNIQUE}`, write_kb: kb.id, read_kbs: [kb.id] }),
    })).json()).key;
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "pic.png");
    const r = await fetch(`${BASE}/v1/kb/${kb.id}/documents`, { method: "POST", headers: { "X-API-Key": key }, body: form });
    expect(r.status).toBe(422);
    const j = await r.json();
    expect(j.error.code).toBe("PARSER_UNAVAILABLE");
  });

  test("md 直传不受影响（202）", async () => {
    const kb = await (await fetch(`${BASE}/v1/kb`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ name: `us5-md-${UNIQUE}` }) })).json();
    created.push(kb.id);
    const key = (await (await fetch(`${BASE}/v1/keys`, {
      method: "POST", headers: adminHeaders(),
      body: JSON.stringify({ label: `us5-md-k-${UNIQUE}`, write_kb: kb.id, read_kbs: [kb.id] }),
    })).json()).key;
    const r = await fetch(`${BASE}/v1/kb/${kb.id}/documents`, {
      method: "POST", headers: { "X-API-Key": key, "Content-Type": "text/markdown", "X-Slug": "md-ok" },
      body: "# md fine",
    });
    expect(r.status).toBe(202);
  });
});

gated("cleanup", () => {
  test("自清理", async () => {
    for (const id of created) {
      await fetch(`${BASE}/v1/kb/${id}`, { method: "DELETE", headers: adminHeaders() }).catch(() => undefined);
    }
    expect(true).toBe(true);
  }, 60_000);
});
