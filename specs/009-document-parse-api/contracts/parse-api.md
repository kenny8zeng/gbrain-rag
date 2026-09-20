# Contract: 裸文档解析 API（009）

## 端点

```
POST /v1/kb/parse
认证：X-API-Key（仅需凭证有效，不要求绑定任何知识库 —— FR-010）
副作用：无（不写入任何知识库、不落盘、不产任务）
```

> 路径**不含** `{id}` 段：解析与具体知识库无关。与 `/v1/kb/{id}/...` 同层不冲突（已实测 Hono 4.9 静态段优先于参数段）。

## 三种输入形式（互斥，按 content-type 判定）

### 1. 文件（multipart/form-data）

```bash
curl -X POST "$BASE/v1/kb/parse" -H "X-API-Key: $KEY" \
  -F "file=@spec.docx"
```

### 2. 网页地址（application/json）

```bash
curl -X POST "$BASE/v1/kb/parse" -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/page"}'
```

### 3. 纯文本直通（text/markdown 或 text/plain）

```bash
curl -X POST "$BASE/v1/kb/parse" -H "X-API-Key: $KEY" \
  -H "Content-Type: text/markdown" \
  --data-binary @notes.md
```

## 成功响应

**200**：

```json
{
  "markdown": "# 标题\n\n正文…",
  "parser": "anydoc",
  "fallback_from": null,
  "duration_ms": 42,
  "chars": 1834,
  "empty": false
}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `parser` | `docling` / `anydoc` / `passthrough` | **实际生效**路径；回退成功时报告回退后那个 |
| `fallback_from` | string / null | 首选失败摘要（发生回退时） |
| `empty` | boolean | 正文为空仍为**成功**（`empty: true`） |

## 分流决策矩阵（部署形态 × 输入形式）

| 部署形态 | `.md`/`.txt` | 白名单内文档 | 白名单外文档 | 图片 | URL |
|---|---|---|---|---|---|
| 任意（含强制 anydoc） | **直通 ✅** | 解析（anydoc）✅ | **422 不支持** | **422 不支持** | **422 不支持** |
| `auto` + docling 已配置（pref=docling） | **直通 ✅** | docling →(失败)anydoc ✅ | docling 尝试 ✅/失败 | docling ✅ | docling ✅ |
| `auto` + docling 已配置（pref=anydoc） | **直通 ✅** | anydoc →(失败)docling ✅ | anydoc 失败 → docling 尝试 | docling ✅ | docling ✅ |
| `PARSER_MODE=docling`（强制） | **直通 ✅** | docling ✅/失败（无回退） | docling 尝试 | docling ✅ | docling ✅ |
| `PARSER_MODE=anydoc`（强制） | **直通 ✅** | anydoc ✅/失败（无回退） | **422 不支持** | **422 不支持** | **422 不支持** |

**判定式**（唯一规则）：`内容与扩展名均不可判定 ∧ chain.url === null` → `UNSUPPORTED_FILE_TYPE`。

**内容嗅探优先（FR-008）**：受理判定采用与解析通道自身一致的判定链——先内容嗅探（`formatFromBytes`），后扩展名回退（`formatFromFilename`）。因此「扩展名不标准但内容可识别」的文件（如 `report.bin` 实为 PDF）**会被受理**。

| 情形 | 扩展名轨 | 内容轨（实际受理） | 行为 |
|---|---|---|---|
| 白名单扩展名 + 内容可识别 | true | true | 受理 → 解析 ✅ |
| 白名单扩展名 + 内容不可识别 | true | true（扩展名回退） | 受理 → 解析（可能 `PARSE_FAILED`） |
| **非白名单扩展名 + 内容可识别** | false | **true** | **受理 → 解析 ✅**（内容优先） |
| 非白名单扩展名 + 内容为纯文本 | false | false | **直通**（FR-005a 纯文本例外） |
| 非白名单扩展名 + 内容不可识别 | false | false | **422 `UNSUPPORTED_FILE_TYPE`**（仅当 `chain.url === null`） |
`chain.url === null` 精确等价于「未配置 docling **或** 强制 anydoc 模式」（`resolveParser` 的三个 null 分支）。

> 直通路径**恒定成功**——不受任何部署形态影响（这是调用方最可靠的一条路）。

## 错误码表

| HTTP | 码 | 可重试 | 触发 | message 要点 |
|---|---|---|---|---|
| 401 | `UNAUTHORIZED` | ❌ | 凭证缺失/无效/已吊销（三态同响应，不泄露存在性） | `invalid api key` |
| 413 | `PAYLOAD_TOO_LARGE` | ❌ | 文件 > `MAX_UPLOAD_BYTES` | 含上限字节数 |
| 422 | `UNSUPPORTED_FILE_TYPE` | ❌ | 白名单外 ∧ `chain.url === null` | 含**文件类型**与原因 |
| 422 | `PARSER_UNAVAILABLE` | ❌ | URL/图片输入 ∧ `chain.url === null` | 含所需配置指引 |
| 422 | `PARSE_FAILED` | ❌ | 解析链双失败 | 双通道失败摘要（各 ≤200 字符） |
| 422 | `PARSE_TIMEOUT` | ❌ | 单次解析超时 | 含超时值 |
| 422 | `INVALID_PARAMS` | ❌ | 空文本 / 非法 URL / 无法识别的 content-type | |
| 503 | `PARSE_BUSY` | ✅ | 解析并发达上限且排队超短等待 | 指引稍后重试 |

**SC-004 分类互斥**：`PARSE_BUSY`（唯一可重试）与其他所有码**不重叠**——调用方可程序化区分「不该重试」与「可重试」。
**向后兼容**：导入面既有码（`PARSER_UNAVAILABLE` / `UPSTREAM_BUSY` / `SLUG_COLLISION` 等）语义不变。

## 能力自描述（`GET /health` 的 `parse` 块）

```json
{
  "parser_mode": "auto",
  "parser_primary": "docling",
  "parser_preference": "docling",
  "parse": {
    "primary": "docling",
    "available_channels": ["anydoc", "docling"],
    "accepts_url": true,
    "supported_file_types": ["doc","docx","docm","ppt","pptx","pps","ppsx","pptm",
                             "xls","xlsx","xlsm","xlsb","odt","ods","odp","rtf","epub","csv","pdf"],
    "passthrough_types": ["md", "txt"],
    "concurrency": 4
  }
}
```

**SC-007 一致性**：`supported_file_types` 与实际受理判定**同源**（同一函数产出），不允许两处各自维护。

## 并发与容量语义

| 项 | 语义 |
|---|---|
| 上限 | `PARSE_CONCURRENCY`（默认 4），**独立**于 `GBRAIN_CLI_CONCURRENCY` |
| 为何独立 | 解析**不走**引擎 CLI（anydoc 进程内 native、docling 出站 HTTP）——两套资源 |
| 饱和 | 排队超短等待 → 503 `PARSE_BUSY`（不无限排队） |
| 超时 | 执行超时**不含排队时间**（沿用 `gbrain-cli.ts` 既有语义） |
| 释放 | `finally` 保证（成功/失败/超时均释放） |

## 与知识库导入路径的差异（有意）

| 输入 | 导入路径 | 裸解析路径 | 说明 |
|---|---|---|---|
| `.md` | 直通（`md` 类型） | 直通（`passthrough`） | 一致 |
| `.txt` | 送解析链 → 无法识别 → 失败 | **直通** | **有意扩展**（FR-005）：为调用方提供便利；故 SC-002 的「两路一致」仅适用于两路都能处理的输入 |
| 其余受支持类型 | 解析链 | 解析链（**同一函数**） | 一致（SC-002 覆盖范围） |

## 数据安全

- **不落盘**：multipart 文件仅内存传递（同步解析，无需暂存）
- **不记录正文**：日志仅含 `evt` / 字节数 / 类型 / 耗时 / 生效解析器——**绝不记录 markdown 内容或原始字节**
- **不泄露存在性**：凭证无效与不存在同 401
- **无写入**：调用前后 `pages` / `links` / `rag_jobs` 计数不变（SC-001）
