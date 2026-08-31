# gbrain-rag

以 [GBrain](https://github.com/garrytan/gbrain) 为知识库核心的 RAG 知识库服务：统一入口聚合知识分区管理、多来源文档摄取、REST 检索与面向 AI Agent 的 MCP 网关。

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
- **摄取**：文件（含图片）/网页 URL/Markdown 直传 → docling 转换 → 单文档单页面 → gbrain 分块 + embed；异步任务表驱动，失败重试 3 次
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

Swagger：`GET /docs`。完整契约：`specs/001-gbrain-rag-service/contracts/`。

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
