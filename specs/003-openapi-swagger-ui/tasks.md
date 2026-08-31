# Tasks: OpenAPI 文档与 Swagger UI

**Input**: Design documents from `/specs/003-openapi-swagger-ui/`

**Prerequisites**: plan.md、spec.md、research.md（D1-D6）、data-model.md、contracts/docs-api.md、quickstart.md

**Tests**: plan.md 延续 001 的三层测试策略；漂移校验（FR-004）与零外链（FR-003）本身即测试任务。

**Organization**: 按用户故事分组；Foundational（zod v4 迁移 + schema 集中）阻塞全部故事。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件，无未完成依赖）
- **[Story]**: 所属用户故事（US1-US3）
- 路径相对仓库根；实现基线为 001 完成后的现状（雏形端点存在，`apps/server/src/app.ts` 内手写 openapiDoc）

## Path Conventions

迭代既有结构：`apps/server/src/`（新增 `openapi/` 子目录）、`tests/contract/`。

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 依赖变更与 zod v4 迁移——最高风险项前置

- [X] T001 [P] 依赖变更：根 `package.json` 执行 `bun add zod@^4 @hono/zod-openapi swagger-ui-dist`，确认 peer 关系满足（hono ≥4.10）并落锁
- [X] T002 zod v3→v4 全仓迁移：替换弃用用法（如 `z.string().url()` → `z.url()`），跑通全量既有测试（`bun run test` 36 项零回归）；若摩擦超时间箱（0.5 天）触发 research D1 回退路径并升级为决策项

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: schema 集中与漂移闸门的测试先行

**⚠️ CRITICAL**: 未完成本阶段，US1-US3 不得开工

- [X] T003 新建 apps/server/src/openapi/schemas.ts：集中全部请求/响应 Zod schema（kb、keys、documents、retrieval、jobs、health、错误 envelope），既有路由内联 schema 改为引用此处（唯一事实源）
- [X] T004 [P] 先写 tests/contract/openapi-drift.test.ts：集合 A=服务描述 paths 展开、集合 B=应用注册路由（白名单豁免：/mcp 说明条目、/openapi.json、/docs、/swagger-ui/*），双向包含断言——当前实现必然失败（红灯基线）

**Checkpoint**: zod4 零回归 + 漂移测试红灯就位

---

## Phase 3: User Story 1 - 机器可读描述三平面覆盖 (Priority: P1) 🎯 MVP

**Goal**: `/openapi.json` 由带 schema 的路由定义结构化生成：租户+管理面全量参数/体/响应 + 双鉴权方案；引擎代理描述在稳定地址透出

**Independent Test**: 拉取描述后跨三平面各抽 1 接口按文档真实调用成功，且描述 paths 与注册路由双向一致

### Tests for User Story 1

- [X] T005 [P] [US1] 先写 tests/contract/openapi.test.ts：OpenAPI 3.x 合法性、三平面路径存在、securitySchemes 两项、路由 security 平面正确（租户 apiKey/管理 adminToken/system 无）、流式与 MCP 说明条目断言（contracts/docs-api.md）

### Implementation for User Story 1

- [X] T006 [US1] 新建 apps/server/src/openapi/routes/system.ts：health/openapi/docs/static 以 OpenAPIHono 路由定义注册（无 security）
- [X] T007 [US1] 迁移租户面路由到 apps/server/src/openapi/routes/tenant.ts：documents（三态导入/列表/任务/删除）与 retrieval 的路由定义 + schemas.ts 引用 + `security: apiKey`；处理器逻辑不变
- [X] T008 [US1] 迁移管理面路由到 apps/server/src/openapi/routes/admin.ts：kb/keys/jobs-admin + `security: adminToken`；处理器逻辑不变
- [X] T009 [US1] 改造 apps/server/src/app.ts：装配 OpenAPIHono 替换裸 Hono 路由注册，`/openapi.json` 改由定义生成器输出（删除手写 openapiDoc），`/v1/admin/openapi/gbrain.json` 透出引擎描述并为其流式路由补流式说明（research D5）、`/mcp` 以说明条目存在
- [X] T010 [US1] 运行 T004/T005 至全绿（漂移转绿即结构达标）；全量既有测试零回归

**Checkpoint**: US1 独立验收 = quickstart 场景 1 全部通过

---

## Phase 4: User Story 2 - 自托管交互文档页 (Priority: P2)

**Goal**: `/docs` 多分组页面 + `/swagger-ui/*` 白名单静态分发，零外链、支持凭证录入在线执行

**Independent Test**: 断网条件下打开 /docs 完成一次带鉴权的在线执行；页面 HTML 无任何外部资源引用

### Tests for User Story 2

- [X] T011 [P] [US2] 先写 tests/contract/docs-ui.test.ts：/docs 200 且 HTML 内 src/href 全部同源相对路径（零外链断言）、/swagger-ui 白名单资源 200、白名单外 404、两组分组 urls 存在（服务 + 引擎代理）

### Implementation for User Story 2

- [X] T012 [US2] 新建 apps/server/src/openapi/ui.ts：/docs 页面（多分组 urls：服务描述 + 引擎描述；Authorize 提示 Bearer/X-API-Key）与 /swagger-ui/* 静态白名单分发（资源取自 swagger-ui-dist 包，禁止 CDN）
- [X] T013 [US2] 从 apps/server/src/app.ts 移除既有 CDN 版 /docs 实现，挂载 ui.ts；运行 T011 至全绿（SC-003）

**Checkpoint**: US1+US2 叠加 = quickstart 场景 1-2 全部通过

---

## Phase 5: User Story 3 - 零漂移 CI 闸门 (Priority: P3)

**Goal**: 一致性校验成为持续集成常驻闸门，并完成破坏性演练证明其有效性

**Independent Test**: 人为增删一条注册路由，校验失败并指出差异；还原后通过

### Implementation for User Story 3

- [X] T014 [US3] 完善 tests/contract/openapi-drift.test.ts 差异输出（缺失/多余路由逐项列出）；破坏性演练：临时注册未入文档路由 → 断言失败并记录输出 → 还原（证明 FR-004 闸门有效）
- [X] T015 [US3] 将漂移校验纳入默认测试集（确认 `bun run test` 无 tag 过滤即执行），并在 README 开发章节登记该闸门

**Checkpoint**: 三故事完成 = quickstart 场景 1-3 全部通过

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T016 [P] 更新 README.md：文档/页面章节（地址、两枚鉴权方案、自托管说明）替换既有 Swagger 描述
- [X] T017 性能与回归复核：/openapi.json 与 /docs 响应时延采样（SC-004 关联：文档生成成本启动期缓存）；全量测试 + quickstart 走查记录回填

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001 依赖变更 → T002 zod4 迁移（顺序：升级后立即回归）
- **Foundational (Phase 2)**: 依赖 Phase 1；T003 schema 集中 → T004 漂移红灯（可并行编写，红灯基线在 T003 后确立）
- **US1 (Phase 3)**: 依赖 Foundational；T006→T007/T008（可并行）→T009→T010
- **US2 (Phase 4)**: 依赖 US1（服务描述地址就绪）；US3 依赖 US1
- **Polish (Phase 6)**: 依赖全部故事

### User Story Dependencies

- **US1**: Foundational 后即可，无故事间依赖
- **US2**: 依赖 US1 的 /openapi.json（页面 urls 数据源）
- **US3**: 依赖 US1（文档-路由对齐后才存在"零漂移"可断言）；T004 的红灯基线在 Phase 2 就绪，无需等 US1

### Within Each User Story

- 测试先行（先写先败）
- 路由定义迁移按平面推进；处理器逻辑不动
- 每故事 Checkpoint 独立可演示

### Parallel Opportunities

- Phase 1: T001 与 T002 之外无并行项（迁移依赖升级）
- Phase 2: T003 与 T004 并行（不同文件）
- Phase 3: T007 与 T008 并行（不同路由文件）
- US2/US3 在 US1 后可双线并行

---

## Parallel Example: Foundational 后的双线

```text
Track US1: T005 → T006 → (T007 ∥ T008) → T009 → T010
Track US2（US1 的 T009 后）: T011 → T012 → T013
Track US3（US1 的 T010 后）: T014 → T015
```

---

## Implementation Strategy

### MVP First (US1 only)

1. Phase 1 → 2. Phase 2 → 3. Phase 3（US1）
4. **STOP & VALIDATE**: T010 全绿 + quickstart 场景 1 抽样调用通过
5. 此刻描述文档已可支撑客户端生成（P1 价值闭环）

### Incremental Delivery

US1（文档可信）→ +US2（在线试用/断网可用）→ +US3（防腐闸门）→ Polish

每步独立测试独立交付；漂移闸门（US3）落地后回归永久受保护。

---

## Notes

- zod4 迁移（T002）是本特性最大风险：严格按 research D1 时间箱执行，超限即走回退路径并升级决策
- 引擎代理描述数据零改动原则（research D4）：唯一允许的加工是流式说明补注
- 处理器逻辑迁移红线：OpenAPIHono 迁移只换注册方式，不得顺手改行为；既有 36 项测试是行为不变性的证据
- 完成后把 `.specify/feature.json` 切回 `specs/002-cors-origin-list` 走同流程（排队的 002）
