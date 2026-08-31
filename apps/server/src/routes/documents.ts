import type { Context, Hono, Next } from "hono";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Services } from "../app";
import type { Env } from "../middleware/auth";
import { canReadKb, canWriteKb } from "../middleware/auth";
import { ensureKbActive } from "@core/kb";
import { runGbrain, runGbrainJson } from "@core/gbrain-cli";

export function registerDocumentRoutes(
  app: Hono<Env>,
  svc: Services,
  tenant: (c: Context<Env>, next: Next) => Promise<Response | void>,
): void {
  app.post("/v1/kb/:id/documents", tenant, async (c) => {
    const kbId = c.req.param("id")!;
    const key = c.get("keyRow");
    // 导入是写操作：仅写分区（spec 3.2）
    if (!canWriteKb(key, kbId)) {
      return c.json({ error: { code: "FORBIDDEN", message: "import requires the write partition" } }, 403);
    }
    try {
      await ensureKbActive(svc.cfg, kbId);
    } catch (e) {
      return kbStateError(c, e);
    }

    const contentType = c.req.header("content-type") ?? "";
    mkdirSync(incomingDir(svc.cfg), { recursive: true });

    if (contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!(file instanceof File)) {
        return c.json({ error: { code: "INVALID_PARAMS", message: 'multipart field "file" is required' } }, 422);
      }
      if (file.size > svc.cfg.MAX_UPLOAD_BYTES) {
        return c.json(
          { error: { code: "PAYLOAD_TOO_LARGE", message: `file exceeds ${svc.cfg.MAX_UPLOAD_BYTES} bytes` } },
          413,
        );
      }
      const stored = `${Date.now()}-${randomHex(6)}-${file.name.replace(/[^\w.-]+/g, "_")}`;
      const buf = await file.arrayBuffer();
      writeFileSync(path.join(incomingDir(svc.cfg), stored), Buffer.from(buf));
      const title = typeof body["title"] === "string" && body["title"] ? body["title"] : null;
      const job = await svc.submitJob({ kbId, type: "file", sourceRef: stored, title });
      return c.json({ job_id: job.id, kb_id: kbId, status: job.status }, 202);
    }

    if (contentType.includes("application/json")) {
      const body = z
        .object({ url: z.string().url(), title: z.string().optional() })
        .safeParse(await c.req.json().catch(() => null));
      if (!body.success) {
        return c.json({ error: { code: "INVALID_PARAMS", message: "{url} is required" } }, 422);
      }
      const job = await svc.submitJob({ kbId, type: "url", sourceRef: body.data.url, title: body.data.title ?? null });
      return c.json({ job_id: job.id, kb_id: kbId, status: job.status }, 202);
    }

    if (contentType.includes("text/markdown") || contentType.includes("text/plain")) {
      const md = await c.req.text();
      if (!md.trim()) {
        return c.json({ error: { code: "INVALID_PARAMS", message: "markdown body is empty" } }, 422);
      }
      const stored = `${Date.now()}-${randomHex(6)}.md`;
      writeFileSync(path.join(incomingDir(svc.cfg), stored), md, "utf8");
      const title = c.req.header("x-slug") ?? null;
      const job = await svc.submitJob({ kbId, type: "md", sourceRef: stored, title });
      return c.json({ job_id: job.id, kb_id: kbId, status: job.status }, 202);
    }

    return c.json(
      {
        error: {
          code: "INVALID_PARAMS",
          message: "unsupported content-type; use multipart, application/json {url}, or text/markdown",
        },
      },
      422,
    );
  });

  app.get("/v1/kb/:id/documents", tenant, async (c) => {
    const kbId = c.req.param("id")!;
    const key = c.get("keyRow");
    if (!canReadKb(key, kbId)) return forbidden(c);
    try {
      await ensureKbActive(svc.cfg, kbId);
    } catch (e) {
      return kbStateError(c, e);
    }
    const j = await runGbrainJson<{ pages?: Array<Record<string, unknown>> }>(svc.cfg, {
      args: ["list", "--limit", "200"],
      source: kbId,
      timeoutMs: 30_000,
    });
    return c.json({ kb_id: kbId, pages: j.pages ?? [] });
  });

  app.delete("/v1/kb/:id/documents/:slug", tenant, async (c) => {
    const kbId = c.req.param("id")!;
    const slug = c.req.param("slug")!;
    const key = c.get("keyRow");
    if (!canWriteKb(key, kbId)) return forbidden(c);
    if (!slug.startsWith(`${kbId}/`)) {
      return c.json({ error: { code: "FORBIDDEN", message: "slug outside partition fence" } }, 403);
    }
    try {
      await ensureKbActive(svc.cfg, kbId);
    } catch (e) {
      return kbStateError(c, e);
    }
    await runGbrain(svc.cfg, { args: ["delete", slug], source: kbId, timeoutMs: 60_000 });
    return c.body(null, 204);
  });

  app.get("/v1/kb/:id/documents/jobs/:jobId", tenant, async (c) => {
    const kbId = c.req.param("id")!;
    const key = c.get("keyRow");
    if (!canReadKb(key, kbId)) return forbidden(c);
    const rows = await svc.db`SELECT * FROM rag_jobs WHERE id = ${c.req.param("jobId")!} LIMIT 1`;
    if (rows.length === 0 || (rows[0] as Record<string, unknown>).kb_id !== kbId) {
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

function forbidden(c: Context<Env>): Response {
  return c.json({ error: { code: "FORBIDDEN", message: "kb not authorized for this key" } }, 403);
}

function kbStateError(c: Context<Env>, e: unknown): Response {
  if ((e as Error).name === "KbNotFoundError") {
    return c.json({ error: { code: "NOT_FOUND", message: (e as Error).message } }, 404);
  }
  if ((e as Error).name === "KbArchivedError") {
    return c.json({ error: { code: "ARCHIVED", message: (e as Error).message } }, 410);
  }
  throw e;
}

function incomingDir(cfg: Services["cfg"]): string {
  return path.join(cfg.DATA_DIR, "incoming");
}

function randomHex(n: number): string {
  return [...randomBytes(n)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
