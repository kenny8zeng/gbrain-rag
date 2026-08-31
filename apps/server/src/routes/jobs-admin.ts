import type { Context, Hono, Next } from "hono";
import type { Services } from "../app";
import type { AdminMiddleware } from "./kb";
import type { Env } from "../middleware/auth";

export function registerJobsAdminRoutes(
  app: Hono<Env>,
  svc: Services,
  admin: AdminMiddleware,
): void {
  app.get("/v1/jobs", admin, async (c) => {
    const kbId = c.req.query("kb_id");
    const status = c.req.query("status");
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
    const rows = kbId
      ? await svc.db`SELECT * FROM rag_jobs WHERE kb_id = ${kbId} ORDER BY created_at DESC LIMIT ${limit}`
      : await svc.db`SELECT * FROM rag_jobs ORDER BY created_at DESC LIMIT ${limit}`;
    const filtered = status ? rows.filter((r: Record<string, unknown>) => (r as Record<string, unknown>).status === status) : rows;
    return c.json({ jobs: filtered.map(jobJson) });
  });

  app.get("/v1/jobs/:id", admin, async (c) => {
    const rows = await svc.db`SELECT * FROM rag_jobs WHERE id = ${c.req.param("id")} LIMIT 1`;
    if (rows.length === 0) {
      return c.json({ error: { code: "NOT_FOUND", message: "job not found" } }, 404);
    }
    return c.json(jobJson(rows[0] as Record<string, unknown>));
  });
}

function jobJson(r: Record<string, unknown>) {
  return {
    id: r.id,
    kb_id: r.kb_id,
    type: r.type,
    status: r.status,
    attempts: r.attempts,
    error: r.error,
    outcome: r.outcome,
    doc_slug: r.doc_slug,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}
