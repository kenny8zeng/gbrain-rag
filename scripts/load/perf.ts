/**
 * gbrain-rag 生产实例压力测试（Zeabur）。
 * 用法：
 *   BASE_URL=<...> ADMIN_TOKEN=<...> bun scripts/load/perf.ts setup   # 建 perf 资源+预置
 *   BASE_URL=... ADMIN_TOKEN=... bun scripts/load/perf.ts run [--mcp] [--long]
 *   BASE_URL=... ADMIN_TOKEN=... bun scripts/load/perf.ts cleanup      # 归档 KB/吊销 key
 * 护栏：错误率>5% / P99>10s / degraded 非空 / 上游 429 连续 → 停。
 */
import { randomBytes } from "node:crypto";

const BASE = process.env.BASE_URL!;
const ADMIN = process.env.ADMIN_TOKEN!;
const TS = Date.now();
const P = `perf-${TS}`;
const A = (): Record<string, string> => ({ Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" });
const j = (r: Response) => r.json() as Promise<Record<string, unknown>>;

async function api(path: string, init?: RequestInit, tries = 2): Promise<{ status: number; body: any }> {
  let last: unknown;
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(60_000) });
      return { status: r.status, body: await r.json().catch(() => null) };
    } catch (e) {
      last = e;
      await Bun.sleep(1_500 * (t + 1));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

// ---------- setup ----------
async function setup(): Promise<{ kb: string; readKeys: string[]; writeKey: string }> {
  const kb = ((await api("/v1/kb", { method: "POST", headers: A(), body: JSON.stringify({ name: P, description: "load test" }) })).body as any).id as string;
  console.log(`[setup] KB=${kb}`);

  const mkKey = async (label: string, write: string | null, concurrency: number) => {
    const r = await api("/v1/keys", {
      method: "POST", headers: A(),
      body: JSON.stringify({ label, write_kb: write, read_kbs: write ? [kb] : [kb], concurrency }),
    });
    if (r.status !== 201) throw new Error(`key ${label} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return (r.body as any).key as string;
  };
  // write_kb 必填非空 string：读/写测试 key 均绑 perf-kb（隔离面由独立 KB 保证）
  const readKeys: string[] = [];
  for (let i = 0; i < 8; i++) readKeys.push(await mkKey(`${P}-r${i}`, kb, 10));
  const writeKey = await mkKey(`${P}-w`, kb, 5);
  console.log(`[setup] keys: 8 read (concurrency 10) + 1 write`);

  // 预置 ~200 页面（md 直通 + embed）
  const words = ["知识管理", "检索增强", "向量数据库", "文档解析", "权限隔离", "MCP 网关", "异步任务", "模型探测", "双解析器", "凭证生命周期"];
  const docs = Array.from({ length: 200 }, (_, i) => {
    const n = 3 + (i % 5);
    const lines = Array.from({ length: n }, () => words[Math.floor(Math.random() * words.length)]).join("，");
    return `# 文档 ${i}\n\n${lines}。本段用于检索命中测试。\n\n更多内容：${words.slice(0, 2 + (i % 3)).join("、")}。\n`;
  });
  let done = 0, failed = 0;
  const pool: Promise<void>[] = [];
  const CONC = 8;
  for (let i = 0; i < docs.length; i++) {
    const body = docs[i];
    const f = (async () => {
      try {
        const r = await fetch(`${BASE}/v1/kb/${kb}/documents`, {
          method: "POST",
          headers: { "X-API-Key": writeKey, "Content-Type": "text/markdown", "X-Slug": `perf-${i}` },
          body,
          signal: AbortSignal.timeout(60_000),
        });
        if (r.status >= 200 && r.status < 300) done++; else failed++;
      } catch { failed++; }
    })();
    pool.push(f);
    if (pool.length >= CONC) { await Promise.all(pool); pool.length = 0; }
  }
  await Promise.all(pool);
  console.log(`[setup] ingest submitted: ok=${done} failed=${failed}; awaiting embed…`);
  await Bun.sleep(20_000);
  // 预检
  const q = await fetch(`${BASE}/v1/kb/${kb}/retrieval`, {
    method: "POST", headers: { "X-API-Key": readKeys[0]!, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "知识管理", mode: "keyword", top_k: 3 }),
  });
  const qj = await q.json();
  console.log(`[setup] probe keyword: status=${q.status} hits=${(qj as any).results?.length ?? 0} degraded=${JSON.stringify((qj as any).degraded)}`);
  return { kb, readKeys, writeKey };
}

// ---------- load engine ----------
interface Stats { n: number; err: number; status: Record<number, number>; degraded: number; lats: number[]; start: number; stop: boolean }
function newStats(): Stats { return { n: 0, err: 0, status: {}, degraded: 0, lats: [], start: Date.now(), stop: false }; }

async function bench(
  name: string,
  run: (i: number) => Promise<void>,
  workers: number,
  durationMs: number,
  out: Stats,
  guard: (st: Stats) => string | null,
): Promise<Stats> {
  const deadline = Date.now() + durationMs;
  let next = 0;
  const worker = async () => {
    while (Date.now() < deadline && !out.stop) {
      const i = next++;
      const t0 = performance.now();
      try {
        await run(i);
        out.lats.push(performance.now() - t0);
      } catch (e) {
        out.err++;
      }
      out.n++;
      const g = guard(out);
      if (g) { out.stop = true; console.log(`[guard] ${name} STOP: ${g}`); return; }
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  return out;
}

function pct(lats: number[], p: number): number {
  if (!lats.length) return 0;
  const s = [...lats].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function report(name: string, st: Stats): void {
  const dur = (Date.now() - st.start) / 1000;
  const status = Object.entries(st.status).map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(
    `[${name}] n=${st.n} rps=${(st.n / dur).toFixed(1)} err=${st.err} degraded=${st.degraded} | p50=${pct(st.lats, 50).toFixed(0)}ms p95=${pct(st.lats, 95).toFixed(0)}ms p99=${pct(st.lats, 99).toFixed(0)}ms | ${status}`,
  );
}

function guard(st: Stats): string | null {
  const total = st.n || 1;
  const errRate = (st.err + st.degraded) / total;
  if (errRate > 0.05) return `error rate ${(errRate * 100).toFixed(1)}% > 5%`;
  if (pct(st.lats, 99) > 10_000 && st.n > 20) return `p99 ${pct(st.lats, 99).toFixed(0)}ms > 10s`;
  return null;
}

async function retrievalBench(cfg: { kb: string; keys: string[]; mode: string; workers: number; durationMs: number; out: Stats }): Promise<void> {
  const queries = ["知识管理", "向量数据库 检索", "文档解析 权限", "MCP 网关 凭证", "异步任务 模型"];
  const bench_ = await bench(
    `retrieval-${cfg.mode}`,
    async (i) => {
      const r = await fetch(`${BASE}/v1/kb/${cfg.kb}/retrieval`, {
        method: "POST",
        headers: { "X-API-Key": cfg.keys[i % cfg.keys.length]!, "Content-Type": "application/json" },
        body: JSON.stringify({ query: queries[i % queries.length]!, mode: cfg.mode as any, top_k: 5 }),
      });
      cfg.out.status[r.status] = (cfg.out.status[r.status] ?? 0) + 1;
      if (r.status === 200) {
        const b = (await r.json()) as { degraded?: string[] };
        if (b.degraded?.length) cfg.out.degraded++;
      } else if (r.status >= 500 || r.status === 429) {
        throw new Error(`retrieval HTTP ${r.status}`);
      }
    },
    cfg.workers,
    cfg.durationMs,
    cfg.out,
    guard,
  );
  report(`retrieval-${cfg.mode}`, bench_);
}

// ---------- run ----------
async function run(opts: { mcp: boolean; mcpOnly: boolean; ingest: boolean; long: boolean }): Promise<void> {
  const setupRes = await setup();
  const { kb, readKeys, writeKey } = setupRes;
  try {
    // T0 预热
    console.log("\n== T0 warmup ==");
    for (let i = 0; i < 5; i++) {
      await fetch(`${BASE}/v1/kb/${kb}/retrieval`, {
        method: "POST", headers: { "X-API-Key": readKeys[0]!, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "知识管理", mode: "keyword", top_k: 3 }),
      });
    }

    // T1a keyword 阶梯（--mcp-only 跳过）
    if (!opts.mcpOnly) {
    console.log("\n== T1a keyword 阶梯 ==");
    for (const [w, dur] of [[5, 30_000], [15, 30_000], [30, 30_000]] as Array<[number, number]>) {
      if (process.env.STOP === "1") break;
      await retrievalBench({ kb, keys: readKeys, mode: "keyword", workers: w, durationMs: dur, out: newStats() });
    }

    }
    // T1b hybrid 阶梯
    if (!opts.mcpOnly) {
    console.log("\n== T1b hybrid 阶梯 ==");
    for (const [w, dur] of [[3, 30_000], [8, 30_000], [15, 30_000]] as Array<[number, number]>) {
      if (process.env.STOP === "1") break;
      await retrievalBench({ kb, keys: readKeys, mode: "hybrid", workers: w, durationMs: dur, out: newStats() });
    }

    }
    // T2 摄取压力（100 文档批量）
    if (opts.ingest && !opts.mcpOnly) {
      console.log("\n== T2 ingest 压力 ==");
      const st = newStats();
      let sent = 0, failed = 0;
      const word = "压力测试文档";
      for (let round = 0; round < 3; round++) {
        const pool: Promise<void>[] = [];
        for (let i = 0; i < 100; i++) {
          const f = (async () => {
            const r = await fetch(`${BASE}/v1/kb/${kb}/documents`, {
              method: "POST",
              headers: { "X-API-Key": writeKey, "Content-Type": "text/markdown", "X-Slug": `load-${round}-${i}` },
              body: `# ${word} ${round}-${i}\n\n${word} 内容片段 ${i}：${word}重复填充用于摄取吞吐观察。\n`,
            });
            st.status[r.status] = (st.status[r.status] ?? 0) + 1;
            if (r.status === 202) sent++; else failed++;
          })();
          pool.push(f);
          if (pool.length >= 8) { await Promise.all(pool); pool.length = 0; }
        }
        await Promise.all(pool);
        console.log(`[T2] round ${round}: sent=${sent} failed=${failed}`);
      }
      // 等待队列消化并统计完成
      await Bun.sleep(20_000);
      const jobs = await api("/v1/jobs?status=done");
      console.log(`[T2] jobs(done) total: ${Array.isArray((jobs.body as any).jobs) ? (jobs.body as any).jobs.length : "?"}`);
      report("ingest-submit", st);
    }

    // T4 MCP（可选）：Streamable HTTP 需 initialize 握手 → 会话 → tools/call
    if (opts.mcp) {
      console.log("\n== T4 MCP ==");
      const st = newStats();
      const sessions: Array<{ key: string; sid: string | null }> = [];
      const mkSession = async (key: string) => {
        const r = await fetch(`${BASE}/mcp`, {
          method: "POST",
          headers: { "X-API-Key": key, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "perf", version: "1.0" } } }),
          signal: AbortSignal.timeout(30_000),
        });
        const sid = r.headers.get("mcp-session-id");
        if (sid) {
          await fetch(`${BASE}/mcp`, {
            method: "POST",
            headers: { "X-API-Key": key, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": sid },
            body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
            signal: AbortSignal.timeout(15_000),
          });
        }
        sessions.push({ key, sid });
      };
      for (const k of readKeys.slice(0, 6)) await mkSession(k);
      console.log(`[T4] sessions: ${sessions.length}`);
      await bench(
        "mcp",
        async (i) => {
          const s = sessions[i % sessions.length]!;
          const r = await fetch(`${BASE}/mcp`, {
            method: "POST",
            headers: {
              "X-API-Key": s.key, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
              ...(s.sid ? { "mcp-session-id": s.sid } : {}),
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "search", arguments: { query: "知识管理", source_id: cfg.kb } } }),
            signal: AbortSignal.timeout(30_000),
          });
          st.status[r.status] = (st.status[r.status] ?? 0) + 1;
          if (r.status === 200 || r.status === 202) {
            const b = await r.json().catch(() => null) as { degraded?: string[] } | null;
            if (b && Array.isArray(b.degraded) && b.degraded.length) st.degraded++;
          } else if (r.status >= 500 || r.status === 429 || r.status === 406) {
            throw new Error(`mcp HTTP ${r.status}`);
          }
        },
        8,
        60_000,
        st,
        guard,
      );
      report("mcp", st);
    }
  } finally {
    await cleanup(kb);
  }
}

// ---------- cleanup ----------
async function cleanup(kb?: string): Promise<void> {
  const keys = await api("/v1/keys");
  const list = Array.isArray((keys.body as any)) ? (keys.body as any) : [];
  for (const k of list) {
    if (String(k.label).startsWith(P) || String(k.label).startsWith("perf-")) {
      await api(`/v1/keys/${k.id}`, { method: "DELETE", headers: A() }).catch(() => undefined);
    }
  }
  if (!kb) {
    const kbs = await api("/v1/kb");
    const bl = Array.isArray((kbs.body as any)) ? (kbs.body as any) : [];
    for (const b of bl) {
      if (String(b.name).startsWith("perf-")) {
        await api(`/v1/kb/${b.id}`, { method: "DELETE", headers: A(), body: JSON.stringify({ force: true }) }).catch(() => undefined);
      }
    }
  } else {
    await api(`/v1/kb/${kb}`, { method: "DELETE", headers: A(), body: JSON.stringify({ force: true }) }).catch(() => undefined);
  }
  console.log(`[cleanup] perf resources archived/revoked (kb=${kb ?? "scan-all"})`);
}

// ---------- main ----------
const cmd = process.argv[2] ?? "run";
try {
if (cmd === "setup") {
  const r = await setup();
  console.log(`[setup-done] KB=${r.kb}`);
} else if (cmd === "run") {
  await run({ mcp: process.argv.includes("--mcp"), mcpOnly: process.argv.includes("--mcp-only"), ingest: process.argv.includes("--ingest"), long: process.argv.includes("--long") });
} else if (cmd === "cleanup") {
  await cleanup();
} else {
  console.error("usage: perf.ts setup|run [--mcp] [--ingest] [--long]|cleanup");
  process.exit(1);
}
} catch (e) {
  console.error(`[fatal] ${(e as Error).message ?? e}`);
  process.exit(2);
}
