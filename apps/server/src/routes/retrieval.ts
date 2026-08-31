import type { Context, Hono, Next } from "hono";
import { z } from "zod";
import type { Services } from "../app";
import { retrieve } from "@core/retrieval";
import type { Env } from "../middleware/auth";
import { canReadKb } from "../middleware/auth";
import { ensureKbActive } from "@core/kb";

export function registerRetrievalRoutes(
  app: Hono<Env>,
  svc: Services,
  tenant: (c: Context<Env>, next: Next) => Promise<Response | void>,
): void {
  app.post("/v1/kb/:id/retrieval", tenant, async (c) => {
    const kbId = c.req.param("id")!;
    const key = c.get("keyRow");
    if (!canReadKb(key, kbId)) {
      return c.json({ error: { code: "FORBIDDEN", message: "kb not authorized for this key" } }, 403);
    }
    try {
      await ensureKbActive(svc.cfg, kbId);
    } catch (e) {
      if ((e as Error).name === "KbNotFoundError") {
        return c.json({ error: { code: "NOT_FOUND", message: (e as Error).message } }, 404);
      }
      if ((e as Error).name === "KbArchivedError") {
        return c.json({ error: { code: "ARCHIVED", message: (e as Error).message } }, 410);
      }
      throw e;
    }

    const body = z
      .object({
        query: z.string().min(1).max(2000),
        mode: z.enum(["hybrid", "keyword"]).default("hybrid"),
        top_k: z.number().int().positive().max(100).optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: { code: "INVALID_PARAMS", message: "query (1-2000 chars) is required" } }, 422);
    }

    const result = await retrieve(svc.cfg, kbId, {
      query: body.data.query,
      mode: body.data.mode,
      topK: body.data.top_k,
    });
    return c.json(result);
  });
}
