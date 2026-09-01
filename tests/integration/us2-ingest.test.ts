import { describe, expect, test } from "bun:test";

/**
 * 集成测试 US2/US4：MD 导入 → 任务 done → 列表可见 → 检索命中 → 重复导入 updated。
 * 门控：TEST_BASE_URL + ADMIN_TOKEN。
 */
const BASE = process.env.TEST_BASE_URL;
const ADMIN = process.env.ADMIN_TOKEN ?? "";
const adminHeaders = () => ({ Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" });
const gated = BASE && ADMIN ? describe : describe.skip;

async function createKb(name: string): Promise<string> {
  const r = await fetch(`${BASE}/v1/kb`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ name }) });
  return (await r.json()).id;
}

// 集成例外：等待远端摄取管道的真实终态，只能对平台时钟轮询实际条件（非固定延时猜测）
async function issueKeyFor(kbId: string): Promise<string> {
  const r = await fetch(`${BASE}/v1/keys`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ label: `us2-key-${UNIQUE}-${kbId}`, write_kb: kbId, read_kbs: [kbId] }),
  });
  expect(r.status).toBe(201);
  return (await r.json()).key;
}

async function waitJob(key: string, kbId: string, jobId: string, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${BASE}/v1/kb/${kbId}/documents/jobs/${jobId}`, { headers: { "X-API-Key": key } });
    if (r.status === 200) {
      const j = await r.json();
      if (["done", "done_with_warnings", "failed"].includes(j.status)) return j;
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(`job ${jobId} timeout`);
}

const UNIQUE = Date.now();

gated("US2+US4: 导入与检索", () => {
  test("MD 直传 → done(created) → 检索命中 → 重复导入 updated", async () => {
    const kb = await createKb(`us2-${UNIQUE}`);
    const key = await issueKeyFor(kb);

    const marker = `zebra-us2-${UNIQUE}`;
    const submit = await fetch(`${BASE}/v1/kb/${kb}/documents`, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "text/markdown", "X-Slug": "returns-policy" },
      body: `# 退货政策\n${marker} 七日内无理由退货。`,
    });
    expect(submit.status).toBe(202);
    const { job_id: jobId } = await submit.json();

    const job = await waitJob(key, kb, jobId);
    expect(["done", "done_with_warnings"]).toContain(String(job.status));
    expect(job.outcome).toBe("created");
    expect(String(job.doc_slug ?? "")).toBe(`${kb}/docs/returns-policy`);

    // REST 检索命中（SC-002 形状）
    const hit = await (
      await fetch(`${BASE}/v1/kb/${kb}/retrieval`, {
        method: "POST",
        headers: { "X-API-Key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "退货政策", mode: "keyword", top_k: 5 }),
      })
    ).json();
    expect(hit.results.length).toBeGreaterThan(0);
    expect(String(hit.results[0]?.slug ?? "")).toContain(`${kb}/docs/`);
    expect(typeof hit.results[0].score).toBe("number");

    // 重复导入 → updated（FR-008）
    const resubmit = await fetch(`${BASE}/v1/kb/${kb}/documents`, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "text/markdown", "X-Slug": "returns-policy" },
      body: `# 退货政策\n${marker} 修订：十五日。`,
    });
    expect(resubmit.status).toBe(202);
    const job2 = await waitJob(key, kb, (await resubmit.json()).job_id);
    // 未配置 embedding 时写入成功但索引降级为 done_with_warnings（FR-009）
    expect(["done", "done_with_warnings"]).toContain(String(job2.status));
    expect(job2.outcome).toBe("updated");

    // 删除文档 → 204 → 检索不再命中（三段 slug 路径 <kb>/docs/<name>）
    const del = await fetch(`${BASE}/v1/kb/${kb}/documents/docs/returns-policy`, { method: "DELETE", headers: { "X-API-Key": key } });
    expect(del.status).toBe(204);
    const afterDel = await fetch(`${BASE}/v1/kb/${kb}/retrieval`, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "退货政策", mode: "keyword", top_k: 5 }),
    });
    const afterDelJson = await afterDel.json();
    expect(afterDelJson.results.length).toBe(0);


  }, 300_000);

  test("multipart 文件导入（md fixture）→ done(created) → 检索命中", async () => {
    const kb = await createKb(`us2-mp-${UNIQUE}`);
    const key = await issueKeyFor(kb);
    const file = Bun.file("tests/fixtures/sample.md");
    const form = new FormData();
    form.append("file", file, "sample.md");
    const submit = await fetch(`${BASE}/v1/kb/${kb}/documents`, {
      method: "POST",
      headers: { "X-API-Key": key },
      body: form,
    });
    expect(submit.status).toBe(202);
    const job = await waitJob(key, kb, (await submit.json()).job_id);
    expect(["done", "done_with_warnings"]).toContain(String(job.status));
    expect(job.outcome).toBe("created");
    expect(String(job.doc_slug ?? "")).toBe(`${kb}/docs/sample`);
    // 命中 multipart 导入的内容
    const hit = await (
      await fetch(`${BASE}/v1/kb/${kb}/retrieval`, {
        method: "POST",
        headers: { "X-API-Key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "multipart-zebra", mode: "keyword", top_k: 5 }),
      })
    ).json();
    expect(hit.results.length).toBeGreaterThan(0);
    expect(String(hit.results[0]?.slug ?? "")).toContain(`${kb}/docs/`);
  }, 180_000);

  test("不可达 URL → failed 带原因（SC-006）", async () => {
    const kb = await createKb(`us2-fail-${UNIQUE}`);
    const key = await issueKeyFor(kb);
    const submit = await fetch(`${BASE}/v1/kb/${kb}/documents`, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:1/nope" }),
    });
    expect(submit.status).toBe(202);
    const job = await waitJob(key, kb, (await submit.json()).job_id, 300_000);
    expect(job.status).toBe("failed");
    expect(String(job.error).length).toBeGreaterThan(0);

    async function issueKeyFor(kbId: string): Promise<string> {
      const r = await fetch(`${BASE}/v1/keys`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ label: `us2f-key-${UNIQUE}-${kbId}`, write_kb: kbId, read_kbs: [kbId] }),
      });
      return (await r.json()).key;
    }
  }, 360_000);
});
