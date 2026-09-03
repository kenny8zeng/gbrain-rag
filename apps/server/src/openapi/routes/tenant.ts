import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context, Next } from "hono";
import type { Services } from "../../app";
import type { Env } from "../../middleware/auth";
import { libHandler } from "../handler";
import { canReadKb, canWriteKb } from "../../middleware/auth";
import { ensureKbActive, KbNotFoundError, KbArchivedError } from "@core/kb";
import { runGbrain, runGbrainJson } from "@core/gbrain-cli";
import { resolveParserFor } from "@core/ingest/resolver";
import { ParserUnavailableError } from "@core/ingest/parser";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  ErrorEnvelope,
  JobView,
  RetrievalBody,
  RetrievalResponse,
  SubmitAccepted,
  UrlImportBody,
} from "../schemas";

export type TenantMiddleware = (c: Context<Env>, next: Next) => Promise<Response | void>;

function kbState(c: Context<Env>, e: unknown) {
  if (e instanceof KbNotFoundError) {
    return c.json({ error: { code: "NOT_FOUND", message: e.message } }, 404);
  }
  if (e instanceof KbArchivedError) {
    return c.json({ error: { code: "ARCHIVED", message: e.message } }, 410);
  }
  throw e;
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

function incomingDir(cfg: Services["cfg"]): string {
  return path.join(cfg.DATA_DIR, "incoming");
}

function randomHex(n: number): string {
  return [...randomBytes(n)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif", "svg", "heic"]);

function isImageExt(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

const KbIdParam = z.object({ id: z.string() });
const err403 = () =>
  ({
    403: { description: "越权", content: { "application/json": { schema: ErrorEnvelope } } },
  }) as const;
const err404 = (desc: string) =>
  ({
    404: { description: desc, content: { "application/json": { schema: ErrorEnvelope } } },
  }) as const;
const err410 = () =>
  ({
    410: { description: "知识库已归档", content: { "application/json": { schema: ErrorEnvelope } } },
  }) as const;

export function registerTenantRoutes(app: OpenAPIHono<Env>, svc: Services, tenant: TenantMiddleware): void {
  // 提交导入（三态输入；handler 内手动解析，openapi 声明三种 content）
  const submit = createRoute({
    method: "post",
    path: "/v1/kb/{id}/documents",
    tags: ["tenant"],
    summary: "提交导入（multipart 文件 / {url} / text-markdown）",
    middleware: [tenant],
    security: [{ apiKey: [] }],
    request: {
      params: KbIdParam,
      body: {
        required: true,
        content: {
          "multipart/form-data": {
            // 三态输入不可由 OpenAPIHono 统一校验：multipart 的 file 是 File 对象，
            // z.string() 会 422；统一宽松形状，必填/大小语义由 handler 强制执行（与迁移前一致）
            schema: z.object({
              file: z.unknown().openapi({ format: "binary" }).optional().describe("必填（服务端校验）"),
              title: z.string().optional(),
            }),
          },
          "application/json": {
            schema: z.object({ url: z.url().optional().describe("必填（服务端校验）"), title: z.string().optional() }),
          },
          "text/markdown": { schema: z.string() },
        },
      },
    },
    responses: {
      202: { description: "已受理", content: { "application/json": { schema: SubmitAccepted } } },
      ...err403(),
      ...err404("知识库不存在"),
      ...err410(),
      413: { description: "文件超过大小上限", content: { "application/json": { schema: ErrorEnvelope } } },
      422: { description: "参数不合法", content: { "application/json": { schema: ErrorEnvelope } } },
    },
  });
  app.openapi(submit, libHandler<typeof submit>(async (c) => {
    const kbId = c.req.param("id")!;
    const key = c.get("keyRow");
    if (!canWriteKb(key, kbId)) {
      return c.json({ error: { code: "FORBIDDEN", message: "import requires the write partition" } }, 403);
    }
    try {
      await ensureKbActive(svc.cfg, kbId);
    } catch (e) {
      return kbState(c, e);
    }

    const contentType = c.req.header("content-type") ?? "";
    mkdirSync(incomingDir(svc.cfg), { recursive: true });

    const chain = resolveParserFor(svc.cfg);

    if (contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!(file instanceof File)) {
        return c.json({ error: { code: "INVALID_PARAMS", message: 'multipart field "file" is required' } }, 422);
      }
      // 无 docling 能力（url null = anydoc 唯一/强制）时拒绝独立图片（FR-004）
      if (chain.url === null && (file.type.startsWith("image/") || isImageExt(file.name))) {
        return c.json(
          { error: { code: "PARSER_UNAVAILABLE", message: new ParserUnavailableError("image").message } },
          422,
        );
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
      // slug 派生用原始文件名（显式 title 优先），避免内部存储名的时间戳前缀进入页面标识
      const title = typeof body["title"] === "string" && body["title"] ? body["title"] : file.name;
      // .md / text/markdown 文件直通文本摄取（不经解析器——pipeline md 分支）：
      // 解析器（anydoc/docling）对纯 markdown 无转换必要，且外部 docling 故障时不应阻塞 md 导入
      const isMarkdown = /\.md$/i.test(file.name) || file.type === "text/markdown";
      const job = await svc.submitJob({ kbId, type: isMarkdown ? "md" : "file", sourceRef: stored, title });
      return c.json({ job_id: job.id, kb_id: kbId, status: job.status }, 202);
    }

    if (chain.url === null && contentType.includes("application/json")) {
      // 内置解析器模式不支持网页抓取（FR-004）；json body 只可能是 url 导入
      return c.json(
        { error: { code: "PARSER_UNAVAILABLE", message: new ParserUnavailableError("url").message } },
        422,
      );
    }

    if (contentType.includes("application/json")) {
      const parsed = UrlImportBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: { code: "INVALID_PARAMS", message: "{url} is required" } }, 422);
      }
      const job = await svc.submitJob({
        kbId,
        type: "url",
        sourceRef: parsed.data.url,
        title: parsed.data.title ?? null,
      });
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
  }));

  // 页面列表（读）
  const list = createRoute({
    method: "get",
    path: "/v1/kb/{id}/documents",
    tags: ["tenant"],
    summary: "页面列表",
    middleware: [tenant],
    security: [{ apiKey: [] }],
    request: { params: KbIdParam },
    responses: {
      200: {
        description: "页面列表",
        content: {
          "application/json": {
            schema: z.object({ kb_id: z.string(), pages: z.array(z.record(z.string(), z.unknown())) }),
          },
        },
      },
      ...err403(),
      ...err404("知识库不存在"),
      ...err410(),
    },
  });
  app.openapi(list, libHandler<typeof list>(async (c) => {
    const kbId = c.req.param("id")!;
    const key = c.get("keyRow");
    if (!canReadKb(key, kbId)) {
      return c.json({ error: { code: "FORBIDDEN", message: "kb not authorized for this key" } }, 403);
    }
    try {
      await ensureKbActive(svc.cfg, kbId);
    } catch (e) {
      return kbState(c, e);
    }
    // gbrain list --json 输出为 tab 分隔文本（slug	type	date	title），非 JSON
    const r = await runGbrain(svc.cfg, {
      args: ["list", "--limit", "200"],
      source: kbId,
      timeoutMs: 30_000,
    });
    const pages = r.stdout
      .split("\n")
      .map((line) => line.split("\t"))
      .filter((cols) => cols.length >= 1 && cols[0]!.trim().length > 0)
      .map((cols) => ({ slug: cols[0]!.trim(), type: cols[1]?.trim() ?? null, date: cols[2]?.trim() ?? null, title: cols[3]?.trim() ?? null }));
    return c.json({ kb_id: kbId, pages });
  }));

  // 删除页面（写）。slug 固定三段 <source>/docs/<name>（slugifyName 保证 name 无斜杠），
  // 故以显式三段路径表达，避免单段 :param 无法匹配嵌套路径
  const del = createRoute({
    method: "delete",
    path: "/v1/kb/{id}/documents/{dir}/{name}",
    tags: ["tenant"],
    summary: "删除页面（slug = <kb>/docs/<name>）",
    middleware: [tenant],
    security: [{ apiKey: [] }],
    request: { params: z.object({ id: z.string(), dir: z.string(), name: z.string() }) },
    responses: {
      204: { description: "已删除" },
      ...err403(),
      ...err404("知识库不存在"),
      ...err410(),
    },
  });
  app.openapi(del, libHandler<typeof del>(async (c) => {
    const kbId = c.req.param("id")!;
    const dir = c.req.param("dir")!;
    const name = c.req.param("name")!;
    if (dir !== "docs") {
      return c.json({ error: { code: "INVALID_PARAMS", message: "slug must be <kb>/docs/<name>" } }, 422);
    }
    const slug = `${kbId}/${dir}/${name}`;
    const key = c.get("keyRow");
    if (!canWriteKb(key, kbId)) {
      return c.json({ error: { code: "FORBIDDEN", message: "kb not authorized for this key" } }, 403);
    }
    try {
      await ensureKbActive(svc.cfg, kbId);
    } catch (e) {
      return kbState(c, e);
    }
    await runGbrain(svc.cfg, { args: ["delete", slug], source: kbId, timeoutMs: 60_000 });
    return c.body(null, 204);
  }));

  // 任务状态
  const jobStatus = createRoute({
    method: "get",
    path: "/v1/kb/{id}/documents/jobs/{jobId}",
    tags: ["tenant"],
    summary: "导入任务状态",
    middleware: [tenant],
    security: [{ apiKey: [] }],
    request: { params: z.object({ id: z.string(), jobId: z.string() }) },
    responses: {
      200: { description: "任务详情", content: { "application/json": { schema: JobView } } },
      ...err403(),
      404: { description: "任务不存在", content: { "application/json": { schema: ErrorEnvelope } } },
    },
  });
  app.openapi(jobStatus, libHandler<typeof jobStatus>(async (c) => {
    const kbId = c.req.param("id")!;
    const key = c.get("keyRow");
    if (!canReadKb(key, kbId)) {
      return c.json({ error: { code: "FORBIDDEN", message: "kb not authorized for this key" } }, 403);
    }
    const rows = await svc.db`SELECT * FROM rag_jobs WHERE id = ${c.req.param("jobId")!} LIMIT 1`;
    if (rows.length === 0 || (rows[0] as Record<string, unknown>).kb_id !== kbId) {
      return c.json({ error: { code: "NOT_FOUND", message: "job not found" } }, 404);
    }
    return c.json(jobJson(rows[0] as Record<string, unknown>));
  }));

  // 检索
  const retrieval = createRoute({
    method: "post",
    path: "/v1/kb/{id}/retrieval",
    tags: ["tenant"],
    summary: "检索（hybrid/keyword）",
    middleware: [tenant],
    security: [{ apiKey: [] }],
    request: {
      params: KbIdParam,
      body: { required: true, content: { "application/json": { schema: RetrievalBody } } },
    },
    responses: {
      200: { description: "检索结果", content: { "application/json": { schema: RetrievalResponse } } },
      ...err403(),
      ...err404("知识库不存在"),
      ...err410(),
      422: { description: "参数不合法", content: { "application/json": { schema: ErrorEnvelope } } },
    },
  });
  app.openapi(retrieval, libHandler<typeof retrieval>(async (c) => {
    const kbId = c.req.param("id")!;
    const key = c.get("keyRow");
    if (!canReadKb(key, kbId)) {
      return c.json({ error: { code: "FORBIDDEN", message: "kb not authorized for this key" } }, 403);
    }
    try {
      await ensureKbActive(svc.cfg, kbId);
    } catch (e) {
      return kbState(c, e);
    }
    const parsed = RetrievalBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_PARAMS", message: "query (1-2000 chars) is required" } }, 422);
    }
    const result = await svc.retrieve(kbId, parsed.data);
    return c.json(result);
  }));
}
