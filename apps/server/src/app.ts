import { Hono } from "hono";
import type { Config } from "@core/config";
import type { DB } from "@core/db";
import type { Upstream } from "@core/gbrain-upstream";
import type { McpGateway } from "@core/mcp-gateway";
import type { AdminProxy } from "@core/admin-proxy";
import { handleAdminRequest } from "@core/admin-proxy";
import type { KeyRow } from "@core/credentials";
import { requireAdmin, requireTenant, type Env } from "./middleware/auth";
import { registerKbRoutes } from "./routes/kb";
import { registerKeyRoutes } from "./routes/keys";
import { registerDocumentRoutes } from "./routes/documents";
import { registerRetrievalRoutes } from "./routes/retrieval";
import { registerJobsAdminRoutes } from "./routes/jobs-admin";

export interface Services {
  cfg: Config;
  db: DB;
  upstream: Upstream;
  gateway: McpGateway;
  adminProxy: AdminProxy;
  lookupKey: (hash: string) => Promise<KeyRow | null>;
  serveReady: () => boolean;
  doclingOk: () => Promise<boolean>;
  submitJob: (input: { kbId: string; type: "file" | "url" | "md"; sourceRef: string; title?: string | null }) => Promise<{ id: string; status: string }>;
}

function openapiDoc() {
  return {
    openapi: "3.0.3",
    info: { title: "gbrain-rag", version: "0.1.0" },
    servers: [{ url: "/" }],
    paths: {
      "/health": { get: { summary: "服务健康（含 gbrain_serve/db/docling 状态）" } },
      "/v1/kb": {
        post: { summary: "创建知识库", security: [{ adminToken: [] }] },
        get: { summary: "知识库列表", security: [{ adminToken: [] }] },
      },
      "/v1/kb/{id}": {
        get: { summary: "知识库详情", security: [{ adminToken: [] }] },
        delete: { summary: "归档知识库", security: [{ adminToken: [] }] },
      },
      "/v1/kb/{id}/purge": { post: { summary: "永久清除知识库", security: [{ adminToken: [] }] } },
      "/v1/keys": {
        post: { summary: "签发 agent 凭证（明文仅返回一次）", security: [{ adminToken: [] }] },
        get: { summary: "凭证列表", security: [{ adminToken: [] }] },
      },
      "/v1/keys/{id}": {
        patch: { summary: "变更授权组合", security: [{ adminToken: [] }] },
        delete: { summary: "吊销凭证", security: [{ adminToken: [] }] },
      },
      "/v1/jobs": { get: { summary: "导入任务列表", security: [{ adminToken: [] }] } },
      "/v1/jobs/{id}": { get: { summary: "导入任务详情", security: [{ adminToken: [] }] } },
      "/v1/kb/{id}/documents": {
        post: { summary: "提交导入（multipart 文件 / {url} / text-markdown）", security: [{ apiKey: [] }] },
        get: { summary: "页面列表", security: [{ apiKey: [] }] },
      },
      "/v1/kb/{id}/documents/jobs/{jobId}": { get: { summary: "任务状态", security: [{ apiKey: [] }] } },
      "/v1/kb/{id}/documents/{slug}": { delete: { summary: "删除页面", security: [{ apiKey: [] }] } },
      "/v1/kb/{id}/retrieval": { post: { summary: "检索", security: [{ apiKey: [] }] } },
      "/mcp": { post: { summary: "MCP 网关（Streamable HTTP，X-API-Key）" } },
    },
    components: {
      securitySchemes: {
        adminToken: { type: "http", scheme: "bearer" },
        apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
    },
  };
}

export function createApp(svc: Services): Hono<Env> {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    console.error(JSON.stringify({ evt: "unhandled_error", error: err.message, path: c.req.path }));
    return c.json({ error: { code: "INTERNAL", message: "internal server error" } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "no such route" } }, 404));

  app.get("/openapi.json", (c) => c.json(openapiDoc()));

  app.get("/docs", (c) =>
    c.html(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>gbrain-rag docs</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:"/openapi.json",dom_id:"#ui"});</script></body></html>`,
    ),
  );

  app.get("/health", async (c) => {
    let dbOk = true;
    try {
      await svc.db`SELECT 1`;
    } catch {
      dbOk = false;
    }
    const doclingOk = await svc.doclingOk();
    const serveReady = svc.serveReady();
    const ok = dbOk && serveReady;
    return c.json(
      { status: ok ? "ok" : "degraded", gbrain_serve: serveReady, db: dbOk, docling: doclingOk },
      ok ? 200 : 503,
    );
  });

  const admin = requireAdmin(svc.cfg);
  const tenant = requireTenant(svc.lookupKey);

  registerKbRoutes(app, svc, admin);
  registerKeyRoutes(app, svc, admin);
  registerDocumentRoutes(app, svc, tenant);
  registerRetrievalRoutes(app, svc, tenant);
  registerJobsAdminRoutes(app, svc, admin);

  // 引擎运维代理：/v1/admin/gbrain/*（cli2api spec 驱动，SSE 默认 / format=json 扩展）
  app.all("/v1/admin/gbrain/*", admin, (c) =>
    handleAdminRequest(svc.adminProxy, c.req.raw, "/v1/admin/gbrain"),
  );

  // MCP 网关：Streamable HTTP 透传
  app.all("/mcp", (c) => svc.gateway.handle(c.req.raw));

  return app;
}
