import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context, Next } from "hono";
import type { Services } from "../../app";
import type { Env } from "../../middleware/auth";
import { libHandler } from "../handler";
import { canReadKb, canWriteKb } from "../../middleware/auth";
import { ensureKbActive, KbNotFoundError, KbArchivedError } from "@core/kb";
import { CliBusyError, CliError, runGbrain, runGbrainJson } from "@core/gbrain-cli";
import { DOC_TYPE, isDocSlug, EntityGraphService } from "@core/entity-graph";
import { resolveParserFor } from "@core/ingest/resolver";
import { ParserUnavailableError } from "@core/ingest/parser";
import {
  ParseBusyError,
  UnsupportedFileTypeError,
  describeParseFailure,
  isImageInput,
  isPassthroughInput,
  parseFile,
  parseImage,
  parsePassthrough,
  parseUrl,
  withParseSlot,
} from "@core/ingest/parse-api";
import {
  applyStrip,
  buildBulkStage,
  listArchiveFiles,
  newBulkTempDir,
  planBulkDocs,
  validateArchiveMemberNames,
  validateArchiveMemberTypes,
} from "@core/ingest/bulk";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  BulkAccepted,
  BulkDryRunView,
  ErrorEnvelope,
  JobView,
  ParseResultView,
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
  // 引擎容量饱和 / CLI 排队超时：可重试，不应放大成 500（生产实测：批量导入下
  // 连 `sources list` 都排队超时，把提交接口打成 unhandled 500）
  if (e instanceof CliBusyError || e instanceof CliError) {
    return c.json(
      { error: { code: "UPSTREAM_BUSY", message: "knowledge engine is busy, please retry" } },
      503,
    );
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
    result_summary: r.result_summary ?? null,
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

// 图片判定复用 009 的单一来源（packages/core/src/ingest/parse-api.ts），避免第二份类型表
const isImageExt = isImageInput;

const KbIdParam = z.object({ id: z.string() });
const err401 = () =>
  ({
    401: { description: "凭证缺失或无效", content: { "application/json": { schema: ErrorEnvelope } } },
  } as const);

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
      if (title !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(title)) {
        return c.json(
          {
            error: {
              code: "INVALID_PARAMS",
              message: "X-Slug 仅允许 ASCII（字母/数字/._-），中文标题请用正文首行 # 标题；显式 slug 请用英文",
            },
          },
          422,
        );
      }
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
    // 文档面（008）：SQL 层按类型过滤（使 --limit 只对文档生效，不被实体页挤占）；
    // 结果侧再做 `docs/` 前缀兜底（结构保证）
    const r = await runGbrain(svc.cfg, {
      args: ["list", "--type", DOC_TYPE, "--limit", "10000"],
      source: kbId,
      timeoutMs: 30_000,
    });
    const pages = r.stdout
      .split("\n")
      .map((line) => line.split("\t"))
      .filter((cols) => cols.length >= 1 && cols[0]!.trim().length > 0)
      .map((cols) => ({ slug: cols[0]!.trim(), type: cols[1]?.trim() ?? null, date: cols[2]?.trim() ?? null, title: cols[3]?.trim() ?? null }))
      .filter((p) => isDocSlug(kbId, p.slug));
    return c.json({ kb_id: kbId, pages });
  }));

  // 页面全文（读）：slug 经 query 传递（多段 slug 含 /，避免路径参数无法匹配）
  const pageFull = createRoute({
    method: "get",
    path: "/v1/kb/{id}/page",
    tags: ["tenant"],
    summary: "页面全文（markdown）",
    middleware: [tenant],
    security: [{ apiKey: [] }],
    request: { params: KbIdParam, query: z.object({ slug: z.string().min(1) }) },
    responses: {
      200: { description: "页面全文", content: { "application/json": { schema: z.object({ slug: z.string(), content: z.string() }) } } },
      404: { description: "页面不存在" },
      422: { description: "参数不合法" },
    },
  });
  app.openapi(pageFull, libHandler<typeof pageFull>(async (c) => {
    const kbId = c.req.param("id")!;
    const key = c.get("keyRow");
    const slug = c.req.query("slug") ?? "";
    if (!canReadKb(key, kbId)) {
      return c.json({ error: { code: "FORBIDDEN", message: "kb not authorized for this key" } }, 403);
    }
    // 防跨库：slug 必须属于本 KB 源
    if (!slug.startsWith(`${kbId}/docs/`)) {
      return c.json({ error: { code: "INVALID_PARAMS", message: "slug must belong to this kb" } }, 422);
    }
    try {
      await ensureKbActive(svc.cfg, kbId);
      const r = await runGbrain(svc.cfg, { args: ["get", slug, "--include-content"], source: kbId, timeoutMs: 30_000 });
      return c.json({ slug, content: r.stdout });
    } catch (e) {
      if (e instanceof CliError && /not found/i.test(String(e.message))) {
        return c.json({ error: { code: "NOT_FOUND", message: "page not found" } }, 404);
      }
      throw e;
    }
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
    // 008：文档软删后实体页不会自动回收。异步回收"不再被任何存活页引用"的
    // 自动创建实体页（先重跑提取，使图与删除后的事实一致；失败仅告警）。
    void new EntityGraphService(svc.cfg)
      .reclaimAfterDocDelete(kbId)
      .then((r) => {
        if (r.reclaimed.length > 0 || r.aborted) {
          console.log(JSON.stringify({ evt: "doc_delete_reclaim", kb: kbId, reclaimed: r.reclaimed.length, candidates: r.candidates, aborted: r.aborted }));
        }
      })
      .catch((e: unknown) => {
        console.log(JSON.stringify({ evt: "doc_delete_reclaim_failed", kb: kbId, error: (e as Error).message.slice(0, 200) }));
      });
    return c.body(null, 204);
  }));

  // 知识图谱（读）：008——租户的确定性检索链走 REST（Agent 走 MCP 图工具），
  // 故在图查询面提供受读授权管控的 REST 端点。
  //
  // 隔离：图查询经内部 client（federated 覆盖全部 kb-*），故**必须**双重收敛——
  // ① 起点 slug 必须属于本 key 可读的库；② 返回的每条路径两端都必须落在可读库内，
  // 否则会跨租户泄漏。
  const slugOwner = (slug: string): string | null => /^(kb-[0-9a-f]{8})\//.exec(slug)?.[1] ?? null;

  const graphTraverse = createRoute({
    method: "get",
    path: "/v1/kb/{id}/graph/traverse",
    tags: ["tenant"],
    summary: "从页面出发的多跳关系遍历（图谱检索）",
    middleware: [tenant],
    security: [{ apiKey: [] }],
    request: {
      params: KbIdParam,
      query: z.object({
        slug: z.string().min(1).describe("起点页 slug（全路径，如 <kb>/entities/battery）"),
        depth: z.coerce.number().int().min(1).max(5).optional(),
        direction: z.enum(["in", "out", "both"]).optional(),
        link_type: z.string().optional(),
      }),
    },
    responses: {
      200: { description: "关系路径", content: { "application/json": { schema: z.object({ paths: z.array(z.record(z.string(), z.unknown())) }) } } },
      ...err403(),
      ...err404("知识库不存在"),
      ...err410(),
      422: { description: "参数不合法", content: { "application/json": { schema: ErrorEnvelope } } },
    },
  });
  app.openapi(graphTraverse, libHandler<typeof graphTraverse>(async (c) => {
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
    const q = c.req.query();
    const owner = slugOwner(q.slug!);
    if (!owner || !canReadKb(key, owner)) {
      return c.json({ error: { code: "INVALID_PARAMS", message: "slug must belong to a kb this key can read" } }, 422);
    }
    const allowed = new Set<string>([kbId, ...(key.writeKb ? [key.writeKb] : []), ...key.readKbs]);
    const args: Record<string, unknown> = { slug: q.slug };
    if (q.depth !== undefined) args.depth = Number(q.depth);
    // 引擎 traverse_graph 的**返回形状随 direction 变化**：不传 direction 返回
    // 节点树（{slug, links[]}），传了才返回边列表（{from_slug,to_slug,...}）。
    // 本端点契约是边列表 ⇒ 必须显式给默认值，否则省略参数会静默返回空数组。
    args.direction = q.direction ?? "both";
    if (q.link_type !== undefined) args.link_type = q.link_type;
    const raw = await svc.graphQuery<Array<Record<string, unknown>>>("traverse_graph", args);
    const paths = (Array.isArray(raw) ? raw : []).filter((p) => {
      const from = slugOwner(String(p.from_slug ?? ""));
      const to = slugOwner(String(p.to_slug ?? ""));
      return from !== null && to !== null && allowed.has(from) && allowed.has(to);
    });
    return c.json({ paths });
  }));

  // 批量导入（写）：tar 归档 md。服务端 slug 归位 + 实体页派生 + 单次 import（含 embed）+ 一次建边。
  // import 不建双链边 → 边由 extract links 幂等补齐（目标不存在的引用永不持久化，与 put auto_link 同语义）。
  // upsert 语义：归档外已有文档不受影响；镜像语义（清掉归档外文档）走 purge + 重放。
  const bulkSubmit = createRoute({
    method: "post",
    path: "/v1/kb/{id}/documents/bulk",
    tags: ["tenant"],
    summary: "批量导入 md 归档（tar -xf 可探测格式；服务端建实体页与图谱边）",
    middleware: [tenant],
    security: [{ apiKey: [] }],
    request: {
      params: KbIdParam,
      body: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z.unknown().openapi({ format: "binary" }).optional().describe("必填（服务端校验）：tar 归档"),
              strip: z.string().optional().describe("剥离归档内公共前缀；缺省自动探测唯一顶层目录"),
              dry_run: z.string().optional().describe('"true" 时只返回 slug 映射，不导入'),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "dry_run 校验结果", content: { "application/json": { schema: BulkDryRunView } } },
      202: { description: "已受理", content: { "application/json": { schema: BulkAccepted } } },
      ...err403(),
      ...err404("知识库不存在"),
      ...err410(),
      413: { description: "归档或解压后超过大小/数量上限", content: { "application/json": { schema: ErrorEnvelope } } },
      422: { description: "归档不可读 / 不安全 / 无有效 md / slug 冲突", content: { "application/json": { schema: ErrorEnvelope } } },
    },
  });
  app.openapi(bulkSubmit, libHandler<typeof bulkSubmit>(async (c) => {
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
    const body = await c.req.parseBody();
    const file = body["file"];
    if (!(file instanceof File)) {
      return c.json({ error: { code: "INVALID_PARAMS", message: 'multipart field "file" is required' } }, 422);
    }
    if (file.size > svc.cfg.MAX_UPLOAD_BYTES) {
      return c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: `archive exceeds ${svc.cfg.MAX_UPLOAD_BYTES} bytes` } }, 413);
    }
    const dryRun = body["dry_run"] === "true";
    const strip = typeof body["strip"] === "string" ? (body["strip"] as string) : undefined;

    mkdirSync(incomingDir(svc.cfg), { recursive: true });
    const incoming = incomingDir(svc.cfg);
    const archivePath = path.join(incoming, `${Date.now()}-${randomHex(6)}-bulk.tar`);
    writeFileSync(archivePath, Buffer.from(await file.arrayBuffer()));
    const rawDir = newBulkTempDir(incoming, "raw");
    let stageDir: string | null = null;
    let accepted = false;
    try {
      // 格式探测委托给 tar（-tf 列成员本身即验证可读性）； supported 集 = 镜像内 tar -xf 可解的格式
      const list = Bun.spawnSync(["tar", "-tf", archivePath], { stdout: "pipe", stderr: "pipe" });
      const tv = Bun.spawnSync(["tar", "-tvf", archivePath], { stdout: "pipe", stderr: "pipe" });
      if (list.exitCode !== 0 || tv.exitCode !== 0) {
        const detail = `${list.stderr.toString()}${tv.stderr.toString()}`.trim().slice(0, 200);
        return c.json({ error: { code: "UNSUPPORTED_ARCHIVE", message: `tar cannot read archive: ${detail || "not a tar stream"}` } }, 422);
      }
      const violations = [
        ...validateArchiveMemberNames(list.stdout.toString().split("\n")),
        ...validateArchiveMemberTypes(tv.stdout.toString().split("\n")),
      ];
      if (violations.length > 0) {
        return c.json({ error: { code: "UNSAFE_ARCHIVE", message: `archive rejected: ${violations.slice(0, 5).join("; ")}` } }, 422);
      }
      // 解包（这一步就是格式探测的执行点；不支持/损坏的流已在 -tf 处被拒）
      const extraction = Bun.spawnSync(["tar", "-xf", archivePath, "-C", rawDir], { stdout: "pipe", stderr: "pipe" });
      if (extraction.exitCode !== 0) {
        const detail = extraction.stderr.toString().trim().slice(0, 200);
        return c.json({ error: { code: "UNSUPPORTED_ARCHIVE", message: `tar extraction failed: ${detail}` } }, 422);
      }
      const rels = listArchiveFiles(rawDir);
      const stripped = applyStrip(rels, strip);
      const srcByStripped = new Map(stripped.map((name, i) => [name, rels[i]!]));
      const plan = planBulkDocs(stripped);
      if (plan.collisions.length > 0) {
        const first = plan.collisions[0]!;
        const more = plan.collisions.length > 1 ? ` (+${plan.collisions.length - 1} more)` : "";
        return c.json({ error: { code: "SLUG_COLLISION", message: `files normalize to the same slug "${first.slug}": ${first.rels.join(", ")}${more}` } }, 422);
      }
      if (plan.docs.length === 0) {
        return c.json({ error: { code: "NO_MARKDOWN", message: "archive contains no .md file (bulk import accepts markdown only; convert other formats client-side)" } }, 422);
      }
      if (plan.docs.length > svc.cfg.BULK_MAX_FILES) {
        return c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: `${plan.docs.length} md files exceed BULK_MAX_FILES=${svc.cfg.BULK_MAX_FILES}` } }, 413);
      }
      stageDir = newBulkTempDir(incoming, "stage");
      let entities: Array<{ slug: string; title: string }>;
      try {
        ({ entities } = buildBulkStage({
          rawDir,
          stageDir,
          kbId,
          docs: plan.docs,
          maxTotalBytes: svc.cfg.MAX_UPLOAD_BYTES,
          resolveSrc: (rel) => srcByStripped.get(rel) ?? rel,
        }));
      } catch (e) {
        stageDir = null; // buildBulkStage 失败时已自行清理 stage
        const msg = (e as Error).message ?? "staging failed";
        if (msg.includes("exceeds")) return c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: msg } }, 413);
        throw e;
      }
      if (dryRun) {
        return c.json({
          kb_id: kbId,
          files: plan.docs.map((d) => ({ file: d.rel, slug: `${kbId}/docs/${d.slug}` })),
          entities: entities.length,
          skipped: plan.skipped.map((sk) => ({ file: sk.rel, reason: sk.reason })),
        }, 200);
      }
      const job = await svc.submitJob({ kbId, type: "bulk", sourceRef: stageDir, title: file.name ?? null });
      accepted = true;
      return c.json({ job_id: job.id, kb_id: kbId, files: plan.docs.length, entities: entities.length, status: job.status }, 202);
    } finally {
      rmSync(archivePath, { force: true });
      rmSync(rawDir, { recursive: true, force: true });
      if (!accepted && stageDir !== null) rmSync(stageDir, { recursive: true, force: true });
    }
  }));

  // 裸文档解析（009）：对外复用解析能力，**零写入**（不产生页面/图谱/任务）。
  // 仅要求凭证有效（不绑定知识库，FR-010）；解析策略完全由部署设定（FR-003 不可覆盖）。
  const parse = createRoute({
    method: "post",
    path: "/v1/kb/parse",
    tags: ["tenant"],
    summary: "裸文档解析（文件 / 网页地址 / 纯文本直通；不写入任何知识库）",
    middleware: [tenant],
    security: [{ apiKey: [] }],
    request: {
      body: {
        required: true,
        content: {
          // 三态输入不可由 OpenAPIHono 统一校验（它按首个 content-type 的 schema 校验，
          // 故各 schema 均须宽松到不误伤其它形态）：必填/大小语义一律由 handler 强制执行
          "multipart/form-data": {
            schema: z.object({ file: z.unknown().openapi({ format: "binary" }).optional().describe("必填（服务端校验）") }),
          },
          "application/json": { schema: z.object({ url: z.string().optional().describe("必填（服务端校验）") }) },
          "text/markdown": { schema: z.string() },
          "text/plain": { schema: z.string() },
        },
      },
    },
    responses: {
      200: { description: "解析结果", content: { "application/json": { schema: ParseResultView } } },
      ...err401(),
      413: { description: "超过大小上限", content: { "application/json": { schema: ErrorEnvelope } } },
      422: { description: "不支持的输入 / 类型 / 解析失败", content: { "application/json": { schema: ErrorEnvelope } } },
      503: { description: "解析容量饱和（可重试）", content: { "application/json": { schema: ErrorEnvelope } } },
    },
  });
  app.openapi(parse, libHandler<typeof parse>(async (c: Context<Env>) => {
    // FR-010：仅要求凭证有效——requireTenant 中间件已校验；此处不查任何知识库授权
    // FR-003：请求中的任何解析器偏好一律不读、不转发（解析策略只由部署设定决定）
    const startedAt = Date.now();
    const contentType = c.req.header("content-type") ?? "";
    const fail = (e: unknown) => {
      if (e instanceof UnsupportedFileTypeError) {
        return c.json({ error: { code: e.code, message: e.message } }, 422);
      }
      if (e instanceof ParserUnavailableError) {
        return c.json({ error: { code: "PARSER_UNAVAILABLE", message: e.message } }, 422);
      }
      const { code, message } = describeParseFailure(e);
      return c.json({ error: { code, message } }, code === "PARSE_BUSY" ? 503 : 422);
    };

    try {
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
        const bytes = new Uint8Array(await file.arrayBuffer());
        // 纯文本直通（md/txt）：零解析、不占解析并发额度（FR-005 / Edge Case）
        if (isPassthroughInput(file.name)) {
          return c.json(parsePassthrough(new TextDecoder().decode(bytes), startedAt));
        }
        // 独立图片是外部解析服务独有能力（与导入端点一致）：未配置时归「通道不可用」
        // 而非「文件类型不支持」——调用方能据此区分「该换输入」与「该开配置」
        const isImage = file.type.startsWith("image/") || isImageExt(file.name);
        return c.json(
          await withParseSlot(svc.cfg, () =>
            isImage
              ? parseImage({ cfg: svc.cfg }, bytes, file.name, startedAt)
              : parseFile({ cfg: svc.cfg }, bytes, file.name, startedAt),
          ),
        );
      }

      if (contentType.includes("application/json")) {
        const body = await c.req.json().catch(() => null);
        const url = (body as { url?: unknown } | null)?.url;
        if (typeof url !== "string" || url === "") {
          return c.json({ error: { code: "INVALID_PARAMS", message: "{url} is required" } }, 422);
        }
        return c.json(await withParseSlot(svc.cfg, () => parseUrl({ cfg: svc.cfg }, url, startedAt)));
      }

      if (contentType.includes("text/markdown") || contentType.includes("text/plain")) {
        const text = await c.req.text();
        if (text.trim() === "") {
          return c.json({ error: { code: "INVALID_PARAMS", message: "text body is empty" } }, 422);
        }
        return c.json(parsePassthrough(text, startedAt));
      }

      return c.json(
        { error: { code: "INVALID_PARAMS", message: "unsupported content-type; use multipart, application/json {url}, or text/markdown" } },
        422,
      );
    } catch (e) {
      return fail(e);
    }
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
    // 契约字段是 snake_case（top_k），内部 RetrievalInput 是驼峰（topK）——
    // 不映射则 topK 恒 undefined，过取与截断静默失效（P10 根因）
    const { query, mode, top_k, graph } = parsed.data;
    const result = await svc.retrieve(kbId, {
      query,
      mode,
      topK: top_k,
      // 缺省时不传 graph ⇒ 纯向量/关键词，行为与历史一致
      graph: graph ? { depth: graph.depth, seedK: graph.seed_k, maxResults: graph.max_results } : undefined,
    });
    return c.json(result);
  }));
}
