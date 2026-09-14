# 变更日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **知识图谱（008）**：文档正文的 `[[概念]]` 在导入时自动建图——为缺失目标创建实体页（`<kb>/entities/<规范名>`，类型 `concept` + 来源标记），并由引擎写入关系边；删除文档后自动回收「不再被任何存活文档引用」的自动创建实体页（共享节点保留、用户自建页永不回收）
- 租户面图谱检索：`GET /v1/kb/{id}/graph/traverse`（受读授权管控，返回关系路径含 `context` 原文出处；起点与返回路径均收敛到该 key 可读的库内）
- 管理面图谱接口：`GET /v1/admin/graph/entity`（实体卡）、`GET /v1/admin/graph/traverse`
- **图谱增强检索（一次调用两条通道）**：`POST /v1/kb/{id}/retrieval` 新增可选 `graph` 参数（`depth`/`seed_k`/`max_results`）——向量找入口，图谱补「同概念但语义不同」的相邻文档，响应新增 `graph_results`（含 `via_concepts` 溯源与特异性 `weight`）；不传 `graph` 时行为与历史完全一致
- 容量旋钮：`GBRAIN_CLI_CONCURRENCY`（引擎 CLI 全局并发上限）、`GBRAIN_CLI_QUEUE_WAIT_MS`（排队上限）、`GRAPH_SETTLE_MS`（建图收尾去抖）
- 错误码 `UPSTREAM_BUSY`（503）：引擎容量饱和时的可重试响应
- 梦境周期调度：`DREAM_ENABLED`/`DREAM_CRON`/`DREAM_TIER` 环境变量（默认关），服务内定时触发引擎维护周期；轻量档自动提取页面关系建图（零 LLM）
- 管理面 `POST/GET /v1/admin/dream`：手工触发（异步 202）与状态查询；运行中再次触发返回 `409 DREAM_RUNNING`（不叠跑，超时自愈）
- 文档同步：usage 图谱/组合检索/错误码/租户路由表、deployment 容量参数与图谱数据说明、README 中英特性、新特性 `specs/008-entity-graph-layer`

### Changed

- **页面 slug 生成改为抗撞车**（超长文件名修复）：上限从「64 字符硬截断」改为「**200 UTF-8 字节预算**」；超出时截断并附完整文件名的 8 位哈希。旧实现会让「前缀相同、仅尾部不同」的长文件名映射到同一 slug → **后者静默覆盖前者（文档丢失，实测可复现）**；按字节（而非字符）计量则避免 CJK 名撞文件系统 255 字节上限。⚠️ 受影响页面（此前被截断的）重新导入后 slug 会变为完整名，旧页成为残留——迁移步骤见 `docs/usage.md` 页面命名小节

- 导入文档**显式钉定类型** `note`（此前依赖引擎按 slug 路径推断，落默认 `concept` → 文档面无法按类型过滤；存量数据需重导以生效）
- 建库时自动开启引擎 `link_resolution.global_basename`（实体页位于子目录，缺此开关裸双链解析为 0 边）
- MCP 文档面读工具（`search`/`query`/`list_pages`）注入文档类型过滤——实体页不再泄漏进租户的文档视图；图工具不受影响；调用方显式指定类型时不覆盖
- 检索与文档列表在类型过滤之外再加 `<kb>/docs/` 前缀兜底（结构保证，不依赖类型正确性）
- 梦境周期环境变量以 `DREAM_CRON`（5 段表达式）取代早期 `DREAM_INTERVAL_HOURS`

### Fixed

- **并发批量导入压垮引擎 CLI（D28）**：`gbrain ... exited with 143`（超时被 SIGTERM）→ 提交接口未捕获抛 500。修：全局 CLI 并发闸门 + `snapshot()` fail-open 用陈旧缓存 + 建图收尾去抖 + CLI 错误映射 503
- MCP 文档面泄漏实体页（D27）：实测 `list_pages` 混入 93 个实体页、`search` top-1 即实体页
- 图谱端点省略 `direction` 静默返回空数组（D29）：引擎 `traverse_graph` 的返回形状随 `direction` 变化（不传=节点树），端点契约是边列表 → 补默认 `both`
- 租户无图谱检索通道（D26）：能力此前只在管理面
- 检索 `top_k` 不严格（P10）：`top_k` 未映射到内部字段导致截断静默失效（请求 2 实返 5）
- 无实例时集成测试门控失效（D25）：`health!` 非空断言 → Unhandled error，全量测试退出码 1

### 新增

- 核心服务：以 GBrain 为知识库核心的统一入口——知识库（source）生命周期、Agent 凭证（OAuth client 硬隔离：写分区唯一 + federated-read 读授权组合）、异步文档摄取、REST 检索、MCP 网关、引擎运维代理（cli2api spec 驱动 55 路由，SSE + `format=json`）。
- 文档解析双实现：外部 docling 服务（URL/图片/复杂版面/OCR）与内置 anydoc（进程内 native，Office/PDF 毫秒级）；`DOCLING_URL` 配置时双解析器并存，`PARSER_PREFERENCE` 控制首选，转换失败自动回退（仅一次，任务记录 `parser_log` 回退链）；未配置时 anydoc 唯一并明确拒绝 URL/图片（422 指引）。
- 摄取管道：文件（含图片）/网页 URL/Markdown 三通道；SKIP LOCKED worker（并发可配）；重试 3 次；重复导入 upsert（`outcome: created|updated`）。
- OpenAPI/Swagger UI：路由定义即文档源（零漂移 CI 闸门）、自托管交互页（零外部依赖）、引擎代理 55 路由第三分组。
- CORS：`CORS_ORIGINS` 可选来源列表（空=关闭，`*` 显式全放行，预检免鉴权）。
- 检索性能：REST 检索经常驻 gbrain serve 通道（内部只读 client + per-KB source 钉定），10 并发 P95 2.6s → 90ms；故障自动降级 CLI 路径。

### 修复

- 代理并发闸门泄漏（D14）：cli2api runCli 异常/断开路径不触发完成回调 → 自愈闸门（60s 残留清空）+ SSE cancel 即释放 + 闸门与内部 semaphore 解耦。
- 归档语义（D11/D12/D13）：只读引用不阻塞归档；purge 全引用预检 + force 联动吊销；内部 client 启动累积泄漏清理。
- 嵌套 slug 删除路由、列表接口 tab 文本解析、归档态 410 判定、multipart schema 运行时校验、slug 时间戳前缀污染（D2-D7 系列）。
- worker 饿死（docling 同步 504 阻塞队列）：转换超时下限 110s + worker 并发化。

### 安全

- URL 导入不做地址校验（FR-013，受信部署环境专用，部署文档显著标注）。
- 托管 OCR/外部解析默认关闭；管理面单 token、租户面分区 key（哈希存储）。
