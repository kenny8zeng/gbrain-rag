import type { Context, Hono, Next } from "hono";
import { z } from "zod";
import type { Services } from "../app";
import type { Env } from "../middleware/auth";
import type { KbInUseError, KbArchivedError, KbNotFoundError } from "@core/kb";
import {
  createKb,
  listKbs,
  archiveKb,
  purgeKb,
} from "@core/kb";

export type AdminMiddleware = (c: Context, next: Next) => Promise<Response | void>;

export function registerKbRoutes(app: Hono<Env>, svc: Services, admin: AdminMiddleware): void {
  app.post("/v1/kb", admin, async (c) => {
    const body = z.object({ name: z.string().min(1).max(200) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: { code: "INVALID_PARAMS", message: "name is required (1-200 chars)" } }, 422);
    }
    const kb = await createKb(svc.cfg, svc.db, body.data.name);
    return c.json({ id: kb.id, name: kb.name, status: kb.status, created_at: new Date().toISOString() }, 201);
  });

  app.get("/v1/kb", admin, async (c) => {
    return c.json(await listKbs(svc.cfg));
  });

  app.get("/v1/kb/:id", admin, async (c) => {
    const id = c.req.param("id")!;
    const kb = await findKb(svc, id);
    if (!kb) return c.json({ error: { code: "NOT_FOUND", message: `kb ${id} not found` } }, 404);
    if (kb.status === "archived") return c.json(kb, 410);
    return c.json(kb);
  });

  app.delete("/v1/kb/:id", admin, async (c) => {
    const id = c.req.param("id")!;
    const force = c.req.query("force") === "true";
    try {
      await archiveKb(svc.cfg, svc.db, id, { force });
      return c.json({ id, status: "archived" });
    } catch (e) {
      return kbError(c, e);
    }
  });

  app.post("/v1/kb/:id/purge", admin, async (c) => {
    const id = c.req.param("id")!;
    try {
      await purgeKb(svc.cfg, id);
      return c.json({ id, status: "purged" });
    } catch (e) {
      return kbError(c, e);
    }
  });
}

async function findKb(svc: Services, id: string) {
  const all = await listKbs(svc.cfg);
  return all.find((k) => k.id === id) ?? null;
}

export function kbError(c: Context, e: unknown): Response {
  if ((e as KbNotFoundError).name === "KbNotFoundError") {
    return c.json({ error: { code: "NOT_FOUND", message: (e as Error).message } }, 404);
  }
  if ((e as KbArchivedError).name === "KbArchivedError") {
    return c.json({ error: { code: "ARCHIVED", message: (e as Error).message } }, 410);
  }
  if ((e as KbInUseError).name === "KbInUseError") {
    return c.json(
      { error: { code: "KB_IN_USE", message: (e as Error).message, credential_ids: (e as KbInUseError).credentialIds } },
      409,
    );
  }
  throw e;
}
