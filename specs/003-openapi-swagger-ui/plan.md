# Implementation Plan: OpenAPI 文档与 Swagger UI

**Branch**: `003-openapi-swagger-ui` | **Date**: 2026-08-31 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-openapi-swagger-ui/spec.md`

## Summary

将现有雏形文档端点正式化为三平面完整、零漂移、自托管的 OpenAPI + Swagger UI：租户/管理面路由迁移到带 schema 的 OpenAPI 路由定义（文档即路由事实，结构性杜绝漂移），引擎代理面复用既有 55 路由描述数据作为第三分组；文档页与交互资源全部自托管（去除 CDN 依赖），并提供一致性校验测试纳入持续集成。

## Technical Context

**Language/Version**: TypeScript 5.x on Bun 1.3+（与 001 一致）

**Primary Dependencies**: `@hono/zod-openapi`（OpenAPI 路由定义与文档生成，需 **zod v4**）、`zod@^4`（自 v3.25 升级）、`swagger-ui-dist`（自托管交互资源，升为直接依赖）、cli2api（既有引擎代理描述数据来源）、Hono 4.13

**Storage**: 无新增存储（文档为运行时生成/既有数据透出）

**Testing**: `bun test`；新增文档-路由一致性校验测试（FR-004/SC-002 的 CI 闸门）

**Target Platform**: Linux Docker（单镜像；新增静态资源随镜像分发）

**Project Type**: web-service（既有 monorepo 内迭代，不新增包）

**Performance Goals**: 文档端点 P95 ≤ 100ms（生成成本为启动期/内存缓存）；页面资源由静态服务承担

**Constraints**: 文档与注册路由零漂移（结构性保证 + CI 校验双保险）；页面及交互资源零外部网络依赖；流式接口如实标注；公开可读假设（spec Assumptions）

**Scale/Scope**: 三平面（自有 ~13 路由全量补齐参数/体/响应 schema + 引擎代理 55 路由分组）；2 个稳定描述地址 + 1 个统一文档页 + 静态资源路由

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` 为未批准模板，无可用 gate。**替代 gate**（沿用 001 惯例）：spec SC-001~004。Phase 0 前检查：技术选型可满足全部 SC（见 research.md）；zod v4 升级为最大风险项，以全量既有测试（36/36）为回归闸门并设定回退路径。Phase 1 后复核：零漂移由"路由定义即文档源"结构性满足 + 一致性校验测试兜底——无违反项。

## Project Structure

### Documentation (this feature)

```text
specs/003-openapi-swagger-ui/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── docs-api.md      # 文档/页面稳定地址与行为契约 + 漂移校验契约
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
apps/server/src/
├── app.ts                       # 迁移至 OpenAPIHono 装配；挂载 /docs、/swagger-ui/*
├── openapi/
│   ├── routes/                  # 各平面路由定义（route definition 即文档源，替代裸 Hono 路由）
│   │   ├── tenant.ts            # 租户面（documents/retrieval）
│   │   ├── admin.ts             # 管理面（kb/keys/jobs-admin）
│   │   └── system.ts            # health/openapi/docs/static
│   ├── schemas.ts               # 请求/响应 Zod schema（唯一事实源，兼运行时校验）
│   └── ui.ts                    # /docs 多分组页面 + /swagger-ui/* 自托管静态资源
packages/core/src/admin-proxy.ts # 不变：透出引擎代理描述数据（第三分组）
tests/
├── contract/openapi-drift.test.ts   # FR-004：文档 paths vs 注册路由 双向一致性
└── contract/docs-ui.test.ts         # 页面/资源自托管断言（零外链）
```

**Structure Decision**: 在既有 monorepo 内迭代。租户/管理面路由从裸 Hono 处理器迁移为 `@hono/zod-openapi` 路由定义（处理器逻辑不变，仅换注册方式并补 schema）；引擎代理面描述数据不迁移、以独立分组并入统一文档页。

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| zod v3→v4 升级（跨特性依赖变更） | `@hono/zod-openapi` 硬性要求 zod ^4 | 手写 manifest + zod-to-json-schema：schema 与路由双份维护，恰是 FR-004 要消灭的漂移源 |
