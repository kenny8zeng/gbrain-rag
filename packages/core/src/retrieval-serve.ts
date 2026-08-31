import type { Config } from "./config";
import type { Upstream } from "./gbrain-upstream";
import { runGbrain, runGbrainJson } from "./gbrain-cli";
import { normalizeHits, type RetrievalInput, type RetrievalResponse } from "./retrieval";

/**
 * T049：检索走常驻 gbrain serve --http 通道（消除逐请求 CLI 进程启动）。
 * - 内部只读 OAuth client（rag-internal-*）：--scopes read，federated-read 覆盖全部 kb-*
 * - 检索：JSON-RPC tools/call（search/query）经 Upstream 注入 Bearer，source_id 钉定 per-KB
 * - 建库/清除时 rescope 纳管/剔除（生命周期，CHK020）
 * - serve 通道故障 → 降级 CLI spawn 路径（CHK021）
 */
export class InternalRetrieval {
  private clientId: string | null = null;
  private clientSecret: string | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly upstream: Upstream,
  ) {}

  private async ensureClient(): Promise<{ clientId: string; clientSecret: string } | null> {
    if (this.clientId && this.clientSecret) return { clientId: this.clientId, clientSecret: this.clientSecret };
    // 取当前全部 kb-* 来源作为 federated-read 基础
    const all = await listKbSources(this.cfg);
    if (all.length === 0) return null; // 尚无知识库，首次建库时再注册
    const name = `rag-internal-${randomHex(6)}`;
    const output = await runGbrain(this.cfg, {
      args: [
        "auth", "register-client", name,
        "--grant-types", "client_credentials",
        "--scopes", "read",
        "--source", all[0],
        "--federated-read", all.join(","),
      ],
      timeoutMs: 60_000,
    }).then((r) => r.stdout);
    const id = /Client ID:\s+(\S+)/.exec(output)?.[1];
    const secret = /Client Secret:\s+(\S+)/.exec(output)?.[1];
    if (!id || !secret) throw new Error(`internal client registration failed: ${output.slice(0, 300)}`);
    this.clientId = id;
    this.clientSecret = secret;
    console.log(JSON.stringify({ evt: "internal_client", mode: "registered", sources: all.length }));
    return { clientId: id, clientSecret: secret };
  }

  /** 建库后纳管（CLI rescope，失败仅告警——federated-read 缺新库时该库检索降级 CLI） */
  async onKbCreated(kbId: string): Promise<void> {
    const creds = await this.ensureClient().catch(() => null);
    if (!creds) return; // 首次建库时 ensureClient 已含全部来源
    const all = await listKbSources(this.cfg);
    try {
      await runGbrain(this.cfg, {
        args: ["auth", "rescope-client", creds.clientId, "--federated-read", all.join(",")],
        timeoutMs: 60_000,
      });
      console.log(JSON.stringify({ evt: "internal_client", mode: "rescoped", sources: all.length }));
    } catch (e) {
      console.log(JSON.stringify({ evt: "internal_client", mode: "rescope_failed", error: (e as Error).message.slice(0, 200) }));
    }
  }

  /** 清除库后剔除（best-effort） */
  async onKbPurged(): Promise<void> {
    if (!this.clientId) return;
    const all = await listKbSources(this.cfg);
    try {
      await runGbrain(this.cfg, {
        args: ["auth", "rescope-client", this.clientId, "--federated-read", all.join(",")],
        timeoutMs: 60_000,
      });
    } catch {
      /* best-effort */
    }
  }

  /** serve 通道检索；失败抛错由调用方降级 */
  async retrieve(kbId: string, input: RetrievalInput): Promise<RetrievalResponse> {
    const creds = await this.ensureClient();
    if (!creds) throw new Error("internal client not ready (no kb sources)");
    const mode = input.mode ?? "hybrid";
    const tool = mode === "keyword" ? "search" : "query";
    const args: Record<string, unknown> = { query: input.query, source_id: kbId };
    if (input.topK && input.topK > 0) args.limit = Math.min(input.topK, 100);

    const text = await mcpToolsCall(this.cfg, this.upstream, creds, tool, args);
    const parsed = JSON.parse(text) as Array<Record<string, unknown>>;
    const hits = normalizeHits(Array.isArray(parsed) ? parsed : []);
    return { results: hits, mode, degraded: [] };
  }
}

async function listKbSources(cfg: Config): Promise<string[]> {
  const j = await runGbrainJson<{ sources?: Array<{ id: string }> }>(cfg, {
    args: ["sources", "list"],
    timeoutMs: 30_000,
  });
  return (j.sources ?? []).map((s) => s.id).filter((id) => /^kb-[0-9a-f]{8}$/.test(id)).sort();
}

/** 经 Upstream 注入内部 client Bearer 后执行 JSON-RPC tools/call（带 initialize 兜底） */
async function mcpToolsCall(
  cfg: Config,
  upstream: Upstream,
  creds: { clientId: string; clientSecret: string },
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const base = `http://127.0.0.1:${cfg.GBRAIN_SERVE_PORT}`;
  const call = (withSession: string | null) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (withSession) headers["mcp-session-id"] = withSession;
    return new Request(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    });
  };

  let res = await upstream.proxy("/mcp", creds, call(null));
  if (res.status !== 200) {
    // 会话兜底：initialize 后重试
    const initReq = new Request(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "gbrain-rag-internal", version: "1" } } }),
    });
    const initRes = await upstream.proxy("/mcp", creds, initReq);
    if (initRes.status !== 200) throw new Error(`mcp initialize failed: ${initRes.status}`);
    const session = initRes.headers.get("mcp-session-id");
    res = await upstream.proxy("/mcp", creds, call(session));
  }
  if (res.status !== 200) throw new Error(`mcp tools/call failed: ${res.status}`);

  const body = await res.text();
  const dataLine = body.split("\n").find((l) => l.startsWith("data: "));
  const json = JSON.parse(dataLine ? dataLine.slice(6) : body) as {
    result?: { content?: Array<{ type?: string; text?: string }> };
    error?: { message?: string };
  };
  if (json.error) throw new Error(`mcp error: ${json.error.message ?? "unknown"}`);
  const content = json.result?.content ?? [];
  const text = content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
  if (!text) throw new Error("mcp tools/call returned no text content");
  return text;
}

function randomHex(n: number): string {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
