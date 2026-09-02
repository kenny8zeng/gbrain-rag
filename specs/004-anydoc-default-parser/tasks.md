# Tasks: anydoc 作为默认文档解析器

**Input**: Design documents from `/specs/004-anydoc-default-parser/`

**Prerequisites**: plan.md、spec.md、research.md（D1 已实机验证）、data-model.md、contracts/parser.md、quickstart.md

**Tests**: plan.md 延续三层测试策略；解析器行为（选择/错误映射/OCR 分支）以单元测试覆盖，端到端走集成。

**Organization**: 按用户故事分组；Foundational（解析器抽象）阻塞全部故事。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行
- **[Story]**: US1-US3
- 路径相对仓库根；实现基线 = 73/73 全绿（含 docling 现状路径）

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 依赖与 fixture

- [X] T001 [P] 根 `package.json` 声明 `@firecrawl/anydoc`（已本地实测 `bun add` 成功，落锁）+ Dockerfile 构建期验证 NAPI 加载（构建后 `bun -e "import('@firecrawl/anydoc')"` 冒烟并入 T007 检查点）
- [X] T002 [P] 生成 tests/fixtures/test.docx（zip+xml 手造：中文文本 + 表格，验证脚本已实测可转）

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 解析器抽象与选择——阻塞全部故事

**⚠️ CRITICAL**: 本阶段完成前 US1-US3 不得开工

- [X] T003 新建 packages/core/src/ingest/parser.ts：`Parser` 接口（convertFile/convertUrl + 能力声明 supportsUrl/supportsImage）+ `resolveParser(cfg)`（DOCLING_URL 非空 → docling；空 → anydoc）+ `ParserUnavailableError`（含指引文案）
- [X] T004 新建 packages/core/src/ingest/anydoc-parser.ts：`toMarkdownBytes` 调用（Uint8Array 必须）、格式嗅探、错误分类映射表（needsOcr/unsupported/malformed/encrypted/resourceLimit/missingPart/io/hosted → 中文原因，data-model §2）、OCR 可选重试（FIRECRAWL_API_KEY/ANYDOC_OCR → `{ocr:'hosted', apiKey}` 一次）
- [X] T005 [P] 先写 tests/unit/parser.test.ts：选择逻辑（docling 配置/空）、错误映射全表、OCR 分支（mock error.code）、ParserUnavailableError 文案——当前实现不存在，红灯基线
- [X] T006 改造 packages/core/src/ingest/docling.ts 为 doclingParser 适配（实现 Parser 接口，行为零变化）；pipeline 调 convertFile 改经 resolveParser

**Checkpoint**: 单测绿（选择/映射/OCR）；docling 路径既有 73 项零回归（pipeline 走抽象后先跑全量）

## Phase 3: User Story 1 - 未配置外部解析服务时文件导入开箱即用 (Priority: P1) 🎯 MVP

**Goal**: DOCLING_URL 空 → anydoc 处理文档文件，契约全保持

**Independent Test**: 默认模式上传 test.docx → done → 检索命中表格内容

### Tests for User Story 1

- [X] T007 [P] [US1] 先写 tests/integration/us5-anydoc.test.ts：默认模式（需测试实例以 DOCLING_URL 空启动——用独立 env 变量 PARSER_MODE=anydoc 覆盖或测试栈 .env 处理，见 Notes）docx 导入 → done(created) → slug `$KB/docs/test` → 检索命中中文与表格标记；健康检查 parser_mode=anydoc
- [X] T008 [P] [US1] 先写 tests/contract/health-mode.test.ts：`/health` 含 `parser_mode` 字段（docling|anydoc），docling 布尔语义不变——当前 500/缺字段，红灯

### Implementation for User Story 1

- [X] T009 [US1] apps/server/src/app.ts：`/health` 增加 `parser_mode`（resolveParser 结果透出）；doclingOk 未配置时返回 false 但不影响 status（FR-007）
- [X] T010 [US1] pipeline 接入 anydoc 分支的错误出口（rag_jobs.error 收映射文案）；跑 T007/T008 至全绿 + docling 模式既有测试零回归（quickstart 场景 4）

**Checkpoint**: 默认模式 docx 全链路独立验收 = quickstart 场景 1/3

## Phase 4: User Story 2 - 独有能力在默认模式下明确指引 (Priority: P1)

**Goal**: url/图片导入在 anydoc 模式 422 PARSER_UNAVAILABLE + 指引

**Independent Test**: 默认模式提交 url 与图片 → 均 422 且 message 含"配置 DOCLING_URL"

### Tests for User Story 2

- [X] T011 [P] [US2] 先写 tests/contract/parser-unavailable.test.ts：anydoc 模式 url 导入 422 code=PARSER_UNAVAILABLE；图片 multipart 422 同 code；md 直传不受影响（202）——红灯

### Implementation for User Story 2

- [X] T012 [US2] apps/server/src/openapi/routes/tenant.ts：submit handler 在 anydoc 模式对 url/图片分支抛 ParserUnavailableError（422 指引，docling 模式原逻辑不动）；跑 T011 至全绿

**Checkpoint**: US1+US2 叠加 = quickstart 场景 1/2/3

## Phase 5: User Story 3 - 扫描 PDF 处置语义 (Priority: P2)

**Goal**: needsOcr 失败带 OCR 指引；OCR 配置后自动升级 hosted

**Independent Test**: 单测 mock needsOcr：无 key → failed 文案含 OCR 指引；有 key → hosted 重试调用一次

### Tests for User Story 3

- [X] T013 [P] [US3] 补 tests/unit/parser.test.ts OCR 用例：needsOcr 无凭证 → 映射文案；有凭证 → 重试参数断言（ocr:'hosted' + apiKey）；hosted 仍失败 → 映射 hosted 错误

### Implementation for User Story 3

- [X] T014 [US3] anydoc-parser 补 hosted 重试完整分支（首次 needsOcr + 凭证 → 重试；重试结果/错误处理）；跑 T013 至全绿

**Checkpoint**: 三故事完成 = quickstart 全场景

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T015 [P] deploy/.env.example 增加 `FIRECRAWL_API_KEY` / `ANYDOC_OCR`（注释说明数据出机器）；README 解析器章节（默认 anydoc / docling 配置切换）
- [X] T016 回归与验证：docling 模式全量 73+新测试零回归；anydoc 模式集成子集通过；缺陷台账无新增（如发现缺陷按 docs/testing-strategy.md 登记）

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup**: T001/T002 并行
- **Foundational**: T003→T004→（T005∥T006）→ checkpoint 全量回归
- **US1**: T007/T008（测试先行）→ T009→T010
- **US2**: 依赖 Foundational（T012 触碰 submit handler，与 T010 同文件需串行——US2 在 US1 后）
- **US3**: 依赖 US1 的 T004（OCR 分支在 anydoc-parser 内）
- **Polish**: 全部故事后

### Parallel Opportunities

- T001∥T002；T005∥T006；T007∥T008（不同文件）；US1 完成后 US2/US3 可并行（T012 与 T014 不同文件）

---

## Implementation Strategy

### MVP First（US1）

1. Setup → 2. Foundational → 3. US1（T007-T010）
4. **STOP & VALIDATE**: quickstart 场景 1/3 + docling 模式 73 项零回归
5. MVP 闭环：默认模式 docx 导入可检索

### Incremental Delivery

US1（文件开箱即用）→ +US2（能力边界诚实指引）→ +US3（OCR 语义）→ Polish

---

## Notes

- **测试模式切换的关键约束**：现有实例 .env 配了 DOCLING_URL——us5/parser-unavailable 需要 **anydoc 模式实例**。方案：`resolveParser` 支持 env 显式覆盖 `PARSER_MODE=anydoc|docling|auto`（auto=现状按 DOCLING_URL），测试栈以 PARSER_MODE=anydoc 启动独立实例（端口 3101）跑 US1/US2 用例，docling 模式实例跑既有 73 项（docs/testing-strategy §3 隔离实例的首次落地）
- anydoc 是进程内 native——加载失败（NAPI/glibc）须在 T007 检查点显性失败而非静默降级
- 错误分类映射表集中于 anydoc-parser.ts 单处（data-model §2）
