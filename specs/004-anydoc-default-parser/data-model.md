# Data Model: 004-anydoc-default-parser

无新增持久化实体。核心是**解析器运行时选择**与**错误分类映射**两个纯配置/代码事实。

## 1. 解析器（运行时单例）

| 属性 | doclingParser | anydocParser |
|---|---|---|
| 类型 | HTTP 服务（外部） | 进程内 native（库） |
| 支持通道 | file（含图片）/ url | file（文档类） |
| 激活条件 | `DOCLING_URL` 非空 | `DOCLING_URL` 为空 |
| 超时 | min(JOB_TIMEOUT_MS, 110s) | N/A（本地同步，受 worker 心跳约束） |
| 失败出口 | HTTP 状态 + 响应体 | `error.code` 分类 |

选择逻辑：`resolveParser(cfg): Parser`——启动/首次调用解析，配置为空切换。

## 2. 错误分类映射（anydoc code → 任务失败原因）

| code | 失败原因（中文） | 处置 |
|---|---|---|
| needsOcr | 扫描型 PDF，本地无 OCR | OCR 已配置 → hosted 重试一次；否则 failed 带指引 |
| unsupported | 不支持的格式 | failed |
| malformed | 文件损坏或结构非法 | failed |
| encrypted | 文件已加密，需先解密 | failed |
| resourceLimit | 超出资源限制（超大/复杂） | failed |
| missingPart | 文档缺少必需部件 | failed |
| io | 文件读取错误 | failed（重试机制兜底） |
| hosted | 托管 OCR 服务失败 | failed 带原因 |

## 3. 租户侧错误码（HTTP）

| code | HTTP | 场景 |
|---|---|---|
| PARSER_UNAVAILABLE | 422 | anydoc 模式提交 url / 独立图片 |

## 4. 健康字段

`/health` 增加 `parser_mode`（docling|anydoc）；`docling` 布尔语义不变。
