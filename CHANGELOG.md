# 变更日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
