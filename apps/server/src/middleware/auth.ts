import type { Context, Next } from "hono";
import { sha256hex } from "@core/hash";
import type { KeyRow } from "@core/credentials";
import type { Config } from "@core/config";

export type Env = { Variables: { keyRow: KeyRow } };

export type AdminMiddleware = (c: Context, next: Next) => Promise<Response | void>;
export type TenantMiddleware = (c: Context<Env>, next: Next) => Promise<Response | void>;

export function requireAdmin(cfg: Config) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const header = c.req.header("authorization");
    if (header !== `Bearer ${cfg.ADMIN_TOKEN}`) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "admin token required" } }, 401);
    }
    await next();
  };
}

export function requireTenant(lookup: (hash: string) => Promise<KeyRow | null>) {
  return async (c: Context<Env>, next: Next): Promise<Response | void> => {
    const apiKey = c.req.header("x-api-key");
    if (!apiKey) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "missing X-API-Key header" } }, 401);
    }
    const row = await lookup(sha256hex(apiKey));
    if (!row || row.revokedAt) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "invalid api key" } }, 401);
    }
    c.set("keyRow", row);
    await next();
  };
}

/** 租户对 kb 的读权限：写分区或读授权成员 */
export function canReadKb(row: KeyRow, kbId: string): boolean {
  return row.writeKb === kbId || row.readKbs.includes(kbId);
}

/** 租户对 kb 的写权限：仅写分区 */
export function canWriteKb(row: KeyRow, kbId: string): boolean {
  return row.writeKb === kbId;
}
