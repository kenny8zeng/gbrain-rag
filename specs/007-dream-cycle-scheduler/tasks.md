# Tasks: 梦境周期调度（007）

**Input**: Design documents from `specs/007-dream-cycle-scheduler/`

**Prerequisites**: plan.md / spec.md / research.md / data-model.md / contracts/contracts.md / quickstart.md

**测试纪律**：仓库规范"功能带测试"——各故事含单测/契约任务。

## Phase 1: Setup

- [X] T001 确认 `.specify/feature.json` 指向 `specs/007-dream-cycle-scheduler`（已置，核验一次）
- [X] T002 [P] 通读 plan.md/research.md/data-model.md/contracts，确认 dream 命令面假设（`gbrain dream --phase extract`/`--json`）在容器内可用（`docker compose exec gbrain-rag gbrain dream --help` 冒烟）

## Phase 2: Foundational

- [X] T003 在 `packages/core/src/config.ts` 增加 env schema：`DREAM_ENABLED`（bool 默认 false）、`DREAM_INTERVAL_HOURS`（int 默认 24，非正 → 警告并视为关）、`DREAM_TIER`（enum light|full 默认 light）
- [X] T004 新建 `packages/core/src/dream.ts`：`DreamRunner` 类——状态（running/startedAt/nextDue/lastRun/lastError）、`start(trigger, tier)` 异步执行（runGbrain：light=`["dream","--phase","extract","--json"]`、full=`["dream","--json"]`；超时 `DREAM_TIMEOUT_MS=4h` 强杀解锁）、锁互斥（running 拒绝）、`status()` 聚合、事件日志（dream_started/done/error/rejected）
- [X] T005 [P] 新建 `tests/unit/dream.test.ts`：锁互斥（running 拒绝）、超时解锁、lastRun/error 记录、tier→args 映射、重启清锁（新实例 idle）——mock runGbrain
- [X] T006 `packages/core/src/config.ts` 导出校验后跑 `bun x tsc --noEmit`（零错误）

## Phase 3: US1 定时触发（P1）

- [X] T007 [US1] 在 `apps/server/src/supervisor.ts`（或独立 `dream-scheduler.ts`）集成定时器：`DREAM_ENABLED=true` 时按 `nextDue`（启动+interval）周期调用 `runner.maybeScheduled()`；到点 running → 跳过顺延（dream_rejected skip）；启动即排 nextDue
- [X] T008 [P] [US1] `tests/unit/dream.test.ts` 补定时语义用例：到点触发（fake 时钟）、running 跳过顺延、ENABLED=false 零触发
- [X] T009 [US1] 本地冒烟（quickstart S4 简化）：.env `DREAM_ENABLED=true DREAM_INTERVAL_HOURS=1 DREAM_TIER=light` 重启 → `GET /v1/admin/dream` 显示 enabled/next_due 正确

## Phase 4: US2 手工触发 + 状态 API（P1）

- [X] T010 [P] [US2] 新建 `apps/server/src/openapi/routes/dream-admin.ts`：`POST /v1/admin/dream`（body `{tier?}` 可选，202 started/409 DREAM_RUNNING）+ `GET /v1/admin/dream`（状态视图：enabled/tier/interval_hours/running/started_at/next_due/last_run）——createRoute + libHandler + schemas
- [X] T011 [US2] `apps/server/src/app.ts` 注册 `registerDreamAdminRoutes(app, svc, admin)`；`Services` 增 `dream: DreamRunner`；`index.ts` 装配 runner（cfg 驱动）并 `start()`（ENABLED 时）
- [X] T012 [P] [US2] `tests/contract`（门控文件）补：管理面 POST 202/非管理面 401、GET 形状；运行中 409 走单测（mock）为主
- [X] T013 [US2] `bun x tsc --noEmit` + `bun test tests/unit tests/contract`（需实例段门控跳过确认）

## Phase 5: US3 执行中互斥（P2）

- [X] T014 [US3] Runner 锁强化验收（dream.ts 已含）：补单测——执行中手工 start → 拒绝且 lastRun 不被覆盖；执行中 scheduled → skip 顺延；超时强杀后立即可再 start（SC-003/SC-005）
- [X] T015 [P] [US3] 契约补 `409 DREAM_RUNNING` 响应形状（schemas + drift 白名单如需要）
- [X] T016 [US3] quickstart S3 本地实测：full 档触发后立即再触发 → 409；完成后可再触发

## Phase 6: Polish & 文档同步（FR-011/SC-006）

- [X] T017 [P] `docs/deployment.md` 环境变量全表补 DREAM_ENABLED/DREAM_INTERVAL_HOURS/DREAM_TIER（默认/档位语义）
- [X] T018 [P] `docs/usage.md` 管理面路由表补 `POST/GET /v1/admin/dream`；错误码表补 `409 DREAM_RUNNING`
- [X] T019 [P] `docs/auth-model.md` 管理面覆盖清单补梦境接口（管理面新增操作）
- [X] T020 [P] `README.md` + `README.zh-CN.md` 特性/配置要点补梦境周期（中英同构同步）
- [X] T021 [P] `CHANGELOG.md` [Unreleased] 记新特性（env/API/文档同步）
- [X] T022 全量回归 `bun run test`（137+ 基线之上全绿）→ 提交推 dev+main（含 spec/007 套件）

## Dependencies

- 完成序：Phase 1 → 2（T003-T006）→ US1（T007-T009）｜US2 依赖 Foundational 但可与 US1 并行（不同文件：scheduler vs routes）→ US3 依赖 US2（409 经 API）→ Polish
- 并行机会：T002/T005/T008/T010/T012/T017-T021（不同文件）

## Implementation Strategy

- MVP = Phase 1+2+US1（默认关零变化 + 定时 light 触发），先行验证；US2/US3 增量；文档同步随交付同提交（非后续）
