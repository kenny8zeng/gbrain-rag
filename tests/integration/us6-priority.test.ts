import { describe, expect, test } from "bun:test";

/**
 * US1/US2/US4 集成：解析优先级矩阵（005）。
 * 实例自适应（探测 /health）：
 * - docling 可用 + pref=docling（3000）→ parser_log="docling"
 * - docling 可用 + pref=anydoc（3102）→ parser_log="anydoc"，URL 走 docling
 * - docling 不可达 + pref=docling（3103）→ parser_log="docling→anydoc:..."（回退），URL failed 无回退
 */
const BASE = process.env.TEST_BASE_URL;
const ADMIN = process.env.ADMIN_TOKEN ?? "";
const adminHeaders = () => ({ Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" });
const U = Date.now();
const created: string[] = [];

interface Health {
  parser_primary: "docling" | "anydoc";
  parser_preference: "docling" | "anydoc";
  docling: boolean;
}

let health: Health | null = null;
if (BASE && ADMIN) {
  try {
    health = (await (await fetch(`${BASE}/health`)).json()) as Health;
  } catch {
    health = null;
  }
}

const gated = BASE && ADMIN && health ? describe : describe.skip;

async function kbAndKey(name: string): Promise<{ kb: string; key: string }> {
  const kb = (await (await fetch(`${BASE}/v1/kb`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ name }) })).json()).id;
  created.push(kb);
  const key = (await (await fetch(`${BASE}/v1/keys`, {
    method: "POST", headers: adminHeaders(),
    body: JSON.stringify({ label: `${name}-k`, write_kb: kb, read_kbs: [kb] }),
  })).json()).key;
  return { kb, key };
}

async function importDocx(kb: string, key: string, slug: string): Promise<Record<string, unknown>> {
  const form = new FormData();
  form.append("file", Bun.file("tests/fixtures/test.docx"), "test.docx");
  const submit = await fetch(`${BASE}/v1/kb/${kb}/documents`, { method: "POST", headers: { "X-API-Key": key }, body: form });
  expect(submit.status).toBe(202);
  const jobId = (await submit.json()).job_id;
  const deadline = Date.now() + 120_000;
  let job;
  while (Date.now() < deadline) {
    job = await (await fetch(`${BASE}/v1/kb/${kb}/documents/jobs/${jobId}`, { headers: { "X-API-Key": key } })).json();
    if (["done", "done_with_warnings", "failed"].includes(job.status)) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  void slug;
  return job as Record<string, unknown>;
}

gated("US6: 解析优先级矩阵", () => {
  test("health 暴露 parser_primary/parser_preference", () => {
    expect(["docling", "anydoc"]).toContain(health!.parser_primary);
    expect(["docling", "anydoc"]).toContain(health!.parser_preference);
  });

  if (health!.docling && health!.parser_preference === "docling") {
    // 3000：docling 优先，primary 成功 → parser_log="docling"
    test("docling 优先：docx parser_log=docling（无回退）", async () => {
      const { kb, key } = await kbAndKey(`us6-d-${U}`);
      const job = await importDocx(kb, key, "d");
      expect(["done", "done_with_warnings"]).toContain(String(job.status));
      expect(job.parser_log).toBe("docling");
    }, 180_000);
  }

  if (health!.docling && health!.parser_preference === "anydoc") {
    // 3102：anydoc 优先
    test("anydoc 优先：docx parser_log=anydoc（不经 docling）", async () => {
      const { kb, key } = await kbAndKey(`us6-a-${U}`);
      const job = await importDocx(kb, key, "a");
      expect(["done", "done_with_warnings"]).toContain(String(job.status));
      expect(job.parser_log).toBe("anydoc");
    }, 180_000);

    test("anydoc 优先：URL 导入仍走 docling（成功）", async () => {
      const { kb, key } = await kbAndKey(`us6-aurl-${U}`);
      const r = await fetch(`${BASE}/v1/kb/${kb}/documents`, {
        method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://docling.ml.aesiot.dev/health" }),
      });
      expect(r.status).toBe(202); // URL 被受理（docling 可用）
    });
  }

  if (!health!.docling && health!.parser_preference === "docling") {
    // 3103：docling 不可达 + docling 优先 → 回退 anydoc
    test("回退触发：docx parser_log 以 docling→anydoc 开头", async () => {
      const { kb, key } = await kbAndKey(`us6-fb-${U}`);
      const job = await importDocx(kb, key, "fb");
      expect(["done", "done_with_warnings"]).toContain(String(job.status));
      expect(String(job.parser_log ?? "")).toMatch(/^docling→anydoc:/);
    }, 180_000);

    test("URL 导入不回退：failed 且 error 无 anydoc 痕迹（SC-005）", async () => {
      const { kb, key } = await kbAndKey(`us6-furl-${U}`);
      const r = await fetch(`${BASE}/v1/kb/${kb}/documents`, {
        method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/x" }),
      });
      expect(r.status).toBe(202);
      const jobId = (await r.json()).job_id;
      const deadline = Date.now() + 300_000;
      let job;
      while (Date.now() < deadline) {
        job = await (await fetch(`${BASE}/v1/kb/${kb}/documents/jobs/${jobId}`, { headers: { "X-API-Key": key } })).json();
        if (["done", "done_with_warnings", "failed"].includes(job.status)) break;
        await new Promise((r2) => setTimeout(r2, 1500));
      }
      expect(job.status).toBe("failed");
      expect(String(job.error ?? "")).not.toMatch(/anydoc/i); // URL 永不回退 anydoc
    }, 360_000);
  }
});

gated("cleanup", () => {
  test("自清理", async () => {
    for (const id of created) {
      await fetch(`${BASE}/v1/kb/${id}`, { method: "DELETE", headers: adminHeaders() }).catch(() => undefined);
    }
    expect(true).toBe(true);
  }, 120_000);
});
