import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { Services } from "../../app";
import type { Env } from "../../middleware/auth";
import { Health } from "../schemas";
import { resolveParserFor } from "@core/ingest/resolver";

/** 系统面：健康检查（公开，无 security） */
export function registerSystemRoutes(app: OpenAPIHono<Env>, svc: Services): void {
  const health = createRoute({
    method: "get",
    path: "/health",
    tags: ["system"],
    summary: "服务健康（含 gbrain_serve/db/docling 状态）",
    responses: {
      200: { description: "健康", content: { "application/json": { schema: Health } } },
      503: { description: "降级", content: { "application/json": { schema: Health } } },
    },
  });

  app.openapi(health, async (c) => {
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
      {
        status: ok ? "ok" : "degraded",
        gbrain_serve: serveReady,
        db: dbOk,
        docling: doclingOk,
        parser_mode: resolveParserFor(svc.cfg).mode,
        parser_primary: resolveParserFor(svc.cfg).mode,
        parser_preference: svc.cfg.PARSER_PREFERENCE,
      },
      ok ? 200 : 503,
    );
  });

}
