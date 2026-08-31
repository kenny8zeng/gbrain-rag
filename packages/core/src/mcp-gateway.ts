import type { Config } from "./config";
import { sha256hex } from "./hash";
import type { Upstream } from "./gbrain-upstream";
import type { KeyRow } from "./credentials";

export interface McpGatewayDeps {
  baseUrl: string;
  upstream: Upstream;
  lookup: (hash: string) => Promise<KeyRow | null>;
  audit?: (obj: Record<string, unknown>) => void;
}

function jsonErr(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * MCP 网关：X-API-Key 鉴权 → 按凭证换上游 token → 透传 Streamable HTTP。
 * 隔离由上游 OAuth client（--source/--federated-read/--bound-slug-prefixes/--surface）硬性保证；
 * 网关负责鉴权、并发与审计。头剥离与 401/会话失效重放由 Upstream.proxy 统一处理。
 */
export class McpGateway {
  private inflight = new Map<string, number>();

  constructor(private readonly deps: McpGatewayDeps) {}

  async handle(req: Request): Promise<Response> {
    const apiKey = req.headers.get("x-api-key");
    if (!apiKey) return jsonErr(401, "UNAUTHORIZED", "missing X-API-Key header");
    const row = await this.deps.lookup(sha256hex(apiKey));
    if (!row || row.revokedAt) return jsonErr(401, "UNAUTHORIZED", "invalid api key");
    if (!row.clientId || !row.clientSecret) return jsonErr(401, "UNAUTHORIZED", "credential has no upstream client");

    const current = this.inflight.get(row.id) ?? 0;
    if (current >= row.concurrency) {
      return jsonErr(429, "RATE_LIMITED", "concurrency limit exceeded for this key");
    }
    this.inflight.set(row.id, current + 1);
    const started = Date.now();
    try {
      const url = new URL(req.url);
      const res = await this.deps.upstream.proxy(`/mcp${url.search}`, {
        clientId: row.clientId,
        clientSecret: row.clientSecret,
      }, req);
      this.deps.audit?.({
        evt: "mcp",
        key: row.keyPrefix,
        label: row.label,
        method: req.method,
        status: res.status,
        ms: Date.now() - started,
      });
      return res;
    } finally {
      const n = (this.inflight.get(row.id) ?? 1) - 1;
      if (n <= 0) this.inflight.delete(row.id);
      else this.inflight.set(row.id, n);
    }
  }
}
