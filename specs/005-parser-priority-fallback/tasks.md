# Tasks: 文档解析优先级与回退

**Input**: Design documents from `/specs/005-parser-priority-fallback/`

**Prerequisites**: plan.md、spec.md、research.md（D1-D7）、data-model.md、contracts/parser-priority.md、quickstart.md

**Tests**: 回退确定性核心单测（注入故障）+ 四实例矩阵集成；基线 = 101 项全绿（docling 可用默认路径零回归）。

**Organization**: 按用户故事分组；Foundational（resolveChain + convertWithFallback + migration）阻塞全部。

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 [P] 编写 deploy/migrations/0002-parser-log.sql：`ALTER TABLE rag_jobs ADD COLUMN parser_log TEXT;`（幂等可重放即跳过已存在列——采用 IF NOT EXISTS 语法）
- [X] T002 [P] deploy/compose.test.yaml 扩展 3102（docling 可用 + PARSER_PREFERENCE=anydoc）与 3103（DOCLING_URL=http://127.0.0.1:1 + pref=docling）service（user: root 沿用）

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 解析链 + 回退执行器 + parser_log 落库——阻塞全部故事

**⚠️ CRITICAL**: 本阶段完成前 US1-US4 不得开工

- [X] T003 config.ts 增加 `PARSER_PREFERENCE`（z.enum docling|anydoc，default docling）并校验（docling 未配置时忽略）；parser.ts `resolveParser` 升级 `resolveChain(cfg, docling, anydoc): {mode, primary, fallback, url}`（矩阵 per research D2，保留强制模式无回退语义）；resolver.ts 返回链
- [X] T004 新建 packages/core/src/ingest/fallback.ts：`convertWithFallback(chain, bytes, filename): Promise<{md, used: "docling"|"anydoc", fallbackFrom?: string}>`——try primary → 失败记录原错误 → fallback（存在）→ 成功带链；双失败抛最终错误（含链说明）
- [X] T005 [P] 先写 tests/unit/fallback.test.ts：注入故障（fake primary 抛/fake fallback 成功）→ 回退成功 + used/fallbackFrom；primary 成功不触发；双失败链错误——红灯
- [X] T006 [P] 先写 tests/unit/parser.test.ts 扩展 resolveChain 矩阵 5 行断言（含强制模式无 fallback）——红灯
- [X] T007 worker.ts 成功路径写 `parser_log`（done/done_with_warnings 时非空）；失败路径 error 含链说明

**Checkpoint**: 单测绿 + migration 应用 + 既有 101 项零回归（3000 docling 可用 primary 成功行为不变）

## Phase 3: User Story 1 - docling 优先 + anydoc 回退（默认） (Priority: P1) 🎯 MVP

**Goal**: 3000（docling 可用 + pref=docling）文件导入 docling 完成；3103（docling 不可达）回退 anydoc 成功且链记录

**Independent Test**: 3103 上传 docx → done + parser_log 以 "docling→anydoc:" 开头

### Tests for User Story 1

- [X] T008 [P] [US1] 先写 tests/integration/us6-priority.test.ts（自适应：3103 实例 parser_preference=docling 且 docling=false 时跑回退断言；3000 跑 parser_log=docling 断言）——docx 导入后任务查询断言 parser_log 值；红灯

### Implementation for User Story 1

- [X] T009 [US1] pipeline.ts 文件分支接 convertWithFallback（parser_log 透出）；任务 jobJson/详情响应带 parser_log 字段（tenant+admin 两侧）
- [X] T010 [US1] 运行 T008 至全绿（3103 回退 + 3000 primary）；docling 可用 101 项零回归

**Checkpoint**: US1 独立验收 = quickstart 场景 1/3

## Phase 4: User Story 2 - anydoc 优先 + docling 回退 (Priority: P1)

**Goal**: 3102（pref=anydoc）docx 直接 anydoc（parser_log=anydoc）；URL 仍 docling

**Independent Test**: 3102 上传 docx → done + parser_log=anydoc；URL 导入 done（docling 路径）

### Tests for User Story 2

- [X] T011 [P] [US2] 补 tests/integration/us6-priority.test.ts 3102 分支：docx parser_log=anydoc、health parser_primary=anydoc、URL 导入 202→done

### Implementation for User Story 2

- [X] T012 [US2] 无独立实现（resolveChain 已按 pref 选主）；若 T011 暴露缺口则修（如 health parser_primary 透出）——跑 T011 至全绿

**Checkpoint**: US1+US2 = 优先级双方向验证

## Phase 5: User Story 3 - docling 未配置 anydoc 唯一（现状回归） (Priority: P1)

**Goal**: 3101 行为与 004 完全一致（us5 全绿 + URL/图片 422）

### Tests for User Story 3

- [X] T013 [P] [US3] 重跑 tests/integration/us5-anydoc.test.ts（3101）断言零回归（无代码改动预期；如 parser_log 字段引入致 job 响应形状变化则同步 us5 断言）

**Checkpoint**: 三模式（3101/3000/3102）行为矩阵成立

## Phase 6: User Story 4 - 优先级矩阵可观测与回归 (Priority: P2)

**Goal**: health 三字段 + 测试方案四实例矩阵落地 + URL 不回退断言

### Tests for User Story 4

- [X] T014 [P] [US4] tests/contract/limits.test.ts 扩展 health 断言（parser_primary/parser_preference 存在且 ∈ {docling,anydoc}）

### Implementation for User Story 4

- [X] T015 [US4] system.ts health 返回 parser_primary（chain.mode）与 parser_preference（cfg）；schemas.Health 扩展两字段（openapi drift 自动一致）
- [X] T016 [US4] us6 补 URL 不回退断言（3103：URL 导入 docling 不可达 → failed，error 无 anydoc 痕迹）
- [X] T017 [US4] docs/testing-strategy.md 更新：四实例矩阵表（§2/§3）、SC-005 归属、用例计数

**Checkpoint**: quickstart 全场景 + 测试方案 v1.2

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T018 [P] deploy/.env.example 增加 PARSER_PREFERENCE 说明；README 解析器优先级章节
- [X] T019 全量回归矩阵执行：3000 全量 101+ 新契约零回归；3101 us5；3102/3103 us6；单测全绿；提交

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup**: T001/T002 并行
- **Foundational**: T003→T004→（T005∥T006∥T007 后置）→ checkpoint
- **US1**: T008 → T009 → T010（依赖 Foundational + 3000/3103 实例）
- **US2**: 依赖 Foundational（无独立实现任务，T011 验证）
- **US3**: 依赖 Foundational（T013 回归验证）
- **US4**: T014/T015 并行后 T016/T017
- **Polish**: 全部后

### Parallel Opportunities

T001∥T002；T005∥T006；US1 完成后 US2/US3 验证并行；T014∥T015

---

## Implementation Strategy

### MVP First（US1）

1. Setup → 2. Foundational → 3. US1（T008-T010）
4. **STOP & VALIDATE**: 3103 回退成功 + 3000 零回归
5. MVP：docling 故障自动 anydoc 保底

### Incremental Delivery

US1（回退保底）→ US2（anydoc 优先）→ US3（现状回归）→ US4（可观测+矩阵）→ Polish

---

## Notes

- 3000 主实例语义变化须零回归（docling 可用 → primary 成功 → parser_log=docling；行为与 004 无差）
- 回退链格式统一：`"<primary>→<fallback>: <原错误≤200字>"`（data-model §2）
- us6-priority 需自适应实例选择（探测 /health parser_primary/parser_preference/docling 后跑对应分支，参照 us5 模式）
- 完成 005 后 docs/testing-strategy.md 缺陷台账若无新 ✗ 保持 13/13
