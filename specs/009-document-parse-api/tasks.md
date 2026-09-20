---

description: "Task list for 009 裸文档解析 API"
---

# Tasks: 裸文档解析 API（对外复用解析能力）

**Input**: Design documents from `/specs/009-document-parse-api/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/parse-api.md, quickstart.md

**Tests**: **包含**。项目既有纪律（AGENTS.md「修 bug 先补回归测试」、D1-D31 台账）要求新能力带测试；本特性的验收核心（SC-002 一致性、SC-003 零外部调用、SC-007 判定同源）**只能**由测试证明，故测试任务为必需项。

**Organization**: 按用户故事分组，每个故事可独立实现、独立测试、独立交付。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 所属用户故事（US1/US2/US3）
- 所有任务含确切文件路径

## Path Conventions

沿用本项目**双层单仓库**：`packages/core/src/`（纯领域，无 HTTP 框架）+ `apps/server/src/`（HTTP 装配）+ `tests/`（unit/contract/integration）。

---

## Phase 1: Setup（共享前置）

**Purpose**: 确认既有解析链可直接复用，锁定接口形状

- [ ] T001 复核解析链对外形状：确认 `packages/core/src/ingest/resolver.ts` 的 `resolveParserFor` 返回 `{mode, primary, fallback, url}` 且 `apps/server/src/openapi/routes/tenant.ts` 已有 `isImageExt`/`IMAGE_EXTS` 可复用（读取，不改码）
- [ ] T002 [P] 复核 anydoc 受理白名单：读取 `packages/core/src/ingest/anydoc-parser.ts` 的 `EXT_FALLBACK` 与 `formatFromFilename`，确认导出形态足以支撑受理判定与能力自描述（plan.md「实现期注意事项」第 2 条：如需语义清晰别名则新增导出，**不删旧名、不改行为**）
- [ ] T003 [P] 复核测试基建：确认 `tests/fixtures/test.docx`（1543B）可用于集成解析样本，且 `tests/contract/openapi-drift.test.ts` 的桩 Services 模式可承载新路由（读取，不改码）

---

## Phase 2: Foundational（阻塞性前置，必须先于所有用户故事）

**Purpose**: 新错误码、核心纯函数模块骨架、并发闸门——所有故事都依赖

- [ ] T004 在 `packages/core/src/config.ts` 新增 `PARSE_CONCURRENCY`（`z.coerce.number().int().positive().default(4)`），紧邻 `JOB_TIMEOUT_MS`/`MAX_UPLOAD_BYTES` 放置，附注释说明「解析专用并发上限，独立于引擎 CLI 闸门（解析不经 runGbrain，见 research R6）」
- [ ] T005 在 `packages/core/src/ingest/parse-api.ts` 新建模块并定义对外类型：`ParseInputKind`、`ParseResult`（`markdown`/`parser`/`fallback_from`/`duration_ms`/`chars`/`empty`）、`ParseCapabilityProfile`、`ParseFailureCode`；字段名严格对齐 `specs/009-document-parse-api/data-model.md`
- [ ] T006 在 `packages/core/src/ingest/parse-api.ts` 实现**解析专用有界信号量**（镜像 `packages/core/src/gbrain-cli.ts` 的闸门实现：上限获取、有界排队、超等待抛饱和错误、`finally` 释放、执行超时不含排队），饱和错误类型 `ParseBusyError`
- [ ] T007 [P] 在 `packages/core/src/ingest/parse-api.ts` 实现**双轨**受理判定（纯函数）：① `isSupportedByExtension(filename): boolean` —— 委托 `packages/core/src/ingest/anydoc-parser.ts` 的 `formatFromFilename`（纯扩展名，用于**能力自描述**与无内容场景）；② `isSupportedBytes(bytes, filename): boolean` —— 与解析通道自身**完全一致**的判定链 `formatFromBytes(bytes) ?? formatFromFilename(filename)`（`@firecrawl/anydoc` 导入；FR-008 要求内容优先；实测 `formatFromBytes` 对 DOCX/PDF 魔数返回真实格式、对 PNG/纯文本返回 null）。**实际受理判定必须用 ②，能力自描述用 ①**
- [ ] T008 [P] 在 `packages/core/src/ingest/parse-api.ts` 实现纯函数 `buildCapabilityProfile(cfg): ParseCapabilityProfile`（`primary`/`available_channels`/`accepts_url`/`supported_file_types`/`passthrough_types`/`concurrency`）

**Checkpoint**: 错误类型、闸门、两个纯函数就绪 → 用户故事可并行开工

---

## Phase 3: User Story 1 - 应用端复用解析能力转换单个文档 (Priority: P1) 🎯 MVP

**Goal**: 集成方持有效凭证即可把文档转成 Markdown，**不写入任何知识库**。

**Independent Test**: `curl -F "file=@tests/fixtures/test.docx" /v1/kb/parse` 返回 Markdown + 解析器标识 + 耗时；调用前后目标知识库页面数不变。

### Tests for User Story 1

- [ ] T009 [P] [US1] 新建 `tests/unit/parse-api.test.ts`：断言 `isSupportedFileType` 白名单内/外判定（含 `test.docx`→true、`x.xyz`→false、无扩展名、大写扩展名）
- [ ] T010 [P] [US1] 在 `tests/unit/parse-api.test.ts` 断言 `buildCapabilityProfile` 三形态输出（anydoc 唯一 / docling 已配 prefer=docling / 强制 anydoc），且 `supported_file_types` 与 `isSupportedByExtension` 逐项同源（SC-007 单测层）；**并断言内容优先**：构造「扩展名不可识别但内容可嗅探」样本（如把 `tests/fixtures/test.docx` 另存为 `sample.bin`），断言 `isSupportedBytes` 为 true 而 `isSupportedByExtension` 为 false —— 锁死 FR-008
- [ ] T011 [P] [US1] 新建 `tests/unit/parse-gate.test.ts`：解析闸门语义（上限内并发通过 / 超上限排队后饱和抛 `ParseBusyError` / 失败路径释放槽 / 执行超时不含排队），参照既有 `tests/unit/gbrain-cli-gate.test.ts` 的真进程或注入式手法

### Implementation for User Story 1

- [ ] T012 [US1] 在 `packages/core/src/ingest/parse-api.ts` 实现 `parseDocument(deps, input)`：文件分支走 `convertWithFallback(chain, bytes, filename)` → 映射为 `ParseResult`（`used`→`parser`、`fallbackFrom`→`fallback_from`、计时、`chars`、`empty`）；直通分支（md/txt）原样返回且 `parser:"passthrough"`；全程经 T006 闸门
- [ ] T013 [US1] 在 `apps/server/src/openapi/routes/tenant.ts` 新增 `POST /v1/kb/parse` 路由：`createRoute` + `libHandler`，`middleware:[tenant]`（仅校验凭证有效——FR-010），`request.body` 用宽松 `z.object({file: z.unknown().optional()}).openapi({format:"binary"})` 兼容 multipart，响应 200 用 `ParseResultView`；注册于 `registerTenantRoutes` 内
- [ ] T014 [US1] 在 `apps/server/src/openapi/schemas.ts` 新增 `ParseResultView`（snake_case 字段，含 `fallback_from: z.string().nullable()`、`empty: z.boolean()`）
- [ ] T015 [US1] 在 `apps/server/src/openapi/routes/tenant.ts` 的 handler 内实现三态输入分流（multipart→文件 / `application/json`→URL / `text/markdown|text/plain`→直通 / 其他→422），并做 413 大小校验（复用 `MAX_UPLOAD_BYTES`）与空文本 422
- [ ] T016 [US1] 新增集成测试 `tests/integration/parse-api.test.ts`（门控 `const gated = BASE && ADMIN ? describe : describe.skip`）：用**仅有效但未绑定知识库**的凭证成功解析 `test.docx`（SC-001 的关键验收），断言 `markdown` 非空、`parser` ∈ {anydoc, docling}、`duration_ms > 0`
- [ ] T017 [US1] 在 `tests/integration/parse-api.test.ts` 断言**无副作用**：解析前后目标知识库 `/documents` 页面数与 `/documents/jobs` 任务数不变（FR-012），并在 `afterAll` 清理所建资源

**Checkpoint**: US1 独立可交付（MVP）——集成方可用一次请求转换文档且零写入

---

## Phase 4: User Story 2 - 解析器优先级由部署设定统一决定 (Priority: P2)

**Goal**: 导入与裸解析走**同一套**部署级优先级；调用方无法覆盖。

**Independent Test**: 同一文件分别走导入与裸解析，`markdown` 逐字节一致且 `parser` 相同；改变部署优先级后两者同时变化。

### Tests for User Story 2

- [ ] T018 [P] [US2] 在 `tests/unit/parse-api.test.ts` 断言优先级不可覆盖：请求体携带任何解析器偏好字段（如 `parser`/`preference`/`mode`）被忽略，结果与不携带时逐字节一致（FR-003）
- [ ] T019 [US2] 在 `tests/integration/parse-api.test.ts` 实现 **SC-002 一致性对拍**：同一 `test.docx` 走导入与裸解析两条路径，断言 `markdown` **逐字节相同**且生效解析器相同（用 `expect(a).toBe(b)` 直接比对字符串，不做规范化）

### Implementation for User Story 2

- [ ] T020 [US2] 在 `apps/server/src/openapi/routes/tenant.ts` 的 parse handler 内**显式丢弃**请求中任何解析器偏好字段（不读、不转发），并加注释标注 FR-003 的意图（防止后续重构无意引入覆盖点）
- [ ] T021 [US2] 在 `packages/core/src/ingest/parse-api.ts` 确保解析链取自 `resolveParserFor(cfg)`（**唯一入口**），不缓存、不派生第二份链实例，与 `pipeline.ts` 的文件分支同源
- [ ] T022 [US2] 在 `tests/integration/parse-api.test.ts` 断言回退语义与导入一致：**必须运行在 docling 不可达 + `PARSER_PREFERENCE=docling` + `PARSER_MODE=auto` 的实例**（这是唯一会产生回退的形态；`PARSER_MODE=docling/anydoc` 强制模式**无回退**，不可用于本用例）——断言解析成功、`fallback_from` 非空、`parser` 为回退后通道（anydoc）

- [ ] T022a [US2] 实现 **SC-005 部署翻转对拍**：在 anydoc 唯一实例与 docling 可用实例上，对同一文件断言生效解析器不同；并在 anydoc 唯一实例断言 URL 不可解析（`PARSER_UNAVAILABLE`）、docling 实例断言 URL 可解析 —— 复用既有 `deploy/compose.test.yaml` 多实例矩阵（见 `docs/testing-strategy.md` 多实例章节）

**Checkpoint**: 一致性契约（SC-002/SC-005）被测试锁死

---

## Phase 5: User Story 3 - 部署未配置外部解析服务时明确拒绝不支持的类型 (Priority: P3)

**Goal**: 未配置 docling 时，anydoc 范围外类型返回**明确的「不支持」错误**，且零外部调用。

**Independent Test**: anydoc 唯一形态下，白名单外类型 → `UNSUPPORTED_FILE_TYPE`；图片/URL → `PARSER_UNAVAILABLE`；且 `DOCLING_URL` 指向不可达地址时仍返回上述错误（证明判定在任何出站之前）。

### Tests for User Story 3

- [ ] T023 [P] [US3] 在 `tests/unit/parse-api.test.ts` 断言受理判定四象限：`白名单内 × chain.url 有/无`（均受理）与 `白名单外 × chain.url 有/无`（前者交解析、后者不支持），穷举 `resolveParser` 的三条 null 分支
- [ ] T024 [US3] 在 `tests/integration/parse-api.test.ts` 断言 anydoc 唯一实例上：`.xyz` 文件 → 422 `UNSUPPORTED_FILE_TYPE` 且 message 含类型；图片 → 422 `PARSER_UNAVAILABLE`；URL → 422 `PARSER_UNAVAILABLE`（SC-003）
- [ ] T025 [US3] 在 `tests/integration/parse-api.test.ts` 实现**零外部调用反证**：将 `DOCLING_URL` 指向不可达地址后请求 URL 解析，断言仍返回 `PARSER_UNAVAILABLE`（而非 `PARSE_FAILED` 连接错误）——证明判定先于出站
- [ ] T026 [US3] 在 `tests/integration/parse-api.test.ts` 断言错误码分类互斥（SC-004）：`UNSUPPORTED_FILE_TYPE`/`PARSER_UNAVAILABLE`/`PARSE_FAILED`/`PARSE_TIMEOUT`/`PAYLOAD_TOO_LARGE`/`INVALID_PARAMS` 集合与 `{PARSE_BUSY}` **无交集**

### Implementation for User Story 3

- [ ] T027 [US3] 在 `packages/core/src/ingest/parse-api.ts` 实现受理判定与错误映射：`!isSupportedFileType(name) && chain.url === null` → `UNSUPPORTED_FILE_TYPE`；图片/URL 且 `chain.url === null` → `PARSER_UNAVAILABLE`（复用既有 `ParserUnavailableError`）；错误消息含类型与所需配置（FR-005a/FR-006）
- [ ] T028 [US3] 在 `packages/core/src/ingest/parse-api.ts` 实现解析失败映射：`ParseError` → `PARSE_FAILED`（双通道摘要，各截断 200 字符）；**超时 → `PARSE_TIMEOUT`**（判定规则：外部解析服务出站经 `AbortSignal.timeout(min(JOB_TIMEOUT_MS, 110_000))` 中止时错误为 `TimeoutError`/`AbortError`，据此识别并映射——见 `packages/core/src/ingest/docling.ts:60,82`；内置解析器为进程内调用不产生该错误；双通道皆失败且含超时时按 `PARSE_FAILED` 聚合并在摘要标注超时通道）；饱和 → `PARSE_BUSY`（503）
- [ ] T029 [US3] 在 `apps/server/src/openapi/routes/tenant.ts` 的 parse handler 内映射上述错误到 HTTP（422/503），沿用 `{error:{code,message}}` envelope 与 `libHandler` 形态
- [ ] T030 [US3] 在 `apps/server/src/openapi/routes/system.ts` 的 `/health` 响应增加 `parse: buildCapabilityProfile(svc.cfg)` 块（**不依赖**既有 `parser_mode`/`parser_primary` 字段，见 plan.md 实现期注意事项第 1 条）
- [ ] T031 [US3] 在 `tests/integration/parse-api.test.ts` 断言 `/health` 的 `parse` 块与实际受理行为**逐项一致**（SC-007）：`supported_file_types` 中每类上传均被受理；列表外类型在「内容亦不可识别」时必报不支持（内容可嗅探者按内容优先受理，见 T007/T007a）
- [ ] T031a [US3] 在 `tests/integration/parse-api.test.ts` 断言**纯文本例外有边界**（FR-005a）：扩展名不可识别（`.xyz`）**但内容为纯文本**的输入按直通返回（`parser:"passthrough"`）而非 `UNSUPPORTED_FILE_TYPE`；同时断言真正的二进制乱码（PNG 魔数 + `.xyz` 名）在 anydoc 唯一形态下**确实**返回不支持 —— 两例对拍证明例外不越界
- [ ] T031b [US3] 验证 **SC-006**（并发不挤占）：并发发起远超 `PARSE_CONCURRENCY` 的解析请求，期间对同实例发起知识库导入与检索请求，断言后者全部得到成功或可重试响应（无不可用错误）；手法参照并发压测脚本模式，脚本临时创建并在验证后删除

- [ ] T031c [US3] 验证 **内容优先的端到端效果**：把 `tests/fixtures/test.docx` 以扩展名不可识别的名字（如 `sample.bin`）提交解析，断言**受理并成功**（而非 `UNSUPPORTED_FILE_TYPE`）—— 证明 FR-008 在真实请求路径上生效（呼应 T007 双轨与 T010 单测）

**Checkpoint**: 能力边界与错误契约完全锁死，三条需求全部落地

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: 契约零漂移、文档同步、全量回归

- [ ] T032 确认 `tests/contract/openapi-drift.test.ts` 自动覆盖新路由（新增路由后**必须**跑一次该测试确认双向一致；若桩 Services 缺 parse 能力则补齐）
- [ ] T033 [P] 在 `docs/usage.md` 新增「裸文档解析」章节：端点、三种输入形式示例、分流矩阵、错误码表（对齐 `contracts/parse-api.md`）
- [ ] T034 [P] 在 `docs/deployment.md` 补 `PARSE_CONCURRENCY` 到配置表（含「独立于引擎 CLI 闸门」说明）
- [ ] T035 [P] 在 `CHANGELOG.md` 的 `[Unreleased] ### Added` 记录 009 特性要点（端点、三态输入、能力自描述、错误码、零写入）
- [ ] T036 [P] 同步 `README.md` 与 `README.zh-CN.md`（中英同构，改一处必须同步另一处）加入解析 API 特性条目
- [ ] T037 运行 `bun x tsc --noEmit` 与 `bun run test`（全量唯一入口，见 `package.json`）确认零失败
- [ ] T038 本地栈实测走通 `specs/009-document-parse-api/quickstart.md` 全部 8 个场景（含 SC-002 逐字节对拍与 SC-003 零外部调用反证）
- [ ] T039 提交并推送（main + dev），部署生产后按 `specs/009-document-parse-api/quickstart.md` 场景 1/2/4/5 复验（含 anydoc 唯一与 docling 可用两种部署形态）

---

## Dependencies

```
T001-T003 (Setup，读码确认)
        ↓
T004-T008 (Foundational：配置/类型/闸门/纯函数)  ← 阻塞所有故事
        ↓
   ┌────┴────┬─────────┐
 US1 (T009- T017)  US2 (T018-T022)  US3 (T023-T031)
   │         │            │
   └─────────┴────────────┘
              ↓
   Polish (T032-T039)
```

- **US1 是 MVP**：完成后即可交付（集成方能转换文档）
- **US2 依赖 US1** 的端点与解析调用（T012/T013 先落地）；T018/T020 可独立并行
- **US3 依赖 US1** 的 handler 骨架（T029 在其上添加错误映射）；T027/T028 是纯函数，可与 US2 并行
- **T030（/health）仅依赖 T008**，可与任一故事并行

## Parallel Execution Examples

**US1 内并行**（三个测试文件互不相干）：
```
T009 [P] tests/unit/parse-api.test.ts（白名单判定）
T010 [P] tests/unit/parse-api.test.ts（能力描述）      ← 同文件，串行于 T009
T011 [P] tests/unit/parse-gate.test.ts（闸门语义）
```

**跨故事并行**（Foundational 完成后）：
```
T027 + T028 [P] parse-api.ts 错误映射（US3 纯函数）
T018 [P] 偏好忽略单测（US2）
T030 [P] /health 能力块（system.ts，与 tenant.ts 不同文件）
```

**Polish 并行**：
```
T033 [P] docs/usage.md
T034 [P] docs/deployment.md
T035 [P] CHANGELOG.md
T036 [P] README.md + README.zh-CN.md
```

## Implementation Strategy

**MVP First**：完成 Phase 1-3（T001-T017）即得到可交付增量——集成方能用一次请求把文档转成 Markdown 且零写入。此时 US2/US3 的强化（一致性锁死、能力边界明确化）尚未落地，但核心价值已可用。

**Incremental Delivery**：
1. Phase 2 完成 → 纯函数与闸门可单测（先绿）
2. US1 完成 → **演示：真实 docx 转 Markdown + 知识库零变化**
3. US2 完成 → **演示：导入 vs 解析正文逐字节一致**
4. US3 完成 → **演示：未配置 docling 时明确拒绝 + 零外部调用**
5. Polish → 文档同步、全量回归、生产复验

**关键纪律**：
- 每个实现任务先写对应测试（T009-T011、T018-T019、T023-T026 均列于同名故事的实现块之前）
- 提交前必跑 `bun run test`（裸 `bun test` 的 5s 超时会误杀集成测试）
- 不修改导入面既有契约与错误码（`PARSER_UNAVAILABLE` 在导入面的语义保持不动）
