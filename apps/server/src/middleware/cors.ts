import { cors } from "hono/cors";
import { corsOrigins, type Config } from "@core/config";
import { matchOrigin } from "@core/cors";

/**
 * 跨域中间件：origin 回调动态匹配（spec FR-001/003）。
 * 列表空 → 匹配恒 null → 不产生任何 Access-Control-* 头（特性关闭）。
 * "*" → 全放行回显 "*"；精确匹配 → 回显来源。
 */
export function corsMiddleware(cfg: Config) {
  const origins = corsOrigins(cfg);
  return cors({
    origin: (requestOrigin) => matchOrigin(origins, requestOrigin),
    allowHeaders: ["Content-Type", "X-API-Key", "X-Slug", "Authorization"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 600,
  });
}
