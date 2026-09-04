/**
 * gbrain-rag 本地压测（anydoc-only + 真实文档）。
 * 用法：
 *   BASE_URL=http://localhost:3000 ADMIN_TOKEN=local-dev-token-0123456789 \
 *   DOCS_DIR=/root/tmp/测试文档 bun scripts/load/perf-local.ts run
 * 护栏：错误率>5% / P99>10s / degraded → 停。压测后自动清理 perf-* 资源。
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.ADMIN_TOKEN ?? "local-dev-token-0123456789";
const DOCS = process.env.DOCS_DIR ?? "/root/tmp/测试文档";
const TS = Date.now();
const P = `perf-${TS}`;
const A = () => ({ Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" });

const SUPPORTED = new Set([".md", ".txt", ".docx", ".doc", ".pdf", ".pptx", ".xlsx", ".md"]);
const MAX_FILE = 2.5 * 1024 * 1024; // 预置集单文件上限（控制 embed 成本与转换时间）

function collectDocs(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (SUPPORTED.has(extname(e).toLowerCase()) && st.size <= MAX_FILE) out.push(p);
    }
  };
  walk(DOCS);
  return out.sort();
}

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(120_000) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function setup(docs: string[]): Promise<{ kb: string; keys: string[]; writeKey: string; ingested: string[] }> {
  const kb = ((await api("/v1/kb", { method: "POST", headers: A(), body: JSON.stringify({ name: P }) })).body as any).id as string;
  console.log(`[setup] KB=${kb}`);
  const mkKey = async (label: string, concurrency: number) => {
    const r = await api("/v1/keys", { method: "POST", headers: A(), body: JSON.stringify({ label, write_kb: kb, read_kbs: [kb], concurrency }) });
    if (r.status !== 201) throw new Error(`key ${label}: ${r.status}`);
    return (r.body as any).key as string;
  };
  const keys: string[] = [];
  for (let i = 0; i < 8; i++) keys.push(await mkKey(`${P}-r${i}`, 10));
  const writeKey = await mkKey(`${P}-w`, 4);

  console.log(`[setup] ingesting ${docs.length} real docs (anydoc, multipart)…`);
  const ingested: string[] = [];
  let fail = 0;
  const CONC = 4;
  let idx = 0;
  const pool: Promise<void>[] = [];
  for (const p of docs) {
    const name = p.split("/").slice(-2).join("_").replace(/[^\w.\u4e00-\u9fa5-]+/g, "_");
    const f = (async () => {
      try {
        const form = new FormData();
        form.append("file", new Blob([readFileSync(p)], { type: "application/octet-stream" }), name);
        const r = await fetch(`${BASE}/v1/kb/${kb}/documents`, {
          method: "POST", headers: { "X-API-Key": writeKey }, body: form,
          signal: AbortSignal.timeout(120_000),
        });
        if (r.status === 202) ingested.push(name); else { fail++; console.log(`  fail ${name}: HTTP ${r.status}`); }
      } catch (e) { fail++; console.log(`  fail ${name}: ${(e as Error).message.slice(0, 80)}`); }
    })();
    pool.push(f);
    if (++idx % CONC === 0) { await Promise.all(pool); pool.length = 0; }
  }
  await Promise.all(pool);
  console.log(`[setup] ingested=${ingested.length} failed=${fail}; awaiting embed…`);
  await Bun.sleep(15_000);
  // 检索预检（任一 key）
  const q = await fetch(`${BASE}/v1/kb/${kb}/retrieval`, {
    method: "POST", headers: { "X-API-Key": keys[0]!, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "测试 文档 内容", mode: "keyword", top_k: 5 }),
  });
  const qj = (await q.json()) as { results?: unknown[]; degraded?: string[] };
  console.log(`[setup] probe keyword: status=${q.status} hits=${qj.results?.length ?? 0} degraded=${JSON.stringify(qj.degraded)}`);
  return { kb, keys, writeKey, ingested };
}

// ---- 检索压测（复用统计引擎）----
function guard(st: { n: number; err: number; degraded: number; lats: number[] }): string | null {
  const errRate = (st.err + st.degraded) / (st.n || 1);
  if (errRate > 0.05) return `error rate ${(errRate * 100).toFixed(1)}% > 5%`;
  if (pct(st.lats, 99) > 10_000 && st.n > 20) return `p99 ${pct(st.lats, 99).toFixed(0)}ms > 10s`;
  return null;
}
function pct(l: number[], p: number): number {
  if (!l.length) return 0;
  const s = [...l].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function report(name: string, st: { n: number; err: number; degraded: number; lats: number[]; status: Record<number, number>; start: number }): void {
  const dur = (Date.now() - st.start) / 1000;
  console.log(`[${name}] n=${st.n} rps=${(st.n / dur).toFixed(1)} err=${st.err} degraded=${st.degraded} | p50=${pct(st.lats, 50).toFixed(0)}ms p95=${pct(st.lats, 95).toFixed(0)}ms p99=${pct(st.lats, 99).toFixed(0)}ms | ${Object.entries(st.status).map(([k, v]) => `${k}:${v}`).join(" ")}`);
}

async function retrievalStage(kb: string, keys: string[], mode: "keyword" | "hybrid", workers: number, durationMs: number): Promise<void> {
  const st = { n: 0, err: 0, degraded: 0, lats: [] as number[], status: {} as Record<number, number>, start: Date.now() };
  const queries = ["小龙虾头", "初中化学 实验现象", "历史 默写", "地理小测", "物理 暑假作业", "AI 模型", "报价单"];
  const deadline = Date.now() + durationMs;
  let next = 0;
  const worker = async () => {
    while (Date.now() < deadline) {
      const i = next++;
      const t0 = performance.now();
      try {
        const r = await fetch(`${BASE}/v1/kb/${kb}/retrieval`, {
          method: "POST",
          headers: { "X-API-Key": keys[i % keys.length]!, "Content-Type": "application/json" },
          body: JSON.stringify({ query: queries[i % queries.length]!, mode, top_k: 5 }),
          signal: AbortSignal.timeout(30_000),
        });
        st.status[r.status] = (st.status[r.status] ?? 0) + 1;
        if (r.status === 200) {
          st.lats.push(performance.now() - t0);
          const b = (await r.json()) as { degraded?: string[] };
          if (b.degraded?.length) st.degraded++;
        } else st.err++;
      } catch { st.err++; }
      st.n++;
      const g = guard(st);
      if (g) { console.log(`[guard] ${mode}@${workers}: ${g}`); return; }
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  report(`${mode}@${workers}`, st);
}

async function cleanup(kb: string): Promise<void> {
  const keys = await api("/v1/keys");
  const list = Array.isArray(keys.body) ? keys.body : [];
  for (const k of list) if (String(k.label).startsWith(P)) await api(`/v1/keys/${k.id}`, { method: "DELETE", headers: A() }).catch(() => undefined);
  await api(`/v1/kb/${kb}`, { method: "DELETE", headers: A(), body: JSON.stringify({ force: true }) }).catch(() => undefined);
  console.log(`[cleanup] ${P} archived/revoked`);
}

const docs = collectDocs();
console.log(`[docs] ${docs.length} files (≤${MAX_FILE / 1048576}MB) from ${DOCS}`);
const s = await setup(docs);
try {
  // T1 keyword 阶梯（本地纯引擎吞吐——无上游）
  for (const [w, d] of [[5, 30_000], [15, 30_000], [30, 30_000], [50, 30_000]] as Array<[number, number]>) {
    if (process.env.STOP === "1") break;
    await retrievalStage(s.kb, s.keys, "keyword", w, d);
  }
  // T2 hybrid（含上游 embed/rerank——网络受限）
  for (const [w, d] of [[3, 30_000], [10, 30_000]] as Array<[number, number]>) {
    if (process.env.STOP === "1") break;
    await retrievalStage(s.kb, s.keys, "hybrid", w, d);
  }
} finally {
  await cleanup(s.kb);
}
