/**
 * T046 规模核验（轻量级）：
 * - 建库 20 个，每库导入 1 篇 MD
 * - 10 路并发检索 × 20 轮，统计 P95 时延（SC-002 / SC-004 并发维度）
 * 运行：TEST_BASE_URL=... ADMIN_TOKEN=... bun scripts/scale-check.ts
 */
const BASE = process.env.TEST_BASE_URL;
const ADMIN = process.env.ADMIN_TOKEN;
if (!BASE || !ADMIN) {
  console.error("需要 TEST_BASE_URL 与 ADMIN_TOKEN");
  process.exit(1);
}
const H = { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" };
const KB_COUNT = 20;
const UNIQUE = Date.now();

const kbIds: string[] = [];
const keys: string[] = [];
for (let i = 0; i < KB_COUNT; i++) {
  const kb = await (await fetch(`${BASE}/v1/kb`, { method: "POST", headers: H, body: JSON.stringify({ name: `scale-${UNIQUE}-${i}` }) })).json();
  kbIds.push(kb.id);
  const key = await (
    await fetch(`${BASE}/v1/keys`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ label: `scale-${UNIQUE}-${i}`, write_kb: kb.id, read_kbs: [kb.id] }),
    })
  ).json();
  keys.push(key.key);
}
console.log(`created ${kbIds.length} kbs + keys`);

// 每库导入 1 篇（并行）
await Promise.all(
  kbIds.map((kb, i) =>
    fetch(`${BASE}/v1/kb/${kb}/documents`, {
      method: "POST",
      headers: { "X-API-Key": keys[i], "Content-Type": "text/markdown", "X-Slug": "scale-doc" },
      body: `# scale ${i}\nscale marker ${UNIQUE} 第 ${i} 篇内容`,
    }),
  ),
);

// 等全部任务终态
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  const jobs = await (await fetch(`${BASE}/v1/jobs`, { headers: H })).json();
  const pending = jobs.jobs.filter((j: { status: string }) => ["queued", "running"].includes(j.status));
  if (pending.length === 0) break;
  await new Promise((r) => setTimeout(r, 1500));
}
console.log("ingest settled");

// 10 路并发检索 × 20 轮
const latencies: number[] = [];
for (let round = 0; round < 20; round++) {
  const results = await Promise.all(
    kbIds.map(async (kb, i) => {
      const t0 = performance.now();
      const r = await fetch(`${BASE}/v1/kb/${kb}/retrieval`, {
        method: "POST",
        headers: { "X-API-Key": keys[i], "Content-Type": "application/json" },
        body: JSON.stringify({ query: "scale marker", mode: "keyword" }),
      });
      const ms = performance.now() - t0;
      return { ms, ok: r.status === 200 };
    }),
  );
  for (const r of results) {
    if (!r.ok) throw new Error("retrieval failed during scale run");
    latencies.push(r.ms);
  }
}
latencies.sort((a, b) => a - b);
const p50 = latencies[Math.floor(latencies.length * 0.5)];
const p95 = latencies[Math.floor(latencies.length * 0.95)];
console.log(JSON.stringify({ samples: latencies.length, p50: +p50.toFixed(1), p95: +p95.toFixed(1) }));
