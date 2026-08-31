import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "../middleware/auth";
import path from "node:path";

/**
 * 自托管交互文档页与静态资源（spec FR-003 / SC-003：零外部网络依赖）。
 * 资源取自 swagger-ui-dist 包，白名单外一律 404。
 */
const SWAGGER_DIST = path.join(process.cwd(), "node_modules/swagger-ui-dist");
const SWAGGER_FILES: Record<string, string> = {
  "swagger-ui.css": "text/css; charset=utf-8",
  "swagger-ui-bundle.js": "application/javascript; charset=utf-8",
  "swagger-ui-standalone-preset.js": "application/javascript; charset=utf-8",
  "favicon-16x16.png": "image/png",
  "favicon-32x32.png": "image/png",
  "oauth2-redirect.html": "text/html; charset=utf-8",
  "index.css": "text/css; charset=utf-8",
};

const DOCS_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gbrain-rag — API 文档</title>
<link rel="stylesheet" href="/swagger-ui/swagger-ui.css">
<link rel="stylesheet" href="/swagger-ui/index.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="/swagger-ui/swagger-ui-bundle.js"></script>
<script src="/swagger-ui/swagger-ui-standalone-preset.js"></script>
<script>
window.onload = () => {
  window.ui = SwaggerUIBundle({
    urls: [
      { name: "gbrain-rag（服务接口）", url: "/openapi.json" },
      { name: "gbrain 引擎运维代理", url: "/v1/admin/openapi/gbrain.json" },
    ],
    "urls.primaryName": "gbrain-rag（服务接口）",
    dom_id: "#swagger-ui",
    deepLinking: true,
    displayRequestDuration: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    layout: "StandaloneLayout",
  });
};
</script>
</body>
</html>`;

export function registerDocsUi(app: OpenAPIHono<Env>): void {
  app.get("/docs", (c) => c.html(DOCS_PAGE));

  app.get("/swagger-ui/:file", (c) => {
    const file = c.req.param("file");
    const contentType = SWAGGER_FILES[file];
    if (!contentType) return c.json({ error: { code: "NOT_FOUND", message: "no such asset" } }, 404);
    return new Response(Bun.file(path.join(SWAGGER_DIST, file)), {
      headers: { "Content-Type": contentType },
    });
  });
}
