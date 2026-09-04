/**
 * gbrain-rag 本地 MCP 网关检索压力测试。
 * 用法：BASE_URL=... ADMIN_TOKEN=... bun scripts/load/perf-mcp.ts <KB>
 * 形态：stateless tools/call（MCP Streamable HTTP，无 session），经网关 → 引擎检索。
 */
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.ADMIN_TOKEN ?? "local-dev-token-0123456789";
const KB = process.argv[2];
if (!KB) { console.error("usage: perf-mcp.ts <kb-id>"); process.exit(1); }

// key 签发（写读绑 KB）
const mk = await fetch(`${BASE}/v1/keys`, {
  method: "POST", headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ label: `mcp-perf-${Date.now()}`, write_kb: KB, read_kbs: [KB], concurrency: 20 }),
});
const key = (await mk.json()).key as string;
console.log(`[mcp] KB=${KB} key issued`);

const queries = ["MCP", "检索", "测试", "内容", "知识", "文档", "压力", "网关"];
function mcpCall(i: number, name: string) {
  return fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "X-API-Key": key, "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name, arguments: { query: queries[i % queries.length]!, source_id: KB } } }),
    signal: AbortSignal.timeout(30_000),
  });
}

const pct = (l: number[], p: number) => { if (!l.length) return 0; const s = [...l].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

async function stage(name: string, workers: number, durationMs: number): Promise<void> {
  const st = { n: 0, err: 0, lats: [] as number[], status: {} as Record<number, number>, start: Date.now() };
  const deadline = Date.now() + durationMs;
  let next = 0;
  const worker = async () => {
    while (Date.now() < deadline) {
      const i = next++;
      const t0 = performance.now();
      try {
        const r = await mcpCall(i, name === "search" ? "search" : "query");
        st.status[r.status] = (st.status[r.status] ?? 0) + 1;
        if (r.status === 200) {
          st.lats.push(performance.now() - t0);
          const body = await r.text();
          if (!body.includes("data:")) st.err++;
        } else {
          const body = await r.text().catch(() => "");
          if (st.status[r.status] === 1) console.log(`[diag] ${r.status} body: ${body.slice(0, 120)}`);
          st.err++;
        }
      } catch { st.err++; }
      st.n++;
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  const dur = (Date.now() - st.start) / 1000;
  const errRate = st.err / (st.n || 1);
  console.log(`[${name}@${workers}] n=${st.n} rps=${(st.n / dur).toFixed(1)} err=${st.err}(${(errRate * 100).toFixed(1)}%) | p50=${pct(st.lats, 50).toFixed(0)}ms p95=${pct(st.lats, 95).toFixed(0)}ms p99=${pct(st.lats, 99).toFixed(0)}ms | ${Object.entries(st.status).map(([k, v]) => `${k}:${v}`).join(" ")}`);
}

console.log("== MCP query 检索压测 ==");
for (const [w, d] of [[5, 30_000], [15, 30_000]] as Array<[number, number]>) await stage("query", w, d);
console.log("== MCP search 检索压测 ==");
for (const [w, d] of [[5, 30_000], [15, 30_000]] as Array<[number, number]>) await stage("search", w, d);

// 清理 key
const list = await (await fetch(`${BASE}/v1/keys`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json();
for (const k of (list as Array<{ label: string; id: string }>)) {
  if (k.label.startsWith("mcp-perf-")) await fetch(`${BASE}/v1/keys/${k.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${ADMIN}` } });
}
console.log("[mcp] key cleaned");
