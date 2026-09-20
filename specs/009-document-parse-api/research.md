# Phase 0 Research: 裸文档解析 API（009）

Phase 0 输出。spec 已零 `[NEEDS CLARIFICATION]`（3 处歧义在 clarify 会话中解决）；以下决策基于 004/005/008 的代码现状与实测。

## R1: 端点路径与认证族

- **Decision**: `POST /v1/kb/parse`，挂 `requireTenant` 中间件，**路径不含知识库段**。
- **Rationale**: FR-010 已澄清「仅需有效凭证、不要求绑定知识库」。若放 `/v1/kb/{id}/parse`，调用方必须持有一个具体的 kb id 才能调用，与澄清结论矛盾，且会诱导实现去查 `canReadKb`。`requireTenant` 中间件（`middleware/auth.ts:21`）只校验凭证有效性与吊销状态（`!row || row.revokedAt → 401`），天然贴合。
- **Alternatives considered**:
  - `/v1/kb/{id}/parse`（复用 `canReadKb`）：更贴合现有按库授权模型，但要求调用方先建库——被澄清否决。
  - 管理面 `/v1/admin/parse`：不占租户配额、语义更"运维"，但目标用户是**集成本服务的应用端**（租户侧），放管理面会让集成方拿到 ADMIN_TOKEN（权限过高）。
  - 顶层 `/v1/parse`：脱离 `/v1/kb` 前缀会让 OpenAPI tag 与既有路由族分裂；`/v1/kb/parse` 与 `/v1/kb/{id}/documents` 同级（`kb` 与 `{id}` 在路径段上不冲突，Hono 静态段优先于参数段）。

## R2: 输入分流顺序（三态）

- **Decision**: 完全复用 `routes/tenant.ts` 现有的 `contentType` 判定顺序：
  1. `multipart/form-data` → 文件（校验大小 → 判定类型受理 → 解析）
  2. `application/json` + `{url}` → 网页（`chain.url` 为 null → 不支持）
  3. `text/markdown` / `text/plain` → 直通（原样返回）
  4. 其他 → 422 参数不合法
- **Rationale**: 与导入端点行为一致（调用方学一次即可用两处）；`multipart` 判定在 `application/json` 之前是既有顺序，保持不引入行为差异。
- **Alternatives considered**: 统一 JSON body 传 base64 文件 —— 被否（+33% 体积、无法复用现有 multipart 基建、大文件内存翻倍）。
- **实测已验（2026-09-20，Hono 4.9）**: `/v1/kb/parse`（静态段）优先于 `/v1/kb/{id}/...`（参数段），互不遮蔽 —— 探针结果：`/v1/kb/parse → STATIC`、`/v1/kb/kb-abc123/documents → PARAM`、`/v1/kb/kb-abc123/retrieval → PARAM`。**故无需 fallback 路径**；原计划的前置实测任务据此取消，结论并入本行。

## R3: 直通（纯文本）路径

- **Decision**: `.md`/`.txt`（含 `text/markdown`、`text/plain`、以及 multipart 中扩展名为 md/txt 的文件）→ 原样返回正文，`parser: "passthrough"`，`duration_ms` 记录真实耗时（极短）。
- **Rationale**: FR-005 要求；与导入路径的「md 直通」语义一致（`pipeline.ts` 的 md 分支不经解析器）。在任何部署形态下都成功，是调用方最可靠的路径。
- **Alternatives considered**: 把纯文本也送去解析链 —— 被否（无意义开销，且未配置 docling 时会引入本不存在的失败）。

## R4: 文件类型受理白名单

- **Decision**: 复用 `anydoc-parser.ts` 的 `formatFromFilename()`（内部 `EXT_FALLBACK`）作为**唯一的受理白名单事实来源**，导出为公共查询。
- **Rationale**: FR-008 要求按内容优先、扩展名回退判定；`EXT_FALLBACK` 已覆盖 doc/docx/docm/ppt/pptx/pps/ppsx/pptm/xls/xlsx/xlsm/xlsb/odt/ods/odp/rtf/epub/csv/pdf 共 20 类。避免维护第二份类型表（否则两处必然漂移，重演 D22 类型漂移教训）。
- **Alternatives considered**: 在 `parse-api.ts` 内新写一份 `SUPPORTED_EXTS` —— 被否（重复事实来源）。
- **待确认**: 该函数当前是导出函数但语义为「回退用」；实现时若命名引起歧义则**改名导出**（如 `supportsFormatFromFilename`），调用点只有 2 处，重命名成本可接受。**不改其行为**。

## R5: 「不支持的文件类型」判定

- **Decision**: 判定式 = `!isSupportedType(filename) && chain.url === null` → `UNSUPPORTED_FILE_TYPE`。
  - `chain.url === null` 恰好等价于「部署未配置 docling 或强制 anydoc 模式」（`resolveParser` 的三个 null 分支）。
  - 配置了 docling 时不预先拒绝：让 docling 实际尝试（它可能有 whitelist 之外的能力），失败再归为解析失败。
- **Rationale**: 需求第 3 条：**未设定 docling 时**，anydoc 范围外 → 不支持。判定必须与"是否配置 docling"严格绑定，而 `chain.url === null` 就是这个事实的**现有**权威表达，无需新配置读取逻辑。
- **Alternatives considered**: 直接读 `cfg.DOCLING_URL === ""` —— 语义近似但忽略 `PARSER_MODE=anydoc` 强制模式（此时 DOCLING_URL 可能有值却不生效）；用 `chain.url === null` 更准确。

## R6: 解析并发上限

- **Decision**: 新增 `PARSE_CONCURRENCY`（默认 4），在 `parse-api.ts` 内实现**与 `gbrain-cli.ts` 同构**的信号量（有界排队 + 短等待 + 饱和 503）。
- **Rationale**: FR-011 要求解析不得挤占引擎容量、且自身上限饱和返回可重试错误。**已核实**（源码）：解析不经 `runGbrain`——anydoc 是进程内 native（热调用 ~0.03ms），docling 是 HTTP 出站（`docling.ts:57`）。故解析占用的是 **CPU（anydoc 对大文件）与出站连接（docling）**，与引擎 CLI 闸门是两套资源。
- **Alternatives considered**:
  - 复用 `GBRAIN_CLI_CONCURRENCY` 闸门 —— 被否：语义错误（该闸门保护的是引擎进程容量），会让解析请求与导入互相排队，放大耦合。
  - 不设上限 —— 被否：单请求可上传至 `MAX_UPLOAD_BYTES`（100MB），无上限时并发大文件可打满 CPU，间接影响同进程的导入/检索。
- **实现注意**: 沿用 `gbrain-cli.ts` 的**执行超时不含排队**语义，避免"排队耗尽超时"的复合失败。

## R7: 错误码体系

- **Decision**: 裸解析面新增 `UNSUPPORTED_FILE_TYPE`（422）与 `PARSE_BUSY`（503）；**保留**导入面既有 `PARSER_UNAVAILABLE`（422）与 `UPSTREAM_BUSY`（503）不动。
- **Rationale**: FR-013 要求结构化的失败分类；需求第 3 条要求"返回不支持的文件类型"这一**明确**语义。既有 `PARSER_UNAVAILABLE` 面向"通道不可用（图片/URL）"，新码面向"这个**文件类型**在当前部署不可解析"，语义更具体。SC-004 要求"类型不支持"与"容量/超时"两类错误码**互不重叠**——`UNSUPPORTED_FILE_TYPE`/`PARSER_UNAVAILABLE`（不重试）vs `PARSE_BUSY`（可重试）即满足。
- **Alternatives considered**: 复用 `PARSER_UNAVAILABLE` —— 会让调用方无法区分"上传了图片（导入面语义）"与"上传了不支持的文档格式"，且其 message 面向导入场景，措辞不合。

## R8: 不落盘与日志安全

- **Decision**: multipart 文件**仅在内存**传递（`await file.arrayBuffer()` → `Uint8Array`）；**不写** `incoming/`。解析正文与原始内容**绝不进入日志**；仅记录 `evt` + 字节数 + 类型 + 耗时 + 生效解析器。
- **Rationale**: FR-001/012（不写入知识库）+ Assumptions 的凭证明文安全（避免文档内容泄露）。现有导入路径必须落盘（worker 异步处理），但裸解析是**同步**的，无需暂存——这是本特性天然比导入更简单的地方。
- **Alternatives considered**: 复用 `incoming/` 暂存（若未来改异步）——当前不需要；若实现时发现内存峰值问题（多并发 × 100MB），改为 `mkdtemp` 于 `incoming/` 并在 `finally` 清理（plan.md R8 已记录该后备方案）。

## R9: 能力自描述（FR-014）

- **Decision**: 扩展 `GET /health` 现有三字段（`parser_mode` / `parser_primary` / `parser_preference` — 见 `routes/system.ts:36-38`）所在的响应，增加解析能力块：
  ```
  parse: {
    primary: "docling" | "anydoc",
    available_channels: ["anydoc", "docling"?],
    accepts_url: boolean,            // == chain.url !== null
    supported_file_types: string[],  // 扩展名列表（来自 R4 白名单）
    passthrough_types: ["md", "txt"]
  }
  ```
- **Rationale**: FR-014 要求调用方**预先**判断可解析性；放在 `/health` 而非新端点（该端点已是"部署能力只读视图"，且调用方已在探它）。SC-007 要求判定正确率 100%——同一函数产出该列表与实际受理判定，天然一致。
- **Alternatives considered**: 独立 `GET /v1/kb/parse/capabilities` —— 更 RESTful，但对一个纯只读能力视图而言多一个端点、多一次往返；`/health` 已在表达同类信息，**扩展现有**更符合"不做无谓抽象"。

## 测试矩阵（Phase 1 前置，落地到 tasks）

| 层 | 覆盖 |
|---|---|
| L0 单测（`parse-api.test.ts`） | 分流优先级（md/txt 直通 > url > file）；受理判定（白名单内/外 × chain.url 有/无 四象限）；能力描述构造；并发闸门（饱和 / 排队 / 释放） |
| L1 契约（`openapi-drift`，自动） | 新路由与 OpenAPI 描述双向一致 |
| L2 集成（门控 `parse-api.test.ts`） | 真解析 DOCX→MD；**导入 vs 裸解析正文逐字节一致 + 生效解析器相同**（SC-002）；未配置 docling 实例上：不支持类型 422 + 图片 422 + URL 422，且**外部服务零调用**（SC-003）；调用前后知识库页面/边/任务计数不变（SC-001/012）；`/health` 能力块与实测受理一致（SC-007） |

## 未决 → 已决

## R10: 类型判定必须内容优先（分析阶段发现的关键修正）

- **Decision**: 受理判定不得只用扩展名。采用**与解析通道自身完全相同**的链：`formatFromBytes(bytes) ?? formatFromFilename(filename)`。
- **Rationale**: FR-008 要求「按真实内容判定类型，扩展名仅作回退」。anydoc 实现（`anydoc-parser.ts:62`）正是这条链；实测 `formatFromBytes` 对 DOCX/PDF 魔数返回真实格式、对 PNG/纯文本返回 `null`。若裸解析端点只用扩展名判定，会**拒收**解析通道明明能处理的文件（如 `report.bin` 实为 PDF），与导入路径不一致，直接破坏 SC-002 的成立基础。
- **Alternatives considered**: 仅用扩展名（任务初版做法）—— 被否：违背 FR-008，可处理性由文件名而非内容决定，对集成方不可预期。
- **衍生约束**: 能力自描述（`/health` 的 `supported_file_types`）无内容可嗅探，只能列扩展名——故**描述与判定必然不完全重合**；SC-007 的「同源」精确化为：**描述用扩展名轨、判定用内容优先轨，两者共用同一白名单事实来源**，并在描述旁标注该差异。

## R11: `.txt` 直通是相对导入路径的有意差异

- **Decision**: `.md` 与 `.txt` 均直通；并须在 spec 与契约中**显式声明** `.txt` 是裸解析端点的扩展。
- **Rationale**: 调用方澄清明确要求接受 `.md`/`.txt` 且原样返回。实测导入路径对 `.txt` 会失败（`formatFromBytes(文本)→null`、`formatFromFilename("x.txt")→null`、md 判定 `false`），故两者行为必然不同——保留该行为，但把 SC-002 的适用范围限定为「两路都能处理的输入」，消除表面冲突。
- **Alternatives considered**: 让 `.txt` 也走解析链以保持严格一致 —— 被否：违背调用方澄清，且对纯文本做「解析」无意义。

## 未决 → 已决

Phase 0/分析阶段无残留 `NEEDS CLARIFICATION`。原 R2 的 Hono 路由实测已完成（结论见 R2）；分析阶段发现的 FR-008 实现偏离已在 R10 修正、`.txt` 差异在 R11 声明。
