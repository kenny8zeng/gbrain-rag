import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Services } from "../app";
import {
  issueKey,
  rescopeKey,
  revokeKey,
  listKeys,
  LabelTakenError,
} from "@core/credentials";
import type { AdminMiddleware } from "./kb";
import type { Env } from "../middleware/auth";

export function registerKeyRoutes(app: Hono<Env>, svc: Services, admin: AdminMiddleware): void {
  app.post("/v1/keys", admin, async (c) => {
    const body = z
      .object({
        label: z.string().min(1).max(100),
        write_kb: z.string().optional(),
        read_kbs: z.array(z.string()).default([]),
        surface: z.string().optional(),
        concurrency: z.number().int().positive().optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: { code: "INVALID_PARAMS", message: "label and read_kbs are required" } }, 422);
    }
    try {
      const { row, plaintext } = await issueKey(svc.cfg, svc.db, {
        label: body.data.label,
        writeKb: body.data.write_kb ?? null,
        readKbs: body.data.read_kbs,
        surface: body.data.surface,
        concurrency: body.data.concurrency,
      });
      // 明文仅此一次返回（FR-003）
      return c.json(
        {
          id: row.id,
          key: plaintext,
          label: row.label,
          write_kb: row.writeKb,
          read_kbs: row.readKbs,
          surface: row.surface,
          created_at: row.createdAt,
        },
        201,
      );
    } catch (e) {
      return keyError(c, e);
    }
  });

  app.patch("/v1/keys/:id", admin, async (c) => {
    const body = z
      .object({
        write_kb: z.string().optional(),
        read_kbs: z.array(z.string()).optional(),
        concurrency: z.number().int().positive().optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: { code: "INVALID_PARAMS", message: "invalid patch body" } }, 422);
    }
    try {
      const row = await rescopeKey(svc.cfg, svc.db, c.req.param("id")!, body.data);
      if (!row) return c.json({ error: { code: "NOT_FOUND", message: "key not found" } }, 404);
      return c.json(sanitize(row));
    } catch (e) {
      return keyError(c, e);
    }
  });

  app.delete("/v1/keys/:id", admin, async (c) => {
    const ok = await revokeKey(svc.cfg, svc.db, c.req.param("id")!);
    if (!ok) return c.json({ error: { code: "NOT_FOUND", message: "key not found" } }, 404);
    return c.body(null, 204);
  });

  app.get("/v1/keys", admin, async (c) => {
    return c.json((await listKeys(svc.db)).map(sanitize));
  });
}

function sanitize(row: {
  id: string;
  keyPrefix: string;
  label: string;
  writeKb: string | null;
  readKbs: string[];
  surface: string;
  concurrency: number;
  createdAt: string;
  revokedAt: string | null;
}) {
  return {
    id: row.id,
    key_prefix: row.keyPrefix,
    label: row.label,
    write_kb: row.writeKb,
    read_kbs: row.readKbs,
    surface: row.surface,
    concurrency: row.concurrency,
    created_at: row.createdAt,
    revoked_at: row.revokedAt,
  };
}

function keyError(c: Context, e: unknown): Response {
  if (e instanceof LabelTakenError) {
    return c.json({ error: { code: "LABEL_TAKEN", message: e.message } }, 409);
  }
  if ((e as Error).name === "KbNotFoundError") {
    return c.json({ error: { code: "NOT_FOUND", message: (e as Error).message } }, 404);
  }
  if ((e as Error).name === "KbArchivedError") {
    return c.json({ error: { code: "ARCHIVED", message: (e as Error).message } }, 410);
  }
  throw e;
}
