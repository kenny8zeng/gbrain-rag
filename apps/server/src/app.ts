import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Config } from "@core/config";
import type { DB } from "@core/db";
import type { Upstream } from "@core/gbrain-upstream";
import type { McpGateway } from "@core/mcp-gateway";
import type { AdminProxy } from "@core/admin-proxy";
import { handleAdminRequest } from "@core/admin-proxy";
import type { KeyRow } from "@core/credentials";
import type { RetrievalInput, RetrievalResponse } from "@core/retrieval";
import { requireAdmin, requireTenant, type Env } from "./middleware/auth";
import { registerSystemRoutes } from "./openapi/routes/system";
import { registerTenantRoutes } from "./openapi/routes/tenant";
import { registerAdminRoutes } from "./openapi/routes/admin";
import { registerDocsUi } from "./openapi/ui";
import { corsMiddleware } from "./middleware/cors";

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
  retrieve: (kbId: string, input: RetrievalInput) => Promise<RetrievalResponse>;
}

/** 422 统一 envelope（OpenAPIHono 校验失败的出口） */
function validationHook(result: unknown, c: Context<Env>) {
  const r = result as {
    success?: boolean;
    error?: { issues?: Array<{ path?: (string | number | symbol)[]; message?: string }> };
  };
  if (r && typeof r === "object" && r.success === true) return;
  const details = (r?.error?.issues ?? [])
    .slice(0, 5)
    .map((i) => `${(i.path ?? []).join(".")}: ${i.message ?? "invalid"}`);
  return c.json(
    { error: { code: "INVALID_PARAMS", message: "request validation failed", details } },
    422,
  );
}

/** 服务描述文档：注册路由结构化生成 + /mcp 说明条目（spec FR-005/D5） */
export function buildOpenApiDoc(app: OpenAPIHono<Env>): Record<string, unknown> {
  const doc = app.getOpenAPIDocument({
    openapi: "3.0.3",
    info: { title: "gbrain-rag", version: "0.1.0" },
    servers: [{ url: "/" }],
    tags: [
      { name: "tenant", description: "租户面（导入/检索/任务）" },
      { name: "admin", description: "管理面（知识库/凭证/任务）" },
      { name: "system", description: "系统" },
    ],
  }) as unknown as Record<string, unknown>; // 库边界：OpenAPIObject → 通用 JSON 注入 /mcp 说明条目

  const paths = (doc.paths ?? {}) as Record<string, unknown>;
  paths["/mcp"] = {
    post: {
      summary: "MCP 网关（Streamable HTTP，X-API-Key 鉴权）",
      description:
        "MCP 协议端点：JSON-RPC over Streamable HTTP（initialize/tools 等），语义见 specs/001-gbrain-rag-service/contracts/mcp-gateway.md。不适用 OpenAPI 请求体描述。",
      tags: ["tenant"],
      security: [{ apiKey: [] }],
      "x-streaming": true,
    },
  };
  doc.paths = paths;
  return doc;
}

export function createApp(svc: Services): OpenAPIHono<Env> {
  const app = new OpenAPIHono<Env>({ defaultHook: validationHook });

  app.onError((err, c) => {
    console.error(JSON.stringify({ evt: "unhandled_error", error: err.message, path: c.req.path }));
    return c.json({ error: { code: "INTERNAL", message: "internal server error" } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "no such route" } }, 404));

  // 安全方案（文档 components.securitySchemes）
  app.openAPIRegistry.registerComponent("securitySchemes", "adminToken", {
    type: "http",
    scheme: "bearer",
    description: "管理面令牌",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "apiKey", {
    type: "apiKey",
    in: "header",
    name: "X-API-Key",
    description: "租户密钥（gbrag_...）",
  });

  // CORS：先于一切路由与鉴权（预检免鉴权直接应答，FR-005）
  app.use("*", corsMiddleware(svc.cfg));

  const admin = requireAdmin(svc.cfg);
  const tenant = requireTenant(svc.lookupKey);

  registerSystemRoutes(app, svc);
  registerTenantRoutes(app, svc, tenant);
  registerAdminRoutes(app, svc, admin);

  // 稳定地址：服务描述（结构化生成 + /mcp 说明条目）
  app.get("/openapi.json", (c) => c.json(buildOpenApiDoc(app)));

  // 引擎代理描述（既有数据原样透出）与统一交互文档页（自托管）
  app.get("/v1/admin/openapi/gbrain.json", (c) => c.json(svc.adminProxy.spec.doc)); // 公开（docs-api 契约）
  registerDocsUi(app);

  // 引擎运维代理：/v1/admin/gbrain/*（cli2api spec 驱动，SSE 默认 / format=json 扩展）
  app.all("/v1/admin/gbrain/*", admin, (c) =>
    handleAdminRequest(svc.adminProxy, c.req.raw, "/v1/admin/gbrain"),
  );

  // MCP 网关：Streamable HTTP 透传
  app.all("/mcp", (c) => svc.gateway.handle(c.req.raw));

  return app;
}
