# Tasks: 实体图层与文档面隔离（008）

**Input**: Design documents from `specs/008-entity-graph-layer/`

**Prerequisites**: plan.md / spec.md / research.md

**测试纪律**：仓库规范"功能带测试"——各故事含单测/契约任务；修缺陷先补回归测试。

**待用户确认**：plan.md 决策 D1（语言策略）/ D2（实体页范围）/ D3（内容）/ D4（暴露面）/ D5（回收策略）
**已锁定（实测，非选择题）**：D6 slug 结构不可变（R14：slug = 磁盘路径）

## Phase 1: Setup

- [X] T001 确认 `.specify/feature.json` 指向 `specs/008-entity-graph-layer`
- [X] T002 [P] 容器内冒烟核实引擎命令面：`gbrain import --no-embed`、`gbrain extract links --source db --json`、`gbrain config set link_resolution.global_basename true`、MCP `traverse_graph`
- [X] T003 [P] 与关联项目确认 D1 语言策略（单语 / 双语 + 桥边）

## Phase 2: Foundational（纯函数 + 引擎封装）

- [X] T004 新建 `packages/core/src/entity-graph.ts`：`slugifyEntityName()` 逐字符镜像引擎 `slugifySegment`（NFD → 去 `\u0300-\u036f` → 去 `\u0591-\u05c7` → NFC → lowercase → 保留 `\p{Ll}\p{Lm}\p{Lo}\p{M}\p{N}. _-` → 空白转 `-` → 折叠 → 去首尾）
- [X] T005 [P] `tests/unit/entity-graph.test.ts`：slug 规范化对照用例——中文（`电池`）、含空格（`Soleil01 SE` → `soleil01-se`）、大小写、重音（`café` → `cafe`）、下划线、全角、空串回退
- [X] T006 [P] `entity-graph.ts`：`extractWikilinkTargets(md)` 镜像引擎 `WIKILINK_GENERIC_RE` 语义（剥 `|别名` 与 `#锚点`、跳过代码块、去重、保序）
- [X] T007 [P] `tests/unit/entity-graph.test.ts`：双链扫描——普通、含别名、含锚点、代码块内忽略、重复目标去重、空文档
- [X] T008 `entity-graph.ts`：`ensureEntityPages(cfg, kbId, targets)`——`get` 探存在性 → 差集 → 落临时目录 `<tmp>/<kb>/entities/<slug>.md`（frontmatter `title` + `type: concept` + **来源标记 `auto_generated: wikilink-stub`**）→ `runGbrain(["import", dir, "--no-embed"])` → 返回已建 slug
- [X] T009 `entity-graph.ts`：`runLinkExtraction(cfg, kbId)` → `runGbrain(["extract","links","--source","db","--json"])`，解析计数用于日志
- [X] T010 [P] `tests/unit/entity-graph.test.ts`：`ensureEntityPages` 幂等与优先级——已存在页不覆盖、重复目标单页、mock runGbrain 断言 argv 形状
- [X] T010a `entity-graph.ts`：`reconcileEntityStubs(cfg, kbId)`——`orphans --mode inbound --source <kb> --json` → 与"`entities/` 分区 + 带来源标记"的候选求交 → `delete` 命中项；三重护栏见 FR-016/FR-017
- [X] T010b [P] `tests/unit/entity-graph.test.ts`：回收护栏——无标记页不删、有存活入边不删、共享实体页（另一文档仍引用）不删、非 `entities/` 分区页不删、幂等重跑
- [X] T010c [P] `tests/unit/entity-graph.test.ts`：回收**不**使用默认 `islanded` 模式（构造"有出边但无入边"的实体页，断言仍被回收）

## Phase 3: US1 文档面纯净（P1）

- [X] T011 [US1] `packages/core/src/retrieval-serve.ts`：`retrieve()` 的 `args` 增 `types: ["note"]`（文档类型常量）；**并对结果做 `<kb>/docs/` 前缀兜底过滤**（R8.1）；结果按 `input.topK` 截断（修 P10）
- [X] T011a [P] [US1] `tests/unit/retrieval-serve.test.ts`：前缀兜底——构造一个 `concept` 类型但位于 `docs/` 的页（模拟绕过管线的写入）应**保留**；`entities/` 下的页应**剔除**
- [X] T012 [P] [US1] `tests/unit/retrieval-serve.test.ts`：检索参数构造含 `types`；`topK=2` 时输出 ≤ 2（回归 P10）
- [X] T013 [US1] `apps/server/src/openapi/routes/tenant.ts` 文档列表路由：`list --type note --limit <n>`（替换裸 `--limit 200`）
- [X] T014 [P] [US1] `tests/contract/openapi-drift.test.ts` 侧核验：列表/检索响应形状未变（字段与既有 schema 一致）
- [X] T015 [US1] 集成验证（gated）：含实体页的库中 `GET /documents` 条数 == 文档数；检索 top-K 零实体页

## Phase 4: US4 类型钉定（P3，先于 US2 因其为 US2 前置）

- [X] T016 [US4] `packages/core/src/ingest/pipeline.ts` `buildMarkdown()`：frontmatter 增 `type: <文档类型常量>`（覆盖正文自带类型）
- [X] T017 [P] [US4] `tests/unit/pipeline.test.ts`：产物 frontmatter 含钉定类型；正文原 `type` 被覆盖
- [X] T018 [P] [US4] 端到端落库断言：导入任意文件名文档后 DB `type` 恒为钉定值（非 `concept`）

## Phase 5: US2 导入即建图（P1）

- [X] T019 [US2] `pipeline.ts` 编排（**顺序关键**，R15）：解析 markdown 双链 → `ensureEntityPages` → `buildMarkdown` → `put`（auto_link 自动建边）→ `runLinkExtraction`（幂等兜底）→ `reconcileEntityStubs`（仅前四步全部成功后执行回收，FR-019）；任一步失败仅记录告警，不改变文档导入的成功判定
- [X] T019a [US2] 文档删除路径（`tenant.ts` 的 `delete` 路由）：`gbrain delete` 成功后异步触发 `reconcileEntityStubs`（FR-018），失败仅告警
- [X] T020 [US2] 建库路径（`packages/core/src/kb.ts` 或其调用方）确保引擎 `link_resolution.global_basename=true`（幂等 set，失败告警）
- [X] T021 [P] [US2] `tests/unit/pipeline.test.ts`：建图阶段失败不影响任务状态；成功路径的调用顺序断言
- [X] T022 [US2] 本地端到端：空库导入 13 篇带双链文档 → 断言边数 == 脚本独立核算的 uniq `(文档,目标)` 对数（本地基准 997）；未引用实体页数 == 0
- [X] T023 [US2] 幂等验证：同一文档连续导入两次 → 页数与边数不变
- [X] T023a [US5] 回收端到端：文档 A 独占引用"电池" → 删除 A → 实体页回收（SC-007）；A、B 共享"电池" → 删 A → 实体页保留且入边数==1（SC-008）
- [X] T023b [US5] 反例验证：手工建一个孤儿页（无来源标记）→ 跑回收 → 该页不被删除（SC-009）
- [X] T023c [US5] 更新场景：文档 A 更新后删掉 `[[电池]]` → 无其他引用 → 实体页被回收；重新导入 → 实体页与边恢复（US5-6）

## Phase 6: US3 实体多跳（P2）

- [~] T024 [US3] ~~`deploy/clis/gbrain.yaml` 新增代理路由~~ → **实现方式变更**：改用专用管理面路由 `/v1/admin/graph/*`（走 MCP `traverse_graph`/`get_page`），不走 cli2api（CLI `graph-query --direction both` 打印器丢入边，R12；MCP `entity` 在内部 client 多库视角下按名解析不稳）
- [X] T025 [US3] 管理面路由（`apps/server/src/openapi/routes/admin.ts`）：实体卡 + 多跳查询端点（`libHandler` 包装，字段 snake_case）
- [X] T026 [P] [US3] 契约测试：两个新路由的注册与响应形状
- [X] T027 [US3] 端到端：以实体为起点 depth=2/direction=both → 路径非空；跨库同名实体不串（source 隔离）

## Phase 7: 部署与数据迁移

- [X] T028 构建新镜像并生产滚动更新（`updateServiceImageTag` + restart）
- [X] T029 生产确保 `global_basename` 已开（`gbrain config get`）
- [X] T030 按 D1 策略重建库（归档 → purge → 新建）→ 按 slug 映射表重放文档
- [X] T031 核对生产：`link-sources` 非空、边数与文档双链对数量级一致、`sources/status` 覆盖度 100%
- [X] T032 关联项目 5 项验收复测（写/幂等重传/URL/图片/覆盖度）——确认 SC-006 文档面语义零变化

## Phase 8: 收尾

- [X] T033 文档同步：`docs/usage.md`（图谱与隔离说明）、`docs/deployment.md`（实体层 + 引擎开关）、README 中英同构
- [X] T034 缺陷台账 `docs/testing-strategy.md` §4：登记 P10 修复；N4/P9 单列（P9 为运维项）
- [ ] T035 L3 压测复核：实体层上线后检索延迟与召回无回退（`scripts/load/perf.ts`）
- [ ] T036 独立运维项：docling 容器内存（≥6GB 或释放节点内存）——与代码解耦，单独跟踪

## Dependencies

```
T001-T003 (Setup)
  → T004-T010c (Foundational：slug/扫描/建页/回收封装)
      → T011-T015  (US1 文档面)   ─┐
      → T016-T018  (US4 类型钉定) ─┼→ T019-T023c (US2 建图 + US5 回收)
                                  │        → T024-T027 (US3 多跳)
                                  │        → T028-T032 (部署迁移)
                                  └───────→ T033-T036 (收尾)
```

- US2 依赖 US4（类型先钉定，实体页才可与文档页按类型区分）
- US5 与 US2 同阶段交付（回收是建图的收尾步骤；T019 的编排顺序把两者绑在一次通过里）
- US3 依赖 US2（无实体页则无可遍历节点）
- 部署迁移（T028+）需 US1/US2/US5 全绿
