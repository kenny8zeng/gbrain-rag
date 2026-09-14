import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 009 批量导入集成：tar 归档 → 服务端 slug 归位 + 实体页派生 → 单次 import + 建边。
 * 验证：dry_run 映射、导入落库、实体页与边、幂等续传、zst 格式、冲突/无md/不安全归档的拒绝。
 */
const BASE = process.env.TEST_BASE_URL;
const ADMIN = process.env.ADMIN_TOKEN ?? "";
const gated = BASE && ADMIN ? describe : describe.skip;

const CORPUS: Array<{ name: string; body: string }> = [
  { name: "corpus/en/docs/brake.md", body: "# Brake Guide\n\nSee [[Brake]] and [[Soleil01]].\n" },
  { name: "corpus/en/faq/script.md", body: "Q&A script referencing [[Brake]].\n" },
  { name: "corpus/en/notes.txt", body: "not markdown\n" },
];

/** 用系统 tar 打包（format: gz 通用 / zst 需要 tar+zstd 支持）；返回归档字节，不支持时 null */
function makeArchive(format: "gz" | "zst"): Blob | null {
  const dir = mkdtempSync("/tmp/bulkit-");
  const outDir = mkdtempSync("/tmp/bulkit-"); // 归档放语料目录外，避免 tar 自包含
  try {
    for (const f of CORPUS) {
      const p = path.join(dir, f.name);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, f.body);
    }
    const out = path.join(outDir, `bulk.tar.${format}`);
    const args = format === "gz" ? ["-czf"] : ["--zstd", "-cf"];
    const r = Bun.spawnSync(["tar", ...args, out, "-C", dir, "."], { stdout: "ignore", stderr: "pipe" });
    if (r.exitCode !== 0) return null;
    return new Blob([readFileSync(out)]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
}

function makeArchiveWithSymlink(): Blob {
  const dir = mkdtempSync("/tmp/bulkit-");
  try {
    mkdirSync(path.join(dir, "corpus/docs"), { recursive: true });
    writeFileSync(path.join(dir, "corpus/docs/a.md"), "hi\n");
    Bun.spawnSync(["ln", "-s", "/etc/passwd", path.join(dir, "corpus/docs/evil")]);
    const out = path.join(dir, "u.tar");
    Bun.spawnSync(["tar", "-cf", out, "-C", dir, "."], { stdout: "ignore", stderr: "ignore" });
    return new Blob([readFileSync(out)]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function postBulk(kb: string, key: string, archive: Blob, opts: { dryRun?: boolean } = {}): Promise<{
  status: number;
  body: Record<string, unknown> & { error?: { code: string; message: string } };
}> {
  const fd = new FormData();
  fd.append("file", archive, "bulk.tar");
  if (opts.dryRun) fd.append("dry_run", "true");
  const r = await fetch(`${BASE}/v1/kb/${kb}/documents/bulk`, { method: "POST", headers: { "X-API-Key": key }, body: fd });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

async function waitJob(kb: string, key: string, jobId: string): Promise<{ status: string; result_summary: string | null }> {
  for (let i = 0; i < 90; i++) {
    const j = await fetch(`${BASE}/v1/kb/${kb}/documents/jobs/${jobId}`, { headers: { "X-API-Key": key } })
      .then((r) => r.json()) as { status: string; result_summary: string | null };
    if (["done", "done_with_warnings", "failed"].includes(j.status)) return j;
    await Bun.sleep(2000);
  }
  throw new Error("bulk job timeout");
}

gated("批量导入（009）", () => {
  let kb = `kb-${Date.now().toString(16).slice(-8)}`;
  let key = "";
  let keyId = "";

  afterAll(async () => {
    if (!keyId) return;
    await fetch(`${BASE}/v1/kb/${kb}?force=true`, { method: "DELETE", headers: { Authorization: `Bearer ${ADMIN}` } });
    await fetch(`${BASE}/v1/kb/${kb}/purge?force=true`, { method: "POST", headers: { Authorization: `Bearer ${ADMIN}` } });
    await fetch(`${BASE}/v1/keys/${keyId}`, { method: "DELETE", headers: { Authorization: `Bearer ${ADMIN}` } });
  });

  test("准备：建库 + 签 key", async () => {
    const created = await fetch(`${BASE}/v1/kb`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: `bulk-${Date.now()}` }),
    }).then((r) => r.json());
    expect(created.id).toBeTruthy();
    kb = created.id;
    const k = await fetch(`${BASE}/v1/keys`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ label: `bulk-${Date.now()}`, write_kb: created.id, read_kbs: [created.id] }),
    }).then((r) => r.json());
    key = k.key;
    keyId = k.id;
    expect(key).toStartWith("gbrag_");
  }, 60000);

  test("dry_run：返回 slug 映射，不导入", async () => {
    const archive = makeArchive("gz");
    expect(archive).not.toBeNull();
    const { status, body } = await postBulk(kb, key, archive!, { dryRun: true });
    expect(status).toBe(200);
    const files = body.files as Array<{ file: string; slug: string }>;
    expect(files).toHaveLength(2); // notes.txt 被跳过
    expect(files.map((f) => f.slug).sort()).toEqual([`${kb}/docs/en-docs-brake`, `${kb}/docs/en-faq-script`].sort());
    expect(body.entities).toBe(2); // Brake / Soleil01
    const skipped = body.skipped as Array<{ file: string; reason: string }>;
    expect(skipped.some((s) => s.reason === "not markdown")).toBe(true);
    // dry_run 不落库
    const docs = await fetch(`${BASE}/v1/kb/${kb}/documents`, { headers: { "X-API-Key": key } }).then((r) => r.json());
    expect((docs as { pages: unknown[] }).pages).toHaveLength(0);
  }, 120000);

  test("gz 归档导入：落库 + 实体页 + 图谱边", async () => {
    const archive = makeArchive("gz");
    const { status, body } = await postBulk(kb, key, archive!);
    expect(status).toBe(202);
    expect(body.files).toBe(2);
    expect(body.entities).toBe(2);
    const job = await waitJob(kb, key, body.job_id as string);
    expect(job.status).toBe("done");


    // 4 = 2 文档 + 2 实体页；边 = brake→brake / brake→soleil01 / script→brake
    const summary = JSON.parse(job.result_summary!) as {
      import: { imported: number; unchanged: number; errors: number };
      links: { created: number };
    };
    expect(summary.import.imported).toBe(4);
    expect(summary.import.errors).toBe(0);
    expect(summary.import.unchanged).toBe(0);
    const docs = await fetch(`${BASE}/v1/kb/${kb}/documents`, { headers: { "X-API-Key": key } }).then((r) => r.json());
    const slugs = (docs as { pages: Array<{ slug: string }> }).pages.map((p) => p.slug).sort();
    expect(slugs).toEqual([`${kb}/docs/en-docs-brake`, `${kb}/docs/en-faq-script`].sort());
    // 实体页与边（派生自双链目标）：从文档遍历应到达两个实体节点
    const tv = await fetch(`${BASE}/v1/kb/${kb}/graph/traverse?slug=${kb}/docs/en-docs-brake&depth=1`, {
      headers: { "X-API-Key": key },
    });
    expect(tv.status).toBe(200);
    const paths = ((await tv.json()) as { paths: Array<{ to_slug: string }> }).paths.map((p) => p.to_slug);
    expect(paths).toContain(`${kb}/entities/brake`);
    expect(paths).toContain(`${kb}/entities/soleil01`);
  }, 180000);

  test("重复导入同一归档：checkpoint 跳过未变更（幂等）", async () => {
    const archive = makeArchive("gz");
    const { status, body } = await postBulk(kb, key, archive!);
    expect(status).toBe(202);
    const job = await waitJob(kb, key, body.job_id as string);
    expect(job.status).toBe("done");
    // 字节稳定（无 converted_at）→ checkpoint 命中：零重导入、零重复 embed
    const summary = JSON.parse(job.result_summary!) as { import: { imported: number; unchanged: number; errors: number } };
    expect(summary.import.imported).toBe(0);
    expect(summary.import.unchanged).toBe(4);
    expect(summary.import.errors).toBe(0);
  }, 180000);

  test("slug 冲突归档 → 422（不静默覆盖）", async () => {
    const dir = mkdtempSync("/tmp/bulkit-");
    try {
      mkdirSync(path.join(dir, "c/docs"), { recursive: true });
      writeFileSync(path.join(dir, "c/docs/Brake-Noise.md"), "A\n");
      writeFileSync(path.join(dir, "c/docs/brake-noise.md"), "B\n");
      const out = path.join(dir, "c.tar");
      Bun.spawnSync(["tar", "-cf", out, "-C", dir, "c"], { stdout: "ignore", stderr: "ignore" });
      const { status, body } = await postBulk(kb, key, new Blob([readFileSync(out)]));
      expect(status).toBe(422);
      expect((body.error as { code: string }).code).toBe("SLUG_COLLISION");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  test("无有效 md 归档 → 422", async () => {
    const dir = mkdtempSync("/tmp/bulkit-");
    try {
      mkdirSync(path.join(dir, "c"), { recursive: true });
      writeFileSync(path.join(dir, "c/notes.txt"), "x\n");
      const out = path.join(dir, "c.tar");
      Bun.spawnSync(["tar", "-czf", out, "-C", dir, "c"], { stdout: "ignore", stderr: "ignore" });
      const { status, body } = await postBulk(kb, key, new Blob([readFileSync(out)]));
      expect(status).toBe(422);
      expect((body.error as { code: string }).code).toBe("NO_MARKDOWN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  test("含符号链接成员的归档 → 422（tar slip 防御）", async () => {
    const { status, body } = await postBulk(kb, key, makeArchiveWithSymlink());
    expect(status).toBe(422);
    expect((body.error as { code: string }).code).toBe("UNSAFE_ARCHIVE");
  }, 60000);

  test("tar.zst 归档（镜像支持 zstd 时）", async () => {
    const archive = makeArchive("zst");
    if (archive === null) {
      console.log("  (跳过：本机 tar 不支持 --zstd)");
      return;
    }
    const { status, body } = await postBulk(kb, key, archive);
    expect(status).toBe(202);
    const job = await waitJob(kb, key, body.job_id as string);
    expect(job.status).toBe("done");
  }, 180000);
});
