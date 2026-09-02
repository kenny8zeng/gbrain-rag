# Research: 004-anydoc-default-parser

Phase 0 输出。关键未知项（npm 集成/运行时）经**本地实机验证**，非推断。

## D1: anydoc npm 集成（实测）

- **Decision**: `@firecrawl/anydoc` 作为 root 依赖加入（Bun 1.3 实测可用：`bun add` 后 NAPI 加载成功，无编译）。
- **Rationale**: 实测转换最小 docx（中文文本 + 表格）：`toMarkdownBytes(bytes, fmt)` 输出完整 GFM（表格管道化正确）；热调用 20 次中位 0.03ms。格式嗅探 `formatFromBytes` 工作正常。官方预编译 .node 面向 glibc——运行层为 debian:bookworm-slim（glibc 2.36），构建期验证加载即可。
- **Alternatives**: CLI 子进程（`npx @firecrawl/anydoc`）——每次 ~27ms 启动开销 + node 依赖，弃（评估数据）；WASM 版（性能次，弃）。

## D2: 解析器抽象与选择

- **Decision**: `packages/core/src/ingest/parser.ts` 定义解析器接口；`DOCLING_URL` 非空 → doclingParser（现状，file+url+image 全支持）；为空 → anydocParser（**仅 file 文档类**）。
- **Rationale**: 三态输入中 url/image 是 docling 独有能力（FR-004 明确拒绝）；file 在 anydoc 模式下毫秒级本地处理。选择在进程启动时解析一次（配置不变）。
- **Alternatives**: 双解析器并行路由（复杂无必要）；按扩展名细分（anydoc 嗅探已覆盖）。

## D3: 错误分类映射

- **Decision**: anydoc 错误 `code`（unsupported/needsOcr/malformed/encrypted/resourceLimit/missingPart/io/hosted）→ 任务失败文案；租户侧拒绝用 `422 {code: "PARSER_UNAVAILABLE"}`（url/image 于 anydoc 模式）。
- **Rationale**: 复用既有 rag_jobs.error 通道（FR-006）；映射表集中一处便于随解析器升级调整。
- **Alternatives**: 透传英文 code（可读性差，弃）。

## D4: OCR 可选升级

- **Decision**: env `FIRECRAWL_API_KEY`（或 `ANYDOC_OCR=hosted` 显式开启）配置时，`needsOcr` 错误自动以 `{ocr:'hosted', apiKey}` 重试一次；未配置 → failed 带"扫描 PDF 需 OCR"指引（FR-005）。数据出机器原则与 FR-013 姿态一致。
- **Alternatives**: 默认开启 hosted（违反内网姿态，弃）。

## D5: 健康检查语义

- **Decision**: `/health` 增加 `parser_mode: "docling" | "anydoc"` 字段（向后兼容）；`docling` 布尔保持（未配置=false）。FR-007 由 parser_mode 如实表达，docling=false 不再歧义为故障。
- **Alternatives**: docling 改三态字符串（破坏既有契约测试形状，弃）。

## D6: 测试样本

- **Decision**: 集成测试用构造 fixture（docx：zip+xml 手造，含中文与表格——本 Phase 已验证可转）；扫描 PDF/OCR 路径以单元测试 mock 错误码覆盖（真实扫描样本不可得，不阻塞）。
- **Rationale**: fixture 可控、可入库；needsOcr 分支是纯错误分类逻辑，mock 足够。
- **Alternatives**: 依赖外部样本（不稳定，弃）。
