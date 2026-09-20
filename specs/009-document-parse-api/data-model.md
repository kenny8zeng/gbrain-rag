# Phase 1 Data Model: 裸文档解析 API（009）

本特性**无持久化实体**——四类对象均为请求期值对象（value object），不落库、不进检索、不产生页面/图谱/任务数据（FR-001/012）。以下为对外契约中的数据形状（字段名即响应/请求字段，snake_case）。

## 1. ParseRequest（解析请求）

| 字段 | 类型 | 必填 | 来源 | 说明 |
|---|---|---|---|---|
| `input_kind` | `"file" \| "url" \| "text"` | 是 | 由 content-type 推导 | 三分支互斥；调用方不直接传该字段 |
| `file` | binary + filename | 文件时是 | `multipart/form-data` | 大小 ≤ `MAX_UPLOAD_BYTES`（超限 → 413） |
| `url` | string(url) | URL 时是 | `application/json` | 前端不做地址校验（沿用 FR-013 既有决策，部署须受信） |
| `text` | string | 文本时是 | `text/markdown` / `text/plain` | 空白-only → 422 |
| `credential` | 有效租户凭证 | 是 | `X-API-Key` | **仅校验有效性**，不绑定知识库（FR-010 已澄清） |

**验证规则**：
- `file.size > MAX_UPLOAD_BYTES` → 413 `PAYLOAD_TOO_LARGE`（含上限值，FR-009），**不进解析**
- `text.trim() === ""` → 422 `INVALID_PARAMS`
- `url` 缺失或非法 → 422 `INVALID_PARAMS`
- 凭证缺失/无效/已吊销 → 401 `UNAUTHORIZED`（无效与不存在同响应）

**生命周期**：进程内瞬态；`finally` 中释放（文件字节随作用域回收，无临时文件）。

## 2. ParseResult（解析结果）

| 字段 | 类型 | 说明 |
|---|---|---|
| `markdown` | string | 转换后的正文（直通路径即原文） |
| `parser` | `"docling" \| "anydoc" \| "passthrough"` | **实际生效**的解析路径（FR-004）；`passthrough` 表纯文本直通 |
| `fallback_from` | string \| null | 发生回退时给出首选失败的摘要（≤200 字符）；否则 null |
| `duration_ms` | number | 本次解析耗时（毫秒） |
| `chars` | number | 正文字符数 |
| `empty` | boolean | 正文为空时 true（**成功**状态，不伪装失败，见 spec Edge Cases） |

**不变量**：
- `parser === "passthrough"` ⟹ `fallback_from === null` 且未触达任何解析通道
- `parser` 的取值必须与「同一部署下走导入路径得到的生效解析器」一致（SC-002）
- `empty === true` 时 `markdown` 可为空串但状态仍为成功

## 3. ParserCapabilityProfile（解析能力描述，只读）

暴露于 `GET /health` 的 `parse` 块（FR-014）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `primary` | `"docling" \| "anydoc"` | 当前部署首选解析器 |
| `available_channels` | string[] | 可用通道集合（anydoc 恒在；docling 仅配置时在） |
| `accepts_url` | boolean | 是否接受网页地址（== `chain.url !== null`，即 docling 独有能力可用） |
| `supported_file_types` | string[] | 可受理扩展名（**来自任何doc 的单一白名单**，R4） |
| `passthrough_types` | `["md","txt"]` | 恒直通类型 |
| `concurrency` | number | 解析专用并发上限（`PARSE_CONCURRENCY`） |

**一致性约束（SC-007）**：`supported_file_types` 必须由**与实际受理判定同一个函数**产出——不允许"描述表"与"判定表"分离。

## 4. ParseFailure（解析失败）

| 分类 | 错误码 | HTTP | 可重试 | 触发条件 |
|---|---|---|---|---|
| 不支持的类型 | `UNSUPPORTED_FILE_TYPE` | 422 | ❌ | 文件类型不在白名单 **且** `chain.url === null`（未配置 docling / 强制 anydoc）；message 含类型与原因 |
| 通道不可用（输入形式） | `PARSER_UNAVAILABLE` | 422 | ❌ | URL/图片输入但 `chain.url === null`（沿用导入面既有码；message 说明所需配置） |
| 解析失败 | `PARSE_FAILED` | 422 | ❌ | 解析链执行失败；message 含双通道失败摘要（≤200 字符/通道） |
| 超时 | `PARSE_TIMEOUT` | 422 | ❌ | 单次解析超时（沿用现有解析超时值） |
| 容量饱和 | `PARSE_BUSY` | 503 | ✅ | 解析并发达上限且排队超短等待（FR-011） |
| 超限 | `PAYLOAD_TOO_LARGE` | 413 | ❌ | 文件 > `MAX_UPLOAD_BYTES`（FR-009） |
| 参数/凭证 | `INVALID_PARAMS` / `UNAUTHORIZED` | 422 / 401 | ❌ | 空文本/非法 URL/凭证无效 |

**SC-004 互斥性**：`{UNSUPPORTED_FILE_TYPE, PARSER_UNAVAILABLE, PARSE_FAILED, PARSE_TIMEOUT, PAYLOAD_TOO_LARGE, INVALID_PARAMS}`（不该重试）与 `{PARSE_BUSY}`（可重试）**集合不重叠**。

## 状态流转（请求生命周期）

```
接收 → 校验凭证 ──(无效)──→ 401（终态）
   ↓ 有效
判定输入形式 ──(无法识别)──→ 422 INVALID_PARAMS（终态）
   ↓
┌──────────────┬──────────────────┬───────────────────┐
│ text 直通     │ url              │ file              │
│ 原样返回      │ chain.url null?  │ 大小超限? → 413    │
│ (passthrough) │  ├ 是 → 422 不支持│ 类型不在白名单 ∧   │
│              │  └ 否 → 解析      │  chain.url null?   │
│              │                  │  ├ 是 → 422 不支持 │
│              │                  │  └ 否 → 解析       │
└──────────────┴──────────────────┴───────────────────┘
   ↓ 进入解析
获取解析并发槽 ──(饱和)──→ 503 PARSE_BUSY（可重试）
   ↓ 取得
执行解析链（primary → 失败 → fallback）
   ├ 成功 → 200 ParseResult
   └ 双失败 → 422 PARSE_FAILED（含双通道摘要）
   ↓ 释放槽（finally，含失败路径）
```

**并发语义**：并发槽的**执行超时不含排队时间**（沿用 `gbrain-cli.ts` 既有语义）；排队超过短等待即返回 `PARSE_BUSY`，不无限等待。

## 与既有数据的关系

| 既有对象 | 关系 |
|---|---|
| `pages` / `links` / `rag_jobs` | **无写入**（SC-001/FR-012 的验收依据：调用前后计数不变） |
| `rag_keys` | **只读**（凭证校验；不新增字段） |
| `ResolvedParser`（005） | **复用**，不修改其结构 |
| `FallbackResult`（005） | **复用**为 ParseResult 的内部来源（`used` → `parser`，`fallbackFrom` → `fallback_from`） |
