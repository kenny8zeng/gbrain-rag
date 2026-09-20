# Implementation Plan: 裸文档解析 API（009）

**Branch**: `009-document-parse-api` | **Date**: 2026-09-20 | **Spec**: [spec.md](spec.md) | **Research**: [research.md](research.md)

**Input**: 对外复用解析能力的裸文档解析 API；解析器优先级统一由部署设定决定；未配置 docling 时 anydoc 范围外类型返回「不支持的类型」。

## Summary

把**已存在的解析链**（005 的 `resolveParserFor` + `convertWithFallback` + `chain.url`）暴露为一个新的**租户面只读端点**，不做任何写入：

1. **端点**：`POST /v1/kb/parse`（挂在租户认证下，但路径不含 kb 段——FR-010 已澄清「仅需有效凭证、不要求绑定知识库」）。
2. **输入分流**（三条互斥路径，顺序即优先级）：
   - `.md`/`.txt` → **直通**（原样返回，零解析、零外部调用）
   - URL（JSON body `{url}`）→ `chain.url`（docling 独有；`null` 时 422 不支持）
   - 文件（multipart）→ `convertWithFallback(chain, bytes, filename)`（primary → 回退，与导入完全同链）
3. **能力判定**：文件类型受理由 `formatFromFilename`（anydoc 的 `EXT_FALLBACK` 白名单）判定；不在范围内且 `chain.url === null` → 422 `UNSUPPORTED_FILE_TYPE`。
4. **自描述**：扩展现有 `GET /health` 的解析字段为一个能力描述块（首选/可用通道/各通道类型范围），使调用方预先判断可解析性（FR-014）。
5. **容量**：解析不走引擎 CLI 闸门（已核实），另设**解析专用并发上限**，饱和返回 503 `PARSE_BUSY`（可重试，与 `UPSTREAM_BUSY` 语义并列但独立）。

**不新增**：解析器实现、配置项类别（并发上限除外）、数据库表、持久化。

## Technical Context

**Language/Version**: TypeScript + Bun（沿用 core 纯领域层 / server 装配层分离）

**Primary Dependencies**: **零新增**。复用 `resolveParserFor`、`convertWithFallback`、`formatFromFilename`、现有 `ParserUnavailableError` / `ParseError`

**Storage**: **无**。解析输入与产出均不落库（FR-001/012）；仅请求期内存 + 现有 `incoming/` 临时目录（若需 multipart 暂存），请求结束即清

**Testing**: `bun run test`（全量唯一入口）。新增：解析分流纯函数单测（类型判定/URL-vs-文件优先级）、`UNSUPPORTED_FILE_TYPE` 判定单测、契约测试（零漂移纳入新路由）、门控集成（真解析 + 「导入 vs 裸解析正文逐字节一致」+ 未配置 docling 的零外部调用）

**Target Platform**: Linux 容器（现有；多实例矩阵沿用 004/005 的 3101-3103）

**Project Type**: web-service（core 领域 + server 装配，与 001-008 一致）

**Performance Goals**: 直通路径常数时间（不触发解析）；解析路径受解析并发上限约束；饱和时立即 503 而非排队至超时（FR-011）

**Constraints**:
- core 不得引入 HTTP 服务器框架（新逻辑放 `packages/core/src/ingest/`，纯函数形态）
- 路由走 `createRoute` + `libHandler`；响应字段 **snake_case**；OpenAPI 零漂移闸门必须通过
- 引擎调用仍只能经 `runGbrain`（本特性**不调用**引擎）
- 解析结果不得写入任何知识库（FR-012 以调用前后页面数/边数/任务数不变为验收）

**Scale/Scope**: 单文件/单 URL 同步转换；不涉及数据规模假设

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` 为**未填充模板**（无 ratified 原则）→ 以仓库既有工程约定作为事实标准，逐条核对：

| 约定（源自 AGENTS.md / 004-008 实践） | 本特性遵循情况 |
|---|---|
| core 无 HTTP 框架，新能力 = core 纯函数 + server 路由装配 | ✅ 分流/判定逻辑入 `packages/core/src/ingest/parse-service.ts`（纯函数 + 可注入解析链） |
| 路由必须 `createRoute` + `libHandler`，零漂移 | ✅ 新增路由并入 `routes/tenant.ts`，契约测试自动覆盖 |
| 响应 snake_case、错误 `{error:{code,message}}` | ✅ 新错误码 `UNSUPPORTED_FILE_TYPE` / `PARSE_BUSY` 沿用 envelope |
| 测试纪律：先回归测试、缺陷台账 D# | ✅ Phase 1 定义测试矩阵；无新缺陷（新能力） |
| 全量测试唯一入口 `bun run test` | ✅ |
| 不做无谓抽象/新依赖 | ✅ 零新依赖；直接复用 005 解析链 |
| 凭证安全：不泄露存在性；明文不落日志 | ✅ 401 语义沿用中间件；**解析正文绝不入日志** |
| 平台中立（部署细节不进文档） | ✅ 文档仅描述能力与配置语义 |

**Gate 结论：PASS**（无 violation，Complexity Tracking 留空）

## Project Structure

### Documentation (this feature)

```text
specs/009-document-parse-api/
├── plan.md              # 本文件
├── research.md          # Phase 0：决策记录（R1-R8）
├── data-model.md        # Phase 1：请求/结果/能力描述/失败 四对象 + 状态流转
├── quickstart.md        # Phase 1：可运行验收剧本
├── contracts/
│   └── parse-api.md     # Phase 1：端点契约 + 分流矩阵 + 错误码表
└── tasks.md             # Phase 2（/speckit.tasks 产出）
```

### Source Code (repository root)

```text
packages/core/src/ingest/
├── parse-api.ts         # 新增：纯函数分流 + 类型受理判定 + 能力描述构造（可注入链，便于单测）
├── parser.ts            # 复用：ResolvedParser / ParserUnavailableError / ParseError
├── resolver.ts          # 复用：resolveParserFor（部署级优先级唯一入口）
├── fallback.ts          # 复用：convertWithFallback（文件主/回退链）
└── anydoc-parser.ts     # 复用：formatFromFilename（类型受理白名单）

apps/server/src/openapi/routes/
├── tenant.ts            # 改：新增 POST /v1/kb/parse（三态输入分流）
└── system.ts            # 改：/health 增加解析能力描述块

apps/server/src/
├── middleware/auth.ts   # 复用：requireTenant（仅校验凭证有效，不查 kb 授权）
└── app.ts               # 改：Services 暴露 parse 能力（或复用 cfg 直取解析链）

tests/
├── unit/parse-api.test.ts          # 新增：分流/受理判定/能力描述
├── contract/openapi-drift.test.ts  # 自动覆盖新路由（无需改）
└── integration/parse-api.test.ts   # 新增：门控（真解析 + 一致性 + 零外部调用）
```

**Structure Decision**: 沿用**单仓库双层**（core 纯领域 + server 装配）。新解析服务逻辑全部落在 `packages/core/src/ingest/parse-api.ts`，路由只做 HTTP 卸载与错误映射——与 004/005 的解析链、008 的 `entity-graph.ts` 完全同构。**不新建路由文件**（`/v1/kb/parse` 属租户面，与 `tenant.ts` 同认证族，且该文件已有三态输入的同类先例）。

## 设计决策（Phase 0 摘要，详见 research.md）

| # | 决策 | 要点 |
|---|---|---|
| R1 | 端点路径 `POST /v1/kb/parse` | 租户认证族；路径**不含** kb 段以匹配 FR-010「不要求绑定知识库」 |
| R2 | 三态输入复用现有 `contentType` 分流模式 | 与 `POST /v1/kb/{id}/documents` 完全一致的判定顺序；URL 用 `{url}` JSON |
| R3 | 直通优先于一切 | `.md`/`.txt` 在**任何**部署形态下都成功（不受 docling 配置影响） |
| R4 | 文件受理白名单 = anydoc 的 `EXT_FALLBACK` | 复用单一事实来源，避免第二份类型表 |
| R5 | 不支持判定 = 不在白名单 ∧ `chain.url === null` | 未配置 docling 且类型在外 → `UNSUPPORTED_FILE_TYPE`；配置了则交 docling 尝试 |
| R6 | 解析专用并发上限（新 env `PARSE_CONCURRENCY`，默认 4） | 独立于 `GBRAIN_CLI_CONCURRENCY`（解析不走该闸门）；饱和 → 503 `PARSE_BUSY` |
| R7 | `UNSUPPORTED_FILE_TYPE` 与 `PARSER_UNAVAILABLE` 的关系 | **新增专用码**给裸解析面（含文件类型与原因），保留既有码给导入面不动（向后兼容） |
| R8 | 不落盘 | multipart 文件仅内存传递；若需临时文件用 `mkdtemp` 于 `incoming/`，`finally` 清理 |

## Complexity Tracking

> 无 Constitution Check violation，本节留空。

## 实现期注意事项（相邻既有问题，不在本特性范围）

- **`/health` 的 `parser_mode` 与 `parser_primary` 当前是同一表达式**（`routes/system.ts:36-37` 均取 `resolveParserFor(cfg).mode`），而 005 契约（`specs/005-parser-priority-fallback/contracts/parser-priority.md`）声称 `parser_mode` 保持 004 旧语义（"docling 配置态"）。这是 005 遗留的实现/契约漂移，**009 不修复**（避免混入无关变更、破坏 004/005 既有断言）。新增 `parse` 块时**不依赖**这两个字段，只依赖 `resolveParserFor(cfg)` 的返回值本身——从而与该漂移解耦。
- **`formatFromFilename` 的命名**：其现名为"从文件名取格式"（回退用途语义）。若实现中直接复用于受理判定会引起阅读歧义，可**新增语义清晰的别名导出**（不删旧名、不改行为），因为既有调用点仅 1 处（`anydoc-parser.ts` 内部）。

