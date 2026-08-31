import { sha256hex } from "./hash";

export interface UpstreamCreds {
  clientId: string;
  clientSecret: string;
}

interface CacheEntry {
  token: string;
  expiresAt: number;
}

/**
 * gbrain serve --http 上游客户端：client_credentials 换 token，
 * TTL 缓存 + 过期/401 刷新。所有 Agent 流量经此处注入 Bearer 后转发。
 */
export class Upstream {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly baseUrl: string) {}

  async token(creds: UpstreamCreds): Promise<string> {
    const hit = this.cache.get(creds.clientId);
    if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
    const res = await fetch(`${this.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`upstream token request failed: ${res.status} ${await res.text()}`);
    }
    const j = (await res.json()) as { access_token: string; expires_in?: number };
    const ttlMs = (j.expires_in ?? 3600) * 1000;
    this.cache.set(creds.clientId, { token: j.access_token, expiresAt: Date.now() + ttlMs });
    return j.access_token;
  }

  invalidate(clientId: string): void {
    this.cache.delete(clientId);
  }

  /**
   * 转发请求到上游 serve。剥离调用方 authorization / x-gbrain-* / hop-by-hop 头，
   * 注入上游 Bearer；401 时刷新 token 重放一次；带过期会话 id 的 404 剥会话重放一次。
   */
  async proxy(pathAndQuery: string, creds: UpstreamCreds, req: Request): Promise<Response> {
    const buildInit = async (token: string, sessionId?: string | null): Promise<Response> => {
      const headers = new Headers();
      for (const [k, v] of req.headers.entries()) {
        const lower = k.toLowerCase();
        if (lower === "authorization" || lower.startsWith("x-gbrain-")) continue;
        if (lower === "host" || lower === "content-length" || lower === "connection") continue;
        headers.set(k, v);
      }
      headers.set("authorization", `Bearer ${token}`);
      if (sessionId) headers.set("mcp-session-id", sessionId);
      const hasBody = req.method === "POST" || req.method === "DELETE" || req.method === "PATCH";
      const body = hasBody ? await req.arrayBuffer() : undefined;
      return fetch(`${this.baseUrl}${pathAndQuery}`, {
        method: req.method,
        headers,
        body: body && body.byteLength > 0 ? body : undefined,
        redirect: "manual",
      });
    };

    let res = await buildInit(await this.token(creds), req.headers.get("mcp-session-id"));

    if (res.status === 401) {
      this.invalidate(creds.clientId);
      res = await buildInit(await this.token(creds), req.headers.get("mcp-session-id"));
    }
    if (res.status === 404 && req.headers.get("mcp-session-id")) {
      res = await buildInit(await this.token(creds), null);
    }

    const respHeaders = new Headers(res.headers);
    respHeaders.delete("content-encoding");
    respHeaders.delete("content-length");
    respHeaders.delete("transfer-encoding");
    return new Response(res.body, { status: res.status, headers: respHeaders });
  }
}
