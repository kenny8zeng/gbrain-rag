# Repository Guidelines

gbrain-rag：以 GBrain 为知识库核心的 **RAG 知识库服务**（单 Bun 镜像）——KB 分区管理、多源文档摄取（docling/anydoc 双解析+回退）、REST 检索、MCP 网关、引擎运维代理。交互语言中文；代码注释/提交信息英文；docs/ 中文为主，README 中英同构。

## Project Overview

- `apps/server`：HTTP 装配层（Hono + zod-openapi），依赖 `packages/core`（workspace `@rag/core`）
- `packages/core`：纯领域层——**无 HTTP 服务器框架**（仅用 Bun 全局 fetch/Response 作出站请求）
- gbrain 引擎不是库：经 `/usr/local/bin/gbrain` 子进程调用；引擎概念（provider/recipe/白名单/OAuth client）对用户隐藏
- 用户配置心智（006）：**每能力三行 = 端点地址 + 纯模型名 + 钥匙**，仅 OpenAI 兼容 API

## Architecture & Data Flow

```text
env（端点三要素）→ deploy/entrypoint.sh → model-router-cli（派生引擎槽位 env + 自愈标记）
              → gbrain init → exec server
apps/server:  Hono 统一路由（openapi/ 路由即文档源）
  ├─ 管理面 Bearer(ADMIN_TOKEN) → KB/凭证/任务/模型配置/引擎代理(/v1/admin/gbrain/*)
  ├─ 租户面 X-API-Key → 导入/检索/MCP
  └─ supervisor 常驻 gbrain serve --http（回环）→ Upstream(client_credentials 换 token)
摄取: rag_jobs 表(SKIP LOCKED worker) → parser(双解析/回退) → pipeline(md 直通) → put+embed
检索: serve 通道(InternalRetrieval, JSON-RPC) 优先 → 失败 retrieval_fallback 到 CLI
```

- **引擎 CLI 唯一入口**：`packages/core/src/gbrain-cli.ts` `runGbrain`——argv 直传不经 shell；分区经 `inv.source` → env `GBRAIN_SOURCE` 钉定（禁止经 args 传 source）
- **serve 通道**：`gbrain-upstream.ts` Upstream（token TTL 缓存、401 刷新、剥 caller 头注入上游 Bearer）；租户流量隔离靠上游 OAuth client（`--source`/`--federated-read`/slug 栅栏/`--surface`）硬保证
- **认证模型**（系统说明 docs/auth-model.md）：管理面 Bearer 比对；租户面 X-API-Key → SHA-256 查表 → KeyRow（writeKb 0/1 + readKbs[]）；授权判定 `canReadKb`/`canWriteKb` 在 `apps/server/src/middleware/auth.ts`（HTTP 层，非 core）；吊销与不存在同 401
- **模型配置链（006）**：用户 env 三要素 → `model-router.ts` 派生槽位（chat→openrouter 槽、embedding→llama-server 槽、rerank 按探测 `/rerank` vs `/reranks` 选槽）→ `endpoint-probe.ts` 真实探测（可达/型号/key/维度/路径形态）→ 启动自愈 config set
- **OpenAPI 零漂移**：`createRoute` 定义即文档源；`tests/contract/openapi-drift.test.ts` CI 闸门守路由双向一致

## Key Directories

```text
packages/core/src/   config · model-router · endpoint-probe · gbrain-cli · gbrain-upstream
                     credentials · kb · db · hash · retrieval · retrieval-serve
                     mcp-gateway · admin-proxy · cors · ingest/{parser,resolver,fallback,
                     pipeline,docling,anydoc-parser}
apps/server/src/     index.ts · app.ts · supervisor.ts · worker.ts
                     middleware/{auth,cors}.ts · openapi/{handler,ui,schemas}.ts
                     openapi/routes/{system,tenant,admin,model-admin}.ts
deploy/              Dockerfile · entrypoint.sh · compose.yaml · .env.example
                     migrations/ · clis/gbrain.yaml(cli2api spec)
tests/               unit/ · contract/ · integration/ · fixtures/
docs/                deployment · usage · examples · testing-strategy · auth-model（中文）
specs/               001-006 speckit 特性目录（006=端点三要素模型配置）
.github/workflows/   test.yml(CI typecheck+unit) · docker-multi-registry.yml(发布)
```

## Development Commands

```bash
bun run test                    # 全量测试【唯一入口】：内部 --timeout 360000 --parallel=1
bun test tests/unit             # L0 单测（无外部依赖，直接跑）
TEST_BASE_URL=http://localhost:3000 ADMIN_TOKEN=... bun test tests/contract   # L1 契约（需实例）
TEST_BASE_URL=... ADMIN_TOKEN=... bun test tests/integration                  # L2 集成（需实例）
bun x tsc --noEmit              # 类型检查
docker compose -f deploy/compose.yaml up -d --build   # 本地栈（:3000，模型配置在 deploy/.env）
docker compose -p gbrain-rag-test -f deploy/compose.test.yaml up -d --build   # 测试隔离实例 3101-3103
```

⚠️ 裸 `bun test` 的 5s 超时误杀慢集成；文件并行触发共享 Postgres/代理闸门竞争假失败（D14 教训）——**永远走 `bun run test`**。无 lint/formatter 强制。

## Code Conventions & Common Patterns

- **分层纪律**：core 不得引入 HTTP 服务器框架（Hono 只在 apps/server）；新能力 = core 纯函数 + server 路由装配；core 模块无 index.ts 桶文件
- **引擎调用**：一律 `runGbrain(cfg, { args, source? })`；禁止绕过 gbrain-cli 裸 spawn
- **路由**：`createRoute({...})` 注册于 `openapi/routes/*.ts`，handler 用 `libHandler<typeof route>(...)` 包（库边界类型桥接）；响应字段 **snake_case**（`source_id` 等——勿用 camelCase，与 OpenAPI schema 一致性由集成断言守护）；错误统一 `{error:{code,message}}` envelope
- **模型配置心智**：用户配置面只出现端点三要素与纯模型名（禁 `:` 前缀）；引擎槽位/recipe/白名单概念不得泄漏到配置/文档；有效性判定用探测（endpoint-probe），不做静态名单
- **凭证安全**：明文仅签发响应一次；入库仅 SHA-256；吊销/不存在同 401 响应（不泄露存在性）；越权 403 无存在性信息
- **领域错误 → HTTP**：`KbNotFoundError` 等错误类由路由 `kbState`/`keyState` 映射（404/410/409）；未预期异常统一 500
- **并发/异步**：摄取 worker 用 `SKIP LOCKED` 认领 + 心跳 + 回收；admin 代理并发闸门 ProxyGate 自愈（60s 残留清空——勿依赖 cli2api runCli 内部释放，D14）
- **测试纪律**：修 bug → 先补回归测试 → 修码 → 更新缺陷台账（docs/testing-strategy.md §4，D# 编号）
- **docs 语言**：docs/ 中文；README 中英同构（改一处必须同步另一处）；发布流程细节归 CONTRIBUTING（用户 README 只留镜像表）

## Important Files

| 文件 | 作用 |
|---|---|
| `packages/core/src/config.ts` | 全部 env schema（必填 ADMIN_TOKEN/DATABASE_URL；端点三要素；PARSER_MODE/PREFERENCE；GBRAIN_*/LLAMA_SERVER_* 为派生内部变量，非用户入口） |
| `packages/core/src/model-router.ts` / `endpoint-probe.ts` / `model-router-cli.ts` | 006 模型配置链（派生 + 探测 + entrypoint CLI） |
| `packages/core/src/gbrain-cli.ts` / `gbrain-upstream.ts` | 引擎 CLI 唯一入口 / serve 通道客户端 |
| `packages/core/src/credentials.ts` / `kb.ts` | 凭证生命周期（issue/rescope/revoke）/ KB 生命周期（create/archive/purge，30s snapshot 缓存） |
| `packages/core/src/ingest/pipeline.ts` | 摄取主流程：md 直通分支 / file 走 convertWithFallback / url 恒 docling |
| `apps/server/src/index.ts` | 启动序：migrate → 模型预检 → 自愈 config set → supervisor → worker → listen |
| `apps/server/src/middleware/auth.ts` | requireAdmin/requireTenant + canReadKb/canWriteKb（HTTP 层语义） |
| `deploy/entrypoint.sh` | env 必填校验 → `bun model-router-cli.ts` 派生 eval → `gbrain init`（幂等）→ exec server |
| `deploy/clis/gbrain.yaml` | cli2api spec——`/v1/admin/gbrain/*` 引擎代理的路由来源 |

## Runtime/Tooling Preferences

- **运行时唯一 Bun**（禁 Node.js）；`@core/*` path alias → `packages/core/src/*`
- gbrain 引擎固定 **v0.47.6.0**（Dockerfile 从 garrytan/gbrain 源码构建）；**npm `gbrain` 是同名无关项目，不可用**；调试引擎行为可 `docker exec gbrain`（本机评估容器，8787）或 `gbrain models doctor`
- 容器内无 curl——验证用 `bun -e` 或 exec gbrain CLI
- URL 导入不做地址校验（FR-013 决策）：部署必须受信隔离网络，文档含安全告示
- Zeabur 是维护者个人部署环境——不进项目文档（平台中立）

## Testing & QA

- 框架 Bun test；金字塔 L0 unit(<1s) / L1 contract(~10s) / L2 integration(~90s) / L3 scripts/scale-check.ts 手动
- 基线 ~137 tests / 27 files（以 `bun run test` 实际输出为准）；CI 只跑 typecheck + tests/unit（集成/契约需真实实例，本地跑）
- **门控模式**（集成/契约文件顶部）：
  ```ts
  const gated = BASE && ADMIN ? describe : describe.skip;  // BASE=TEST_BASE_URL
  ```
  us5 anydoc-only 另需 `parser_mode==="anydoc" && docling===false`（docling 可用即跳过）
- 契约 `openapi-drift` 纯构造零 HTTP（注册真实路由 + 桩 Services，伪造 gbrain 二进制）；`limits` 413 用例探测式自适应（1MB 测试实例 vs 100MB 生产）
- 集成测试自清理：随机前缀资源 + afterAll 归档/purge；**禁止并行实例共享 Postgres 任务表**
- 引擎侧行为（白名单/维度/doctor）无法单测 → 集成门控用例 + 运行期 `models doctor` 实测为准
- 修改 env/schema 后先 `bun x tsc --noEmit`；契约变化必须同步 OpenAPI 路由定义与 docs/usage.md 错误码表
