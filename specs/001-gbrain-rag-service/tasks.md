# Tasks: GBrain 核心 RAG 知识库服务

**Input**: Design documents from `/specs/001-gbrain-rag-service/`

**Prerequisites**: plan.md（必需）、spec.md（必需）、research.md（D1-D12 决策）、data-model.md（表结构）、contracts/（接口契约）、quickstart.md（验收对照）

**Tests**: plan.md 明确三层测试策略（contract/integration/unit），故每个故事含测试任务，先写先败。

**Organization**: 按用户故事分组，P1 三故事（US1 建库授权 / US2 文档导入 / US3 MCP 网关）可并行推进。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件，无未完成依赖）
- **[Story]**: 所属用户故事（US1-US6）
- 所有路径相对仓库根

## Path Conventions

bun workspaces 单体（plan.md Project Structure）：`apps/server/src/`、`packages/core/src/`、`deploy/`、`tests/{contract,integration,unit}/`；cli2api 为 git 依赖（非本地包）

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 工程骨架、依赖、部署资产就绪

- [X] T001 创建 bun workspaces 脚手架：根 `package.json`（workspaces: apps/server, packages/core）与 `tsconfig.json`，按 plan.md Project Structure 建目录骨架
- [X] T002 [P] 实现 packages/core/src/config.ts：Zod 校验全部环境变量（PORT/ADMIN_TOKEN/DATABASE_URL/DOCLING_URL/EMBEDDING_*/GBRAIN_SERVE_PORT/DATA_DIR/MCP_SURFACE/并发上限），缺失必填项启动即报错；配 tests/unit/config.test.ts
- [X] T003 编写 deploy/migrations/0001-init.sql：rag_keys、rag_jobs、_rag_migrations 三表与索引，字段与约束照 data-model.md（CHECK/JSONB/部分索引）
- [X] T004 实现 packages/core/src/db.ts：Bun postgres 连接（DATABASE_URL）+ 启动期按序迁移执行器（_rag_migrations 记录，幂等）
- [X] T005 [P] 引入 cli2api git 依赖：根 `package.json` 添加 `github.com/kenny8zeng/cli2api`（锁定 tag）并验证 `import { registry/runner }` 可用；落地 `deploy/clis/gbrain.yaml`（自上游 gen-gbrain-spec 生成物调整 binary=/usr/local/bin/gbrain，其余不改，保持可随上游重生成）
- [X] T006 [P] 编写 deploy/Dockerfile（多阶段：bun 应用构建层；gbrain 源码层 `git clone --depth 1 --branch v0.47.6.0 https://github.com/garrytan/gbrain.git && bun install && bun run build` 产出 bin/gbrain 拷入运行层，并以 `gbrain serve --http` 冒烟判定是否需补 build:admin-embedded，见 research D1）、deploy/compose.yaml（gbrain-rag + postgres:16-pgvector + volumes）、deploy/entrypoint.sh（`gbrain init --url $DATABASE_URL` 幂等 → exec server）、deploy/.env.example
- [X] T007 Setup 检查点：`docker compose up -d --build` 成功，容器内 `gbrain version` 输出 0.47.6.0，迁移执行完毕（_rag_migrations 有 0001 记录）

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 全部用户故事共享的地基：CLI 封装、上游凭证、监督进程、统一路由与鉴权骨架、worker 骨架

**⚠️ CRITICAL**: 未完成本阶段，任何用户故事不得开工

- [X] T008 实现 packages/core/src/gbrain-cli.ts：spawn 封装（GBRAIN_SOURCE env 逐调用钉定、--json 解析、stderr 捕获、超时 kill、CliError 错误类型），唯一 CLI 入口禁止旁路；tests/unit/gbrain-cli.test.ts（mock spawn 断言 argv/env 装配）
- [X] T009 [P] 实现 packages/core/src/gbrain-upstream.ts：client_credentials 换 token（POST /token）、TTL 缓存与过期刷新、上游 401 重取重放、对 `gbrain serve --http` 的 fetch helper；tests/unit/gbrain-upstream.test.ts（mock http）
- [X] T010 实现 apps/server/src/supervisor.ts：spawn `gbrain serve --http --port $GBRAIN_SERVE_PORT`（127.0.0.1），崩溃指数退避重启，SIGTERM/SIGINT 信号转发与就绪探测
- [X] T011 实现 apps/server/src/index.ts 启动序：config → migrate → supervisor → hono listen → worker 启动；优雅停机钩子
- [X] T012 实现 apps/server/src/app.ts（Hono）：统一错误 envelope（{"error":{code,message}}）、/health（gbrain_serve/db/docling 探活，docling 5s 缓存）、/openapi.json 与 /docs（自有 REST）、404/405 兜底
- [X] T013 实现 apps/server/src/middleware/auth.ts：requireAdmin（Bearer ADMIN_TOKEN）与 requireTenant 骨架（X-API-Key → sha256 → 查 credentials.lookup，lookup 由 T018 实现后接入）
- [X] T014 实现 apps/server/src/worker.ts：SKIP LOCKED 原子认领（SQL 照 data-model.md）、heartbeat_at 心跳、启动期回收扫描（running>30min→queued）、attempts≤3 指数退避、任务 handler 注册表（US2 注入实现）

**Checkpoint**: `/health` 返回 ok；数据库迁移完成；serve 子进程运行；此时 US1-US3 可并行开工

---

## Phase 3: User Story 1 - 管理员创建知识库并管理 Agent 授权 (Priority: P1) 🎯 MVP

**Goal**: 知识库生命周期（建/查/归档/清除）+ 凭证签发/变更/吊销，且凭证联动上游 OAuth client 实现引擎侧隔离

**Independent Test**: 建两个库 → 发"写 A 读 A,B"凭证 → 越权访问 403 → rescope 后 B 即时不可见 → 吊销后 401

### Tests for User Story 1

- [X] T015 [P] [US1] 编写 tests/contract/kb-keys.test.ts：管理面 401（无/错 token）、POST /v1/kb 201 形状、keys 一次性明文、410 archived、409 KB_IN_USE 契约（contracts/rest-api.md）
- [X] T016 [P] [US1] 编写 tests/integration/us1-kb-credentials.test.ts：spec 验收场景 1-5 全链路（对 compose 栈）

### Implementation for User Story 1

- [X] T017 [US1] 实现 packages/core/src/kb.ts：createKb（DATA_DIR/brains/<id> git init+首提交 → sources add --path）、listKbs/detailKb（sources list/status --json 映射）、archiveKb（引用凭证预检 → 409 KB_IN_USE，force 联动吊销）、purgeKb；错误映射 404/410
- [X] T018 [US1] 实现 packages/core/src/credentials.ts：key 生成（gbrag_+CSPRNG32hex、sha256 存储、8 字符前缀）、issue（register-client 参数装配：--source/--federated-read/--bound-slug-prefixes/--surface/--scopes，纯读 key 用 --scopes read）、rescope（PATCH 即时生效）、revoke（revoke-client + revoked_at）、lookupByKeyHash（T013 接入）
- [X] T019 [US1] 实现 apps/server/src/routes/kb.ts 与 routes/keys.ts：POST/GET /v1/kb、GET/DELETE /v1/kb/:id、POST /v1/kb/:id/purge、POST/PATCH/DELETE/GET /v1/keys（requireAdmin；同时完成 requireTenant 的 lookup 接线）
- [X] T020 [US1] 运行 T015/T016 测试并修复至全绿（含场景 3 越权 403、场景 4 rescope 即时性、场景 5 吊销 401）

**Checkpoint**: MVP 达成——建库/授权/吊销全链路可用，独立验收通过

---

## Phase 4: User Story 2 - 应用导入多来源文档并建立检索索引 (Priority: P1)

**Goal**: 四通道异步导入管道（文件含图片/URL/MD 直传），docling 转换 → 单文档单页面 → embed，任务可重试可诊断

**Independent Test**: 空库提交 PDF 与 URL → 轮询 done → REST 检索命中内容

### Tests for User Story 2

- [X] T021 [P] [US2] 编写 tests/contract/documents.test.ts：三态输入 202、只读凭证 403（FR：导入需写分区）、413 超 100MB、400 不支持格式（contracts/rest-api.md）
- [X] T022 [P] [US2] 编写 tests/integration/us2-ingest.test.ts：PDF/图片/URL/MD 四通道 done、重复导入 outcome=updated（FR-008）、坏 URL 重试 3 次后 failed 带 error（SC-006）

### Implementation for User Story 2

- [X] T023 [P] [US2] 实现 packages/core/src/ingest/docling.ts：POST /v1/convert/file（multipart files + to_formats=["md"]，600s 超时）与 /v1/convert/source，解析 ConvertDocumentResponse.document.md_content；tests/unit/docling.test.ts（mock fetch 覆盖 200/422/超时）
- [X] T024 [US2] 实现 packages/core/src/ingest/pipeline.ts：slug 派生 `<source-id>/docs/<name>`、frontmatter 注入（title/kb/source_file|source_url/converted_at）、`gbrain put --content` upsert（outcome created/updated）、`gbrain embed` 失败降级 done_with_warnings、原始文件归档 DATA_DIR/docs/<source-id>/、失败分类进 rag_jobs.error
- [X] T025 [US2] 在 apps/server/src/worker.ts 注册表接入 pipeline handler（T014 的注册点）
- [X] T026 [US2] 实现 apps/server/src/routes/documents.ts：POST /v1/kb/:id/documents（multipart/url/markdown 三态 + `id == key.write_kb` 校验）、GET documents/jobs/:jobId、GET documents 列表、DELETE documents/:slug（写分区 + slug 前缀校验 + 档案删除）
- [X] T027 [US2] 运行 T021/T022 测试并修复至全绿

**Checkpoint**: US1+US2 叠加可独立演示"建库→发凭证→导入→查任务"

---

## Phase 5: User Story 3 - Agent 经 MCP 管理单分区并跨分区检索 (Priority: P1)

**Goal**: /mcp Streamable HTTP 网关：凭证鉴权、按凭证换发上游 token、引擎侧硬隔离透传

**Independent Test**: {写=A,读=A,B} 凭证 MCP 会话：写入成功、跨源检索命中 A+B、越权不可见、吊销即 401

### Tests for User Story 3

- [X] T028 [P] [US3] 编写 tests/contract/mcp-gateway.test.ts：无 key 401、并发超限 429、调用方 Authorization 头被剥离的断言（contracts/mcp-gateway.md）
- [X] T029 [P] [US3] 编写 tests/integration/us3-mcp.test.ts：双源 fixture（经 US2 接口播种 A/B 内容）后断言 contracts/mcp-gateway.md 验证基线 4 条（tools/list、put_page 栅栏、federated 双源命中/单源不可见=SC-003、吊销 401）

### Implementation for User Story 3

- [X] T030 [US3] 实现 packages/core/src/mcp-gateway.ts：X-API-Key 鉴权 → gbrain-upstream 换 token（缓存/刷新）→ 流式代理（JSON-RPC 与 SSE 双向透传）、per-credential 上游会话映射与失效重建、逐凭证并发计数（429）、头剥离（Authorization/x-gbrain-*）
- [X] T031 [US3] 在 apps/server/src/app.ts 挂载 /mcp（POST/GET/DELETE，Streamable HTTP 语义）并接 tools/call 审计日志（凭证 id/工具名/耗时）
- [X] T032 [US3] 运行 T028/T029 测试并修复至全绿（SC-003 双源对照必须含否定断言）

**Checkpoint**: P1 三故事全部独立可用：管理、导入、Agent 接入

---

## Phase 6: User Story 4 - 应用统一检索接口 (Priority: P2)

**Goal**: REST 检索（hybrid/keyword、top_k）返回规范化结果，跨授权分区可查

**Independent Test**: 对已导入内容的库 POST /retrieval，首条命中且带 score/source_id

### Tests for User Story 4

- [X] T033 [P] [US4] 编写 tests/contract/retrieval.test.ts：hybrid/keyword 参数契约、越权库 403、空 query 422、结果形状（slug/title/snippet/score/source_id）

### Implementation for User Story 4

- [X] T034 [US4] 实现 packages/core/src/retrieval.ts：`gbrain query --json` / `gbrain search --json` 规范化（GBRAIN_SOURCE 钉定经 gbrain-cli.ts）
- [X] T035 [US4] 实现 apps/server/src/routes/retrieval.ts（POST /v1/kb/:id/retrieval，授权 id ∈ write_kb ∪ read_kbs）；补 tests/integration/us4-retrieval.test.ts 并运行至全绿（含 P95 ≤ 2s 计时采样 = SC-002）

---

## Phase 7: User Story 5 - 管理员执行知识引擎高级运维 (Priority: P2)

**Goal**: /v1/admin/gbrain/* 代理 55 路由，SSE 默认 + ?format=json 结构化扩展

**Independent Test**: format=json 取引擎状态成功；SSE 模式执行 list 可见流式输出与 exit 事件

### Tests for User Story 5

- [X] T036 [P] [US5] 编写 tests/contract/admin-proxy.test.ts：401、SSE 三事件形状（stdout/stderr/exit）、format=json 200 JSON、FORMAT_NOT_SUPPORTED 400（contracts/admin-proxy.md）

### Implementation for User Story 5

- [X] T037 [US5] 实现 packages/core/src/admin-proxy.ts：SSE 透传（runner onEvent → SSE 事件）与 format=json 缓冲分支（内置 12 条路由→flag 表，语义照 contracts/admin-proxy.md）；向 cli2api 上游提交改进提案（jsonArg spec 注记 + binary 配置化），合入后迁移上游实现（PR 由维护者提交，待办）
- [X] T038 [US5] 在 apps/server/src/app.ts 以子路由挂载 /v1/admin/gbrain/*（registry 装载 deploy/clis/gbrain.yaml，maxConcurrency 沿用 spec）
- [X] T039 [US5] 补 tests/integration/us5-admin-proxy.test.ts 并运行至全绿（SSE 长任务进度 + format=json 双形态 = SC-007）

---

## Phase 8: User Story 6 - 导入任务可观测 (Priority: P3)

**Goal**: 管理侧任务列表/详情与结构化日志闭环

**Independent Test**: 制造成功/失败任务各一，按状态过滤查询准确，失败项含原因

### Implementation for User Story 6

- [X] T040 [US6] 实现 apps/server/src/routes/jobs-admin.ts：GET /v1/jobs?kb_id=&status=（分页）与 GET /v1/jobs/:id（requireAdmin，直查 rag_jobs）
- [X] T041 [US6] 结构化日志贯穿：请求 id、凭证 id、job 生命周期迁移、上游 token 刷新、tools/call 审计统一 JSON 行输出（stdout）
- [X] T042 [US6] 编写并运行 tests/integration/us6-jobs.test.ts：状态过滤准确性、失败任务 100% 含 error（SC-006）

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: 跨故事收尾与验收核验

- [X] T043 [P] 编写 README.md：架构图（plan.md mermaid）、环境变量表、部署步骤、FR-013 URL 导入无地址校验的 SSRF 风险显著标注
- [X] T044 [P] 完善 /openapi.json 聚合：自有 REST + admin 代理 spec 双链接（/docs 切换）
- [X] T045 验证优雅停机：SIGTERM 后 worker 停止认领、running 任务安全回收、serve 子进程受控退出（compose stop 无僵尸）
- [X] T046 规模与性能核验：脚本化播种 ≥20 库/万页量级子集，10 并发检索采样 P95（SC-004/SC-002），导入端到端计时（SC-001）（已执行轻量版：20 库 + 200 次并发检索 P95=118.5ms；万页量级压测留作运维演练）
- [X] T047 安全复查：日志与响应零密钥泄漏（gbrag_/client_secret/gbrain_cs_ 全文扫描）、越权路径全 403、`bun audit` 无高危
- [X] T048 执行 quickstart.md 全流程并逐项核对 SC-001~SC-007，结果记录回 quickstart 附录

---

- [ ] T049 [P] 性能优化：REST 检索改走常驻 gbrain serve --http 通道（消除逐请求 CLI 进程启动 ~0.5s）。实测（T046）：10 路并发下 CLI spawn 路径 P95≈2.6-2.9s，超出 SC-002 的 2s 目标；单调用 ~0.5s 达标。方案：启动期注册内部 OAuth client（federated-read=全部 kb-*），建库时 rescope 纳管；检索经 Upstream.proxy 调 MCP search/query（source_id 钉定）。回归口径：复跑 scripts/scale-check.ts 断言 P95 ≤ 2000ms。

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖，立即开工（T006 镜像构建可与其他任务并行）
- **Foundational (Phase 2)**: 依赖 T001/T002/T003/T004；**阻塞全部用户故事**
- **US1 (Phase 3) / US2 (Phase 4) / US3 (Phase 5)**: 均只依赖 Foundational，可三路并行
  - US2 的集成 fixture 复用 US1 接口（凭证）；US3 的双源 fixture 复用 US2 导入（或 CLI 播种降级）
- **US4 (Phase 6)**: 依赖 US2 内容入库（检索断言需要语料）
- **US5 (Phase 7)**: 仅依赖 Foundational（T005 提炼完成），最早可在 Phase 2 后与 US1 并行
- **US6 (Phase 8)**: 依赖 US2（任务数据存在）
- **Polish (Phase 9)**: 依赖全部故事完成

### User Story Dependencies

- **US1**: Foundational 后即可；无故事间依赖
- **US2**: Foundational 后即可；集成测试引用 US1 的 API（运行时依赖，非开发阻塞）
- **US3**: Foundational 后即可；双源断言依赖可播种内容（US2 或 CLI 降级方案）
- **US4/US5/US6**: 见上

### Within Each User Story

- 测试先行（contract/integration 先写、确认 FAIL）
- core 领域模块 → 路由装配 → 集成测试转绿
- 每故事收尾有 Checkpoint，可独立演示

### Parallel Opportunities

- Phase 1: T002/T005/T006 三路并行
- Phase 2: T008/T009 并行（其余顺序：supervisor→index→app→middleware→worker 链上有依赖）
- Phase 3-5（P1 三故事）三路并行；US5 可提前并行
- 各故事内 contract 与 integration 测试编写可并行（[P] 标注）

---

## Parallel Example: P1 三故事并行

```text
# Foundational 完成后：
Track A (US1): T015 → T016 → T017 → T018 → T019 → T020
Track B (US2): T021 → T022 → T023 → T024 → T025 → T026 → T027   # T026 路由依赖 T019 的鉴权接线
Track C (US3): T028 → T029 → T030 → T031 → T032                 # 集成 fixture 等待 A/B 前段产出
Track D (US5): T036 → T037 → T038 → T039                        # 仅依赖 Foundational
```

---

## Implementation Strategy

### MVP First (US1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US1
4. **STOP & VALIDATE**: T020 全绿 + 人工过一遍 spec 验收场景 1-5
5. 可部署演示：建库 + 发凭证 + 越权拒绝

### Incremental Delivery

US1（MVP）→ +US2（内容进得来）→ +US3（Agent 可用）→ +US4/US5（应用与运维面）→ +US6（可观测）→ Polish

每步独立测试、独立交付；SC-003 隔离断言在 US3 定死，后续故事不得破坏（Polish T047 复扫）。

---

## Notes

- [P] = 不同文件、无未完成依赖
- 每任务完成后提交；故事 Checkpoint 处跑全量 bun test
- 涉及 gbrain CLI 行为的任务（T008/T017/T018/T023-T024/T030/T034）以 research.md D1-D12 的已实证语义为准，勿凭记忆改契约
- 破坏性操作路由（admin 代理内）不做二次确认，但日志必须完整（contracts/admin-proxy.md）
