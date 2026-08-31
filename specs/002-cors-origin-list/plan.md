# Implementation Plan: 可选的跨域来源列表（CORS）

**Branch**: `002-cors-origin-list` | **Date**: 2026-08-31 | **Spec**: [spec.md](./spec.md)

## Summary

部署级可选来源列表：`CORS_ORIGINS` 环境变量（逗号分隔，空=关闭，`*`=显式全放行）；统一中间件对全部对外端点生效（含 /mcp、/docs、/openapi.json、引擎描述、健康检查），预检直接应答、免鉴权、无副作用。复用 Hono 内置 cors 中间件（零新依赖）。

## Technical Context

**Language/Version**: TypeScript on Bun（与 001/003 一致）

**Primary Dependencies**: hono（内置 `hono/cors` 中间件，origin 回调动态匹配）

**Storage**: 无

**Testing**: 纯函数单元测试（来源匹配器）+ 门控契约测试（预检/回显/拒绝/零外链无关）

**Target Platform**: Linux Docker（env 注入）

**Constraints**: 列表空=零跨域头；精确来源匹配（scheme+host+port）；`*` 显式全放行；预检免鉴权无副作用；非浏览器请求零影响

**Scale/Scope**: 1 个配置项 + 1 个中间件 + 3 类契约断言

## Constitution Check

constitution 未批准模板 → 替代 gate：spec SC-001~004。无违反项（实现面小、无依赖变更）。

## Project Structure

- `packages/core/src/config.ts`：`CORS_ORIGINS` 解析与校验（非法条目启动即拒）
- `packages/core/src/cors.ts`：来源匹配纯函数 `matchOrigin(origins, requestOrigin): string | null`（`*` → `"*"`；精确匹配回显；否则 null）
- `apps/server/src/app.ts`：`app.use("*", corsMiddleware(cfg))`（置于全部路由与鉴权之前）
- `tests/unit/cors.test.ts`：匹配器（空列表/精确/端口变体/`*`/非法条目拒绝）
- `tests/contract/cors.test.ts`（门控）：预检 204 + 回显、放行来源实际请求带头、未列来源无头、OPTIONS 无鉴权通过

## Research

- **D1**: Hono 内置 cors 中间件，`origin: (o, c) => matchOrigin(...) ?? false`；`allowHeaders: [Content-Type, X-API-Key, X-Slug, Authorization]`；`allowMethods: [GET, POST, PATCH, DELETE, OPTIONS]`；`maxAge: 600`。备选：手写中间件（无必要，内置即满足 FR）。
- **D2**: 配置语义——空串=关闭（不注册中间件头）；`*`=全放行（回显 `*`）；非法条目（非 origin 形态）启动抛错（zod refine）。路径/尾斜杠变体按浏览器规范忽略。端口必须显式匹配。
- **D3**: 契约——预检 `OPTIONS` 在 cors 中间件层直接 204 应答（Hono cors 对 OPTIONS 短路），先于任何路由鉴权；`Access-Control-Allow-Origin` 仅对匹配来源回显；未列来源响应无任何 `Access-Control-*` 头。

## Complexity Tracking

无违反项（单配置项单中间件，无升级、无新依赖）。
