# gbrain-rag

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-%23fbf0df)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org)

以 [GBrain](https://github.com/garrytan/gbrain) 为知识库核心的 **RAG 知识库服务**：统一入口聚合知识分区管理、多来源文档摄取（docling / anydoc 双解析器，失败自动回退）、REST 检索与面向 AI Agent 的 MCP 网关。

## 架构

单镜像单 Bun 进程（统一路由 + MCP 网关 + 摄取 worker），`gbrain serve --http` 为受监督子进程（仅容器回环）；外部依赖 Postgres(pgvector) 与 docling-serve。

```text
AI Agent ──X-API-Key──▶ ┌──────────────────────────────┐
应用     ──X-API-Key──▶ │ gbrain-rag (Bun)             │ ──▶ docling-serve（文档/图片/URL → MD）
管理员   ──Bearer─────▶ │  Hono 统一路由               │ ──▶ Postgres + pgvector
                        │  MCP 网关 → gbrain serve     │
                        │  摄取 worker → gbrain CLI    │
                        └──────────────────────────────┘
```

- **知识库（KB）** = gbrain source；`POST /v1/kb` 自动供给（目录 + git + sources add）
- **Agent 凭证** = 一枚 gbrain OAuth client：写分区唯一（`--source` + slug 栅栏），读授权 `--federated-read` 事前审批组合，跨源检索自动合并（引擎侧硬隔离，实证见 `specs/001-gbrain-rag-service/research.md` D2）
- **摄取**：文件（含图片）/网页 URL/Markdown 直传 → 解析器转换 → 单文档单页面 → gbrain 分块 + embed；异步任务表驱动，失败重试 3 次
  - **解析器选择**：`DOCLING_URL` 配置 → 双解析器并存：`PARSER_PREFERENCE=docling`（默认，失败自动回退 anydoc）或 `=anydoc`（毫秒级本地，失败回退 docling）；url/图片恒走 docling。为空 → 内置 anydoc 唯一（url/独立图片明确拒绝并指引）。`PARSER_MODE` 强制单解析器（测试/排障，无回退）；扫描 PDF 配 `FIRECRAWL_API_KEY` + `ANYDOC_OCR=on` 自动走托管 OCR
- **管理代理**：`/v1/admin/gbrain/*` 经 cli2api（git 依赖，零源码改动）暴露 gbrain 全量 CLI；只读状态路由支持 `?format=json`

## 快速开始

```bash
cd deploy
cp .env.example .env      # 修改 ADMIN_TOKEN；按需填 DOCLING_URL / EMBEDDING / RERANKER
docker compose up -d --build
curl localhost:3000/health
```

端到端验证流程见 `specs/001-gbrain-rag-service/quickstart.md`。

## 接口

| 平面 | 鉴权 | 代表接口 |
|---|---|---|
| 管理面 | `Authorization: Bearer $ADMIN_TOKEN` | `POST/GET /v1/kb`、`DELETE /v1/kb/:id`、`POST/PATCH/DELETE /v1/keys`、`GET /v1/jobs`、`/v1/admin/gbrain/*` |
| 租户面 | `X-API-Key: gbrag_...` | `POST /v1/kb/:id/documents`、`GET/DELETE .../documents/:slug`、`POST /v1/kb/:id/retrieval`、`POST /mcp` |

## API 文档

- `GET /openapi.json` — 服务接口描述（租户/管理面，OpenAPI 3.x，双鉴权方案）
- `GET /v1/admin/openapi/gbrain.json` — 引擎运维代理描述（55 路由）
- `GET /docs` — 自托管交互文档（分组切换 + 凭证录入在线执行，零外部网络依赖）
- 文档与注册路由零漂移：`tests/contract/openapi-drift.test.ts` 为 CI 闸门

完整契约：`specs/001-gbrain-rag-service/contracts/`、`specs/003-openapi-swagger-ui/contracts/docs-api.md`。

## 环境变量

见 `deploy/.env.example`。

> ⚠️ **安全提示（spec FR-013）**：URL 导入**不做任何地址校验**（SSRF 风险由调用方输入与部署边界承担）。本服务必须部署在与敏感内网隔离的受信环境；如需公网暴露，必须先收紧该策略并补充网络层防护。

## 开发

```bash
bun install
bun test tests/unit                 # 单元测试（无外部依赖）
TEST_BASE_URL=http://localhost:3000 ADMIN_TOKEN=... bun test tests/contract   # 契约（需运行实例）
bun test tests/integration          # 集成全链路（需 compose 栈）
```

代码结构：`apps/server`（装配/supervisor/worker/路由）+ `packages/core`（领域模块，无 HTTP 依赖）。

## 文档

### 快速上手

| 文档 | 内容 |
|---|---|
| [docs/deployment.md](docs/deployment.md) | **部署说明**：架构/环境变量全表/持久化与备份/升级/故障排查 |
| [docs/usage.md](docs/usage.md) | **使用介绍**：概念模型/接口平面/导入与检索/MCP/错误码速查 |
| [docs/examples.md](docs/examples.md) | **使用示例**：完整可复制会话（建库→发凭证→导入→检索→权限→删除） |

### API 与契约

| 地址/文档 | 内容 |
|---|---|
| `GET /docs` | Swagger UI 交互文档（服务 + 引擎代理，可在线执行） |
| `GET /openapi.json` | 服务接口 OpenAPI 描述 |
| [specs/](specs/) | 特性 spec/plan/tasks（001 核心、002 CORS、003 OpenAPI、004 anydoc、005 解析优先级） |

### 工程与社区

| 文档 | 内容 |
|---|---|
| [docs/testing-strategy.md](docs/testing-strategy.md) | 测试方案：缺陷台账、金字塔门禁、四实例矩阵 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南（架构约定/测试纪律/提交规范） |
| [CHANGELOG.md](CHANGELOG.md) | 变更日志（Keep a Changelog） |
| [SECURITY.md](SECURITY.md) | 安全策略与漏洞报告 |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | 贡献者公约 |

## 发布镜像（GitHub Actions）

多架构（`linux/amd64`、`linux/arm64`）镜像由 [`.github/workflows/docker-multi-registry.yml`](.github/workflows/docker-multi-registry.yml) 自动构建并发布到双注册表：

| 注册表 | 镜像 |
|---|---|
| GHCR | `ghcr.io/kenny8zeng/gbrain-rag` |
| Docker Hub | `kenny8zeng/gbrain-rag` |

### 触发与标签

| 触发 | 标签 |
|---|---|
| 推送 `main` | `main`、`latest` |
| Tag `v*`（如 `v0.1.0`） | tag、`latest` |
| 手动 `workflow_dispatch` | 分支 ref、`latest` |

### 一次性配置（仓库 Settings → Secrets and variables → Actions）

- `DOCKERHUB_USERNAME`（Variables 或 Secrets）
- `DOCKERHUB_TOKEN`（Secrets，Docker Hub 个人访问令牌，Read & Write 权限）

GHCR 无需配置（自动 `GITHUB_TOKEN` + `packages: write`）。镜像内 gbrain 固定从 `garrytan/gbrain` v0.47.6.0 源码构建（见 `deploy/Dockerfile`）。

## 许可证

[MIT](LICENSE)（Copyright (c) 2026 gbrain-rag contributors）
