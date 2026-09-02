import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Services } from "../../app";
import type { AdminMiddleware, Env } from "../../middleware/auth";
import { libHandler } from "../handler";
import { archiveKb, createKb, purgeKb, referencingCredentials, KbNotFoundError, KbArchivedError, KbInUseError } from "@core/kb";
import { issueKey, rescopeKey, revokeKey, LabelTakenError } from "@core/credentials"; // purge force 联动吊销
import {
  ErrorEnvelope,
  KbCreateBody,
  KbView,
  KeyIssueBody,
  KeyIssued,
  KeyPatchBody,
  KeyView,
  JobView,
} from "../schemas";

function kbState(c: Context<Env>, e: unknown) {
  if (e instanceof KbNotFoundError) {
    return c.json({ error: { code: "NOT_FOUND", message: e.message } }, 404);
  }
  if (e instanceof KbArchivedError) {
    return c.json({ error: { code: "ARCHIVED", message: e.message } }, 410);
  }
  if (e instanceof KbInUseError) {
    return c.json(
      { error: { code: "KB_IN_USE", message: e.message, credential_ids: e.credentialIds } },
      409,
    );
  }
  throw e;
}

function keyState(c: Context<Env>, e: unknown) {
  if (e instanceof LabelTakenError) {
    return c.json({ error: { code: "LABEL_TAKEN", message: e.message } }, 409);
  }
  return kbState(c, e);
}

function keyView(row: Record<string, unknown>) {
  return {
    id: row.id,
    key_prefix: row.key_prefix,
    label: row.label,
    write_kb: row.write_kb ?? null,
    read_kbs: row.read_kbs,
    surface: row.surface,
    concurrency: row.concurrency,
    created_at: row.created_at,
    revoked_at: row.revoked_at ?? null,
  };
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
    parser_log: r.parser_log ?? null,
  };
}

const err401 = () =>
  ({
    401: { description: "未认证", content: { "application/json": { schema: ErrorEnvelope } } },
  }) as const;
const err404 = (d = "不存在") =>
  ({ 404: { description: d, content: { "application/json": { schema: ErrorEnvelope } } } }) as const;
const err409 = (d: string) =>
  ({ 409: { description: d, content: { "application/json": { schema: ErrorEnvelope } } } }) as const;
const err410 = () =>
  ({ 410: { description: "已归档", content: { "application/json": { schema: ErrorEnvelope } } } }) as const;
const err422 = () =>
  ({ 422: { description: "参数不合法", content: { "application/json": { schema: ErrorEnvelope } } } }) as const;

export function registerAdminRoutes(app: OpenAPIHono<Env>, svc: Services, admin: AdminMiddleware): void {
  // ---- 知识库 ----
  const createKbRoute = createRoute({
    method: "post",
    path: "/v1/kb",
    tags: ["admin"],
    summary: "创建知识库",
    middleware: [admin],
    security: [{ adminToken: [] }],
    request: { body: { required: true, content: { "application/json": { schema: KbCreateBody } } } },
    responses: {
      201: { description: "已创建", content: { "application/json": { schema: KbView } } },
      ...err401(),
      ...err422(),
      500: { description: "引擎错误", content: { "application/json": { schema: ErrorEnvelope } } },
    },
  });
  app.openapi(createKbRoute, libHandler<typeof createKbRoute>(async (c: Context<Env>) => {
    const parsed = KbCreateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_PARAMS", message: "name is required (1-200 chars)" } }, 422);
    }
    const kb = await createKb(svc.cfg, svc.db, parsed.data.name);
    await svc.onKbCreated(kb.id); // 内部检索 client 纳管（T049）
    return c.json({ id: kb.id, name: kb.name, status: kb.status, created_at: new Date().toISOString() }, 201);
  }));

  const listKbRoute = createRoute({
    method: "get",
    path: "/v1/kb",
    tags: ["admin"],
    summary: "知识库列表",
    middleware: [admin],
    security: [{ adminToken: [] }],
    responses: {
      200: { description: "列表", content: { "application/json": { schema: z.array(KbView) } } },
      ...err401(),
    },
  });
  app.openapi(listKbRoute, libHandler<typeof listKbRoute>(async (c: Context<Env>) => {
    const { listKbs } = await import("@core/kb");
    return c.json(await listKbs(svc.cfg));
  }));

  const getKbRoute = createRoute({
    method: "get",
    path: "/v1/kb/{id}",
    tags: ["admin"],
    summary: "知识库详情",
    middleware: [admin],
    security: [{ adminToken: [] }],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "详情", content: { "application/json": { schema: KbView } } },
      ...err401(),
      ...err404("知识库不存在"),
      ...err410(),
    },
  });
  app.openapi(getKbRoute, libHandler<typeof getKbRoute>(async (c: Context<Env>) => {
    const id = c.req.param("id")!;
    const all = await (await import("@core/kb")).listKbs(svc.cfg);
    const kb = all.find((k) => k.id === id) ?? null;
    if (!kb) return c.json({ error: { code: "NOT_FOUND", message: `kb ${id} not found` } }, 404);
    if (kb.status === "archived") return c.json(kb, 410);
    return c.json(kb);
  }));

  const deleteKbRoute = createRoute({
    method: "delete",
    path: "/v1/kb/{id}",
    tags: ["admin"],
    summary: "归档知识库（72h 保留期）",
    middleware: [admin],
    security: [{ adminToken: [] }],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "已归档", content: { "application/json": { schema: z.object({ id: z.string(), status: z.string() }) } } },
      ...err401(),
      ...err404("知识库不存在"),
      ...err409("仍被有效凭证引用（KB_IN_USE）"),
      ...err410(),
    },
  });
  app.openapi(deleteKbRoute, libHandler<typeof deleteKbRoute>(async (c: Context<Env>) => {
    const id = c.req.param("id")!;
    const force = c.req.query("force") === "true";
    try {
      await archiveKb(svc.cfg, svc.db, id, { force });
      return c.json({ id, status: "archived" });
    } catch (e) {
      return kbState(c, e);
    }
  }));

  const purgeKbRoute = createRoute({
    method: "post",
    path: "/v1/kb/{id}/purge",
    tags: ["admin"],
    summary: "永久清除知识库（不可逆）",
    middleware: [admin],
    security: [{ adminToken: [] }],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "已清除", content: { "application/json": { schema: z.object({ id: z.string(), status: z.string() }) } } },
      ...err401(),
      ...err404("知识库不存在"),
    },
  });
  app.openapi(purgeKbRoute, libHandler<typeof purgeKbRoute>(async (c: Context<Env>) => {
    const id = c.req.param("id")!;
    const force = c.req.query("force") === "true";
    try {
      // D12：purge 前预检全部引用（租户 key 的上游 client 以 source_id 指向该库，FK 阻塞）
      const refs = await referencingCredentials(svc.db, id);
      if (refs.length > 0) {
        if (!force) throw new KbInUseError(id, refs);
        for (const keyId of refs) {
          await revokeKey(svc.cfg, svc.db, keyId).catch(() => undefined);
        }
      }
      await svc.onKbPurged(); // 迁移/重建内部检索 client（FK RESTRICT）
      await purgeKb(svc.cfg, id);
      return c.json({ id, status: "purged", revoked_keys: force ? refs.length : 0 });
    } catch (e) {
      return kbState(c, e);
    }
  }));

  // ---- 凭证 ----
  const issueKeyRoute = createRoute({
    method: "post",
    path: "/v1/keys",
    tags: ["admin"],
    summary: "签发 agent 凭证（明文仅返回一次）",
    middleware: [admin],
    security: [{ adminToken: [] }],
    request: { body: { required: true, content: { "application/json": { schema: KeyIssueBody } } } },
    responses: {
      201: { description: "已签发", content: { "application/json": { schema: KeyIssued } } },
      ...err401(),
      ...err404("引用的知识库不存在"),
      ...err409("label 重复（LABEL_TAKEN）"),
      ...err410(),
      ...err422(),
    },
  });
  app.openapi(issueKeyRoute, libHandler<typeof issueKeyRoute>(async (c: Context<Env>) => {
    const parsed = KeyIssueBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_PARAMS", message: "label and read_kbs are required" } }, 422);
    }
    try {
      const { row, plaintext } = await issueKey(svc.cfg, svc.db, {
        label: parsed.data.label,
        writeKb: parsed.data.write_kb ?? null,
        readKbs: parsed.data.read_kbs,
        surface: parsed.data.surface,
        concurrency: parsed.data.concurrency,
      });
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
      return keyState(c, e);
    }
  }));

  const patchKeyRoute = createRoute({
    method: "patch",
    path: "/v1/keys/{id}",
    tags: ["admin"],
    summary: "变更授权组合（即时生效）",
    middleware: [admin],
    security: [{ adminToken: [] }],
    request: {
      params: z.object({ id: z.string() }),
      body: { required: true, content: { "application/json": { schema: KeyPatchBody } } },
    },
    responses: {
      200: { description: "已变更", content: { "application/json": { schema: KeyView } } },
      ...err401(),
      ...err404("凭证不存在"),
      ...err409("label 冲突"),
      ...err410(),
      ...err422(),
    },
  });
  app.openapi(patchKeyRoute, libHandler<typeof patchKeyRoute>(async (c: Context<Env>) => {
    const parsed = KeyPatchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_PARAMS", message: "invalid patch body" } }, 422);
    }
    try {
      const row = await rescopeKey(svc.cfg, svc.db, c.req.param("id")!, {
        writeKb: parsed.data.write_kb,
        readKbs: parsed.data.read_kbs,
        concurrency: parsed.data.concurrency,
      });
      if (!row) return c.json({ error: { code: "NOT_FOUND", message: "key not found" } }, 404);
      return c.json(keyView(row as unknown as Record<string, unknown>));
    } catch (e) {
      return keyState(c, e);
    }
  }));

  const deleteKeyRoute = createRoute({
    method: "delete",
    path: "/v1/keys/{id}",
    tags: ["admin"],
    summary: "吊销凭证",
    middleware: [admin],
    security: [{ adminToken: [] }],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: "已吊销" },
      ...err401(),
      ...err404("凭证不存在"),
    },
  });
  app.openapi(deleteKeyRoute, libHandler<typeof deleteKeyRoute>(async (c: Context<Env>) => {
    const ok = await revokeKey(svc.cfg, svc.db, c.req.param("id")!);
    if (!ok) return c.json({ error: { code: "NOT_FOUND", message: "key not found" } }, 404);
    return c.body(null, 204);
  }));

  const listKeysRoute = createRoute({
    method: "get",
    path: "/v1/keys",
    tags: ["admin"],
    summary: "凭证列表",
    middleware: [admin],
    security: [{ adminToken: [] }],
    responses: {
      200: { description: "列表", content: { "application/json": { schema: z.array(KeyView) } } },
      ...err401(),
    },
  });
  app.openapi(listKeysRoute, libHandler<typeof listKeysRoute>(async (c: Context<Env>) => {
    const rows = await svc.db`
      SELECT id, key_prefix, label, write_kb, read_kbs, surface, concurrency, created_at, revoked_at
      FROM rag_keys ORDER BY created_at DESC
    `;
    return c.json(rows.map((r: Record<string, unknown>) => keyView(r)));
  }));

  // ---- 摄取任务（管理侧） ----
  const listJobsRoute = createRoute({
    method: "get",
    path: "/v1/jobs",
    tags: ["admin"],
    summary: "导入任务列表",
    middleware: [admin],
    security: [{ adminToken: [] }],
    request: {
      query: z.object({
        kb_id: z.string().optional(),
        status: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
    responses: {
      200: { description: "列表", content: { "application/json": { schema: z.object({ jobs: z.array(JobView) }) } } },
      ...err401(),
    },
  });
  app.openapi(listJobsRoute, libHandler<typeof listJobsRoute>(async (c: Context<Env>) => {
    const kbId = c.req.query("kb_id");
    const status = c.req.query("status");
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
    const rows = kbId
      ? await svc.db`SELECT * FROM rag_jobs WHERE kb_id = ${kbId} ORDER BY created_at DESC LIMIT ${limit}`
      : await svc.db`SELECT * FROM rag_jobs ORDER BY created_at DESC LIMIT ${limit}`;
    const filtered = status ? rows.filter((r: Record<string, unknown>) => r.status === status) : rows;
    return c.json({ jobs: filtered.map((r: Record<string, unknown>) => jobJson(r)) });
  }));

  const getJobRoute = createRoute({
    method: "get",
    path: "/v1/jobs/{id}",
    tags: ["admin"],
    summary: "导入任务详情",
    middleware: [admin],
    security: [{ adminToken: [] }],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "详情", content: { "application/json": { schema: JobView } } },
      ...err401(),
      ...err404("任务不存在"),
    },
  });
  app.openapi(getJobRoute, libHandler<typeof getJobRoute>(async (c: Context<Env>) => {
    const rows = await svc.db`SELECT * FROM rag_jobs WHERE id = ${c.req.param("id")!} LIMIT 1`;
    if (rows.length === 0) {
      return c.json({ error: { code: "NOT_FOUND", message: "job not found" } }, 404);
    }
    return c.json(jobJson(rows[0] as Record<string, unknown>));
  }));
}
