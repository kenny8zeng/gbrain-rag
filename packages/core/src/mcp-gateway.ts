import type { Config } from "./config";
import { sha256hex } from "./hash";
import type { Upstream } from "./gbrain-upstream";
import type { KeyRow } from "./credentials";

import { DOC_TYPE } from "./entity-graph";

export interface McpGatewayDeps {
  baseUrl: string;
  upstream: Upstream;
  lookup: (hash: string) => Promise<KeyRow | null>;
  audit?: (obj: Record<string, unknown>) => void;
}

/**
 * 文档面读工具（008）：这些工具的返回会进入"文档即页面"的租户视图，
 * 必须排除实体页（`<kb>/entities/*`）。
 *
 * 为什么只能在网关层做：引擎的 `surface` 只决定工具集、`--bound-slug-prefixes`
 * 只作用于写入（write-side isolation），检索侧无 slug 栅栏、亦无类型排除配置——
 * `types` 是唯一可用的**包含式白名单**。HTTP 租户面已按类型 + 前缀双层过滤；
 * MCP 是纯透传，故在此注入。
 */
const DOC_FACE_TOOLS: Record<string, { key: "types" | "type"; value: unknown }> = {
  search: { key: "types", value: [DOC_TYPE] },
  query: { key: "types", value: [DOC_TYPE] },
  list_pages: { key: "type", value: DOC_TYPE },
};

/**
 * 纯函数：对 MCP 请求体注入文档面类型过滤。
 * 返回 null 表示无需改写（非 tools/call、非目标工具、调用方已显式指定类型、
 * body 非 JSON、或解析失败）——此时按原样透传。
 */
export function rewriteDocPlaneCall(body: string): string | null {
  let msg: unknown;
  try {
    msg = JSON.parse(body);
  } catch {
    return null;
  }
  const one = (m: unknown): boolean => {
    if (typeof m !== "object" || m === null) return false;
    const o = m as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
    if (o.method !== "tools/call") return false;
    const name = typeof o.params?.name === "string" ? o.params.name : null;
    if (!name) return false;
    const rule = DOC_FACE_TOOLS[name];
    if (!rule) return false;
    const args = (o.params!.arguments ?? {}) as Record<string, unknown>;
    if (args[rule.key] !== undefined) return false; // 调用方显式指定 → 尊重
    o.params!.arguments = { ...args, [rule.key]: rule.value };
    return true;
  };
  const changed = Array.isArray(msg) ? msg.some(one) : one(msg);
  return changed ? JSON.stringify(msg) : null;
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
      // 008 文档面：MCP 是纯透传到引擎，引擎读侧无 slug 栅栏/无类型排除配置，
      // 故在此对文档面读工具注入类型过滤（实体页不出现在租户的文档视图）。
      let forward = req;
      const ctype = req.headers.get("content-type") ?? "";
      if (req.method === "POST" && ctype.includes("json")) {
        const raw = await req.text();
        const rewritten = rewriteDocPlaneCall(raw);
        if (rewritten !== null) {
          forward = new Request(req.url, {
            method: "POST",
            headers: req.headers,
            body: rewritten,
          });
        } else {
          forward = new Request(req.url, { method: "POST", headers: req.headers, body: raw });
        }
      }
      const res = await this.deps.upstream.proxy(`/mcp${url.search}`, {
        clientId: row.clientId,
        clientSecret: row.clientSecret,
      }, forward);
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
