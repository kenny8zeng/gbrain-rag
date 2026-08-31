# Implementation Plan: GBrain 核心 RAG 知识库服务

**Branch**: `001-gbrain-rag-service` | **Date**: 2026-08-31 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-gbrain-rag-service/spec.md`

## Summary

以 GBrain 为知识库核心构建统一入口的 RAG 知识库服务：管理面（知识库/凭证生命周期 + 知识引擎全量运维代理）与租户面（多来源文档异步导入、统一 REST 检索、Agent MCP 网关）聚合在单进程单端口服务内；文档经独立部署的 Docling 转换为 Markdown 后按"单文档单页面"入库，索引与向量检索全部由 GBrain 承担。技术路线：Bun 单体进程 + `gbrain serve --http` 子进程，MCP 通道按凭证注册上游 OAuth client 实现引擎侧硬隔离（federated-read 语义已在 v0.47.6.0 实证），CLI 通道单 admin 凭证逐调用钉定分区。

## Technical Context

**Language/Version**: TypeScript 5.x on Bun 1.3+

**Primary Dependencies**: Hono（HTTP 路由/SSE）、Zod（请求校验）、vendored cli2api core（registry/runner/argv）、GBrain CLI v0.47+（子进程 + serve --http）、Docling-serve v1.30+（外部 HTTP）、`@modelcontextprotocol/sdk`（仅测试客户端；服务端为纯 HTTP 代理）

**Storage**: PostgreSQL 16 + pgvector（GBrain schema + 自有 `rag_keys`/`rag_jobs` 表）；本地卷（per-KB git 目录、原始文档档案）

**Testing**: `bun test`（contract / integration / unit 三层，对 compose 栈跑集成）

**Target Platform**: Linux Docker（单镜像多阶段构建：Bun 应用层 + 从 `github.com/garrytan/gbrain` v0.47.6.0 源码编译的 gbrain 二进制层；compose 附 postgres:16-pgvector）
 
**Project Type**: web-service（bun workspaces 单体：`apps/server` + `packages/core` + `packages/cli2api`）

**Performance Goals**: SC-001 文档导入端到端（≤50 页 PDF）P95 ≤ 5 分钟；SC-002 检索 P95 ≤ 2s；SC-004 ≥20 库 / 单库 ≥1 万文档 / 10 并发检索满载不劣化

**Constraints**: 单实例无 HA；URL 导入不做地址校验（受信环境专用，见 spec FR-013）；单文件 ≤100MB；MCP 网关剥离调用方 Authorization 头并按凭证换发上游 token

**Scale/Scope**: 单组织内部服务；~55 条引擎运维代理路由 + ~12 条自有 REST 路由 + 1 个 MCP 网关端点

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` 为未批准模板（无任何已填原则），无可用 gate。**替代 gate**：spec 的 7 条 Success Criteria。Phase 0 前检查：全部需求均有对应技术方案（见 research.md），无未决澄清。Phase 1 后复核：隔离性（SC-003）由"每凭证上游 OAuth client + 请求级不透传 source"双通道保障；规模（SC-004）由 Postgres 任务表 + SKIP LOCKED worker 承载——无违反项。

## Project Structure

### Documentation (this feature)

```text
specs/001-gbrain-rag-service/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   ├── rest-api.md      # 管理面 + 租户面 REST 契约
│   ├── mcp-gateway.md   # MCP 网关接入契约
│   └── admin-proxy.md   # 引擎运维代理契约（SSE + format=json）
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
apps/
└── server/                      # 唯一可执行入口
   └── src/
      ├── index.ts               # 启动：config → db migrate → supervisor → hono → worker
      ├── supervisor.ts          # gbrain serve --http 子进程监督（重启/信号转发）
      └── worker.ts              # 摄取 worker loop（SKIP LOCKED 认领）
packages/
├── core/                        # 领域模块（无 HTTP 依赖，可独立测试）
│   └── src/
│    ├── config.ts               # 环境变量装载与校验
│    ├── db.ts                   # Bun SQL 连接 + 迁移执行
│    ├── gbrain-cli.ts           # CLI 调用封装（spawn、GBRAIN_SOURCE 钉定、--json 解析）
│    ├── gbrain-upstream.ts      # serve --http 上游客户端（OAuth client_credentials token 缓存/刷新）
│    ├── kb.ts                   # 知识库生命周期（目录/git init/sources add/archive/purge）
│    ├── credentials.ts          # 凭证签发/变更/吊销（联动上游 register/rescope/revoke-client）
│    ├── ingest/                 # 摄取管道（docling 调用、规范化、入库、embed）
│    ├── retrieval.ts            # 检索（query/search --json 规范化）
│    └── mcp-gateway.ts          # MCP 反向代理（鉴权→取凭证→换 token→转发→剥离头）
├── cli2api/                     # 自 cli2api 项目提炼（含 x-cli.jsonArg 扩展）
│   └── src/{registry,runner,argv}.ts + clis/gbrain.yaml
deploy/
├── Dockerfile                   # 多阶段：bun 应用构建层 + gbrain 源码编译层（github.com/garrytan/gbrain）
├── compose.yaml                 # gbrain-rag + postgres:16-pgvector
├── entrypoint.sh                # gbrain init --url 幂等 → 启动 server
└── migrations/0001-init.sql     # rag_keys / rag_jobs
tests/
├── contract/                    # REST/MCP 契约测试
├── integration/                 # compose 栈全链路（含双源隔离对照）
└── unit/                        # core 模块单测（CLI 封装 mock）
```

**Structure Decision**: bun workspaces 单体。`packages/core` 不依赖 Hono，保证领域逻辑可用单测覆盖；`packages/cli2api` 保持与上游 cli2api 同构（registry/runner/argv + YAML spec），便于跟上游同步；`apps/server` 只做装配。

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

（无违反项；constitution 未批准，无登记必要）
