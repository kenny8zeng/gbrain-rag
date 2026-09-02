# Research: 005-parser-priority-fallback

Phase 0 输出。无 NEEDS CLARIFICATION（spec Assumptions 已立规）；决策基于 004 代码现状。

## D1: 配置模型

- **Decision**: 保留 `PARSER_MODE`（auto|docling|anydoc，强制单解析器供测试/排障）；新增 `PARSER_PREFERENCE=docling|anydoc`（默认 docling，仅 auto + DOCLING_URL 配置时生效）。
- **Rationale**: 三 env 正交无歧义：DOCLING_URL=开关；PARSER_PREFERENCE=并存时优先级；PARSER_MODE=强制模式覆盖。004 既有 env 语义不破坏（PARSER_MODE=docling 强制单解析器=不回退，测试隔离语义保留）。
- **Alternatives**: 扩 PARSER_MODE 枚举（docling-fallback 等）——破坏 004 契约语义；布尔 PARSER_ANYDOC_FIRST——表达力弱于枚举。

## D2: 解析链（resolveChain）

- **Decision**: `resolveParserFor` 返回从"单解析器"升级为"链"：`{ mode, primary: FileParser, fallback: FileParser | null, url: UrlParser | null }`。矩阵：
  | DOCLING_URL | PARSER_PREFERENCE | primary | fallback | url |
  |---|---|---|---|---|
  | 空 | — | anydoc | null | null（422 指引） |
  | 配置 | docling（默认） | docling | anydoc | docling |
  | 配置 | anydoc | anydoc | docling | docling |
  | — | PARSER_MODE=docling（强制） | docling | null | docling |
  | — | PARSER_MODE=anydoc（强制） | anydoc | null | null |
- **Rationale**: url 无 fallback（anydoc 无此能力——FR-004）；强制模式无 fallback（不回退——FR-007 排障语义）；回退仅一次天然由链结构保证。
- **Alternatives**: 回退逻辑散在 pipeline（职责外溢）；多级链抽象（两解析器够，YAGNI）。

## D3: 转换与回退链记录

- **Decision**: pipeline 文件转换走 `convertWithFallback(chain, bytes, filename)`：try primary → catch（记录原错误）→ fallback 存在则试 → 成功返回 `{md, used: primary|fallback, fallbackFrom?: string}`；结果写新列 `rag_jobs.parser_log`（migration 0002）：成功无回退 = `"docling"`；回退成功 = `"docling→anydoc: <原错误摘要>"`；失败 = 最终错误（含链）照旧入 error。
- **Rationale**: FR-003 可观测；parser_log 与 error 分离（成功任务的转换路径记录不被错误语义污染）。
- **Alternatives**: 塞 error 字段（成功任务语义污染）；仅日志（任务记录要求，FR-003 明言任务记录）。

## D4: URL/图片路径

- **Decision**: url 分支直接用 chain.url（docling 或 null）；docling 失败**不触发**向 anydoc 回退（FR-004），任务失败由既有重试机制兜底（attempts 3）；图片同 url（docling 独有能力）。
- **Rationale**: 能力边界（spec Out of Scope）与回退语义一致。
- **Alternatives**: 图片在 anydoc 优先模式下尝试 anydoc（anydoc 不支持独立图片——不可行）。

## D5: 测试矩阵（测试方案更新落点）

- **Decision**: 四实例矩阵（docs/testing-strategy 更新）：
  | 实例 | 配置 | 覆盖 |
  |---|---|---|
  | 3000（主回归） | docling 可用 + pref=docling | 全量 101 项 + parser_log=docling 断言 |
  | 3101 | DOCLING_URL 空（anydoc 唯一） | us5（004 现状回归） |
  | 3102 | docling 可用 + pref=anydoc | anydoc 优先：docx parser_log=anydoc、url 仍 docling |
  | 3103 | docling 指向不可达 + pref=docling | **回退触发**：docx 回退成功 parser_log 含 "→anydoc" |
- 单测（deterministic 优先）：`convertWithFallback` 注入抛错 primary → fallback 成功/双失败链记录——回退核心不依赖实例时序。
- **Rationale**: 回退触发（docling 不可达）在集成层需故障注入实例（3103）；单测先覆盖确定性语义，集成证端到端。
- **Alternatives**: 仅单测（无端到端证据）；mock docling 于集成（复杂于故障实例）。

## D6: 健康检查

- **Decision**: `/health` 增加 `parser_primary`（当前首选：docling|anydoc）与 `parser_preference`（配置值）；`parser_mode` 语义保持"docling 配置态"（004 契约不破坏——us5 断言 parser_mode=anydoc 仅在任何doc唯一实例 3101 成立 ✓）。三字段组合如实表达 FR-006。
- **Alternatives**: 复用 parser_mode 改语义（破坏 004 us5 断言）。

## D7: 迁移

- **Decision**: `deploy/migrations/0002-parser-log.sql`：`ALTER TABLE rag_jobs ADD COLUMN parser_log TEXT;`（worker 更新处同步）。
- **Rationale**: 任务记录列最小变更；rag_jobs 生命周期（retention 清理）无需改动。
