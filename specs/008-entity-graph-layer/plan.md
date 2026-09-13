# Implementation Plan: 实体图层与文档面隔离（008）

**Branch**: `008-entity-graph-layer` | **Date**: 2026-09-13 | **Spec**: [spec.md](spec.md) | **Research**: [research.md](research.md)

**Input**: 文档面纯净 + 双链成图 + 实体多跳。

## Summary

在既有分层上追加一个**后置建图层**，不改动引擎、不改动对外契约：

1. **文档面钉类型**：导入管线的 frontmatter 显式写 `type: note`（不再依赖 slug 路径推断）。
2. **文档面过滤**：检索传 `types`、文档列表按类型过滤（服务内部行为）。
3. **实体层生成**：导入完成后扫描该文档双链目标 → 对不存在者批量生成 `<kb>/entities/<术语>` stub 页（`import --no-embed`，零嵌入）→ 触发 `extract links` 落边。
4. **引擎开关**：建库时确保 `link_resolution.global_basename=true`。
5. **图查询面**：管理面暴露实体卡与多跳遍历（走 MCP `traverse_graph`/`entity`，规避 R12 的 CLI 打印缺陷）。

## Technical Context

**Language/Version**: TypeScript + Bun（沿用 core/server 分层）

**Primary Dependencies**: 无新增；实体层走 `packages/core/src/gbrain-cli.ts` 的 `runGbrain`（唯一引擎入口）

**Storage**: 无新表。复用 `pages`（实体页）+ `links`（边）；服务不直连引擎 DB

**Testing**: `bun run test`（全量）。新增：slug 规范化对照单测（镜像 `slugifySegment`）、双链扫描单测、TypeScript 纯函数单测；契约测试（响应形状不变，纯构造零 HTTP）

**Target Platform**: Linux 容器（现有）

**Constraints**:
- core 不得引入 HTTP 框架；引擎调用一律经 `runGbrain`
- 路由走 `createRoute` + `libHandler`；响应字段 snake_case；OpenAPI 零漂移
- **不改对外契约**：`types` 过滤、类型钉定均为服务内部行为，不给调用方新增参数

## 决策点（需用户确认）

### D1 语言策略 — 影响"图是否中英合并"

gbrain **没有**内建的中英同义收敛（research R10）。语料 `cn/` 用 `[[电池]]`、`en/` 用 `[[Battery]]` → 两个节点。

| 选项 | 结果 | 代价 |
|---|---|---|
| **A. 只导一种语言**（建议：en，与生产现状一致） | 一套干净节点，零额外机制 | 另一语言文档不在库内 |
| **B. 双语 + 桥边**（`link 电池 battery --link-type same_as`） | 图连通，多跳可跨语言 | 每对术语一条额外边；中英各一个节点（非同一节点） |
| C. 双语不桥接 | 两张互不相通的子图 | 多跳跨不了语言 |

> 建议 **A**（本期），B 作为后续。若关联项目要双语气图，选 B。

### D2 实体页生成范围

| 选项 | 数量（本语料） | 说明 |
|---|---|---|
| **A. 全部**（建议） | 413 | `--no-embed` 批量建页实测 0.7s，成本≈0；图谱最完整 |
| B. 阈值（出现在 ≥2 篇文档） | 251 | 过滤一次性术语噪声；代价是部分双链仍悬空 |
| C. 阈值（引用 ≥5 次） | 144 | 只保留高频概念 |

> 建议 **A**——实体页不嵌入、不进检索，成本几乎为零；噪声可在图查询面按入度过滤。

### D3 实体页内容

| 选项 | 说明 |
|---|---|
| **A. 最小 stub**（建议） | `title` + 一行说明；零 LLM 成本；后续可增补 |
| B. 引擎 `enrich` 填充 | 用脑内证据 LLM 生成实体描述，质量高；有模型成本与耗时 |

> 建议 **A** 起步，B 作为可选的后续阶段（引擎自带 `gbrain enrich`）。

### D4 图查询能力暴露面（已修订：原 A 方案不足）

**修订原因**（用户指出"最终使用图谱检索内容的是租户"，实测复核）：原 A 方案（HTTP 隔离 + MCP 现状不变）**不够**——① 能力只在管理面，租户**无**图谱通道（其确定性检索链走 REST，拿不到图）；② MCP 文档面**泄漏**实体页（实测 `list_pages` 混入 93 个实体页、`search` top-1 即实体页）。

**最终方案**（两者都做）：

| 层 | 措施 |
|---|---|
| 租户 REST | 新增 `GET /v1/kb/{id}/graph/traverse`（读授权 + **双重收敛**：起点 slug 属可读库 ∧ 返回路径两端均在可读库内——内部 client 是 federated 全库，不收敛会跨租户泄漏） |
| MCP | 网关改写 `tools/call` 体，对 `search`/`query`/`list_pages` 注入文档类型；图工具（`traverse_graph`/`get_links`/`get_backlinks`/`entity`）不触碰；调用方显式指定类型时不覆盖 |
| 管理面 | 保留 `/v1/admin/graph/*`（运维/调试，全库视角） |

**为何必须在网关层做**：引擎读侧无 slug 栅栏（`--bound-slug-prefixes` 仅 write-side）、无类型排除配置，`types` 是唯一可用的**包含式白名单**。

### D5 实体页回收策略（删除文档后）

实测（research R13）：删文档**不会**回收实体页，引擎只提供孤儿**检测**。三种策略：

| 选项 | 行为 | 代价 |
|---|---|---|
| **A. 建图成功后连带回收**（建议） | 文档导入/更新的建图阶段成功后，扫本库孤儿 → 回收带标记的实体页；文档删除后同跑一次 | 每次多一次孤儿扫描（一条 SQL 级）；删除请求延迟略增（可异步） |
| B. 仅定时回收 | 每天一次全库扫描 | 延迟可见（删完文档，实体页要等到次日才消失） |
| C. 不回收 | 实体页只增不减 | 垃圾页累积；不推荐 |

**无论选哪个，安全规则固定**（三重护栏，只删自己创建的）：
1. slug 在 `<kb>/entities/` 分区内
2. frontmatter 带来源标记（`auto_generated: wikilink-stub`）
3. 引擎报告该页 `--mode inbound` 无存活入边

> 引擎默认的 `islanded` 模式**不够**——它要求同时无出边，被 `enrich` 过的实体页（有出边）会漏检；回收必须用 `--mode inbound`。
>
> 另：**回收只在建图阶段成功之后执行**（FR-019）——否则"因提取失败而无入边"的实体页会被误删。

### D6 slug 结构（已由实测锁定，非选择题）

**实测 R14**：slug 就是磁盘文件路径（`${local_path}/${slug}.md`），磁盘上有真实的 git 仓库。

| 约束 | 说明 |
|---|---|
| **`kb-x/` 前缀不可去** | 是 repo 内的库命名空间目录，多库各自的 repo 隔离 |
| **`docs/` 目录名不可改** | 改了 = 同时改磁盘布局；且关联项目已按此路径存储 |
| 实体页必须放 `entities/` | 与 `docs/` 对称；不落根级（多库同名实体互撞，实测 311 条边被拒） |

> 前文曾建议"把目录名改成 `notes/` 让引擎自动推出 `note` 类型"——**该建议已作废**：改目录会破坏磁盘结构与既有存储。类型必须靠 frontmatter 显式钉定（FR-001）。

## 分阶段实施

### 阶段 0 — 前置核实（无代码）

- 核实容器内 `gbrain import --no-embed`、`extract links --source db`、`config set`、MCP `traverse_graph` 可用（research 已验，落为 smoke 任务）
- 与关联项目确认 D1 语言策略
- **运维侧**（独立跟踪，不阻塞开发）：docling 容器内存 ≥6GB 或释放节点内存（R18 / P9）

### 阶段 1 — 文档面钉类型（P1）

- `packages/core/src/ingest/pipeline.ts` `buildMarkdown()`：frontmatter 增 `type: note`（文档类型常量）
- 单测：断言产物 frontmatter 含钉定类型

### 阶段 2 — 文档面过滤（P1）

- `packages/core/src/retrieval-serve.ts`：`args` 增 `types: [DOC_TYPE]`；结果按 `topK` 截断（含 P10 修复）
- `apps/server/src/openapi/routes/tenant.ts` 列表路由：`list --type note --limit <n>`
- 单测：检索参数构造、topK 截断；契约：响应形状不变

### 阶段 3 — 实体层生成（P1）

**关键顺序**（实测 R15）：建图**不需要显式提取**——`put` 的 auto_link 后钩子会自动建边。因此必须**先建实体页，再 put 文档**，一次到位。

```
解析 markdown（本地，不查库）
  → 扫双链目标 → 建缺失实体页（import --no-embed）
  → buildMarkdown（含 type 钉定）
  → put 文档 ⇒ auto_link 自动建边 ✓
  → （兜底）extract links（幂等）
  → 回收孤儿实体页
```

- 新增 `packages/core/src/entity-graph.ts`：
  - `slugifyEntityName()`：镜像引擎 `slugifySegment`（R9）
  - `extractWikilinkTargets(md)`：镜像引擎 `WIKILINK_GENERIC_RE` 语义（剥离 `|别名`、`#锚点`、跳过代码块）
  - `ensureEntityPages(cfg, kbId, targets)`：`get` 探存在性 → 差集 → 落临时目录 `<tmp>/<kb>/entities/<slug>.md`（frontmatter `title` + `type: concept` + **来源标记 `auto_generated: wikilink-stub`**）→ `runGbrain(["import", dir, "--no-embed"])` → 返回已建 slug
  - `runLinkExtraction(cfg, kbId)`：`extract links --source db --json`（幂等兜底）
  - `reconcileEntityStubs(cfg, kbId)`：`orphans --mode inbound --source <kb> --json` → 与"带标记的 `entities/` 页"求交 → 软删（R13 三重护栏）
- `pipeline.ts` 编排：**解析双链 → 建实体页 → put → 提取 → 回收**（回收仅前四步成功后执行，FR-019）；失败仅告警，不阻断文档导入成功
- 文档删除路径（`delete` 路由）在软删成功后异步触发同一回收函数（FR-018）
- 引擎配置：建库路径确保 `link_resolution.global_basename=true`（幂等 set）
- **实体页定位**（R17）：纯派生数据，走 `import`（快、零嵌入、不落盘）。**不纳入备份**，恢复靠重导文档；服务文档需明确此语义
- 单测：slug 规范化对照（CJK/空格/大小写/重音/下划线）、双链扫描（含 `|`、`#`、嵌套、代码块）、目标去重、已存在页优先、**回收护栏**（无标记页不删 / 共享页不删 / 有存活入边不删）

### 阶段 4 — 图查询面（P2）

- `deploy/clis/gbrain.yaml`：新增 `traverse-graph`、`entity` 两个管理面代理路由
- 管理面路由：实体卡 + 多跳查询（走 MCP，参数 `slug`/`depth`/`direction`/`link_type`）
- 契约测试：路由注册与响应形状

### 阶段 5 — 验证（本地端到端）

- 重建本地库 → 导入 13 篇（带双链语料）→ 断言 SC-001（边数 == 997 量级）
- 断言 SC-002/SC-003（文档面纯净）、SC-004（幂等）
- 断言 SC-005（depth=2 多跳非空）
- 断言 SC-007/SC-008/SC-009（回收）：删独占引用文档 → 实体页回收；删共享引用文档 → 实体页保留；孤儿用户页不被删

### 阶段 6 — 部署与数据迁移（生产）

- 构建新镜像 → 生产滚动更新
- 确保引擎 `global_basename` 已开
- 按 D1 策略重建库 → 重放文档 → 观察自动建图
- 关联项目 5 项验收复测（SC-006）

### 阶段 7 — 收尾

- 文档同步：`docs/usage.md`（图谱能力与隔离说明）、`docs/deployment.md`（实体层与引擎开关）、README 中英同构
- 缺陷台账 `docs/testing-strategy.md` §4：登记 P10（top_k，本期修）；N4 与 P9 单列
- 独立运维项（非本特性代码）：docling 容器内存（建议 ≥6GB，或停闲置服务释放节点内存）

## 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 实体页数量随语料增长 | 建图耗时与页数膨胀 | `--no-embed` + 增量（只处理新目标）；D2 阈值可切换 |
| basename 歧义（同库同名两页） | 产生多条边 | 建页前去重 + 已存在页优先（FR-006）；建图后核对边数 == 期望值 |
| `global_basename` 全局开启影响既有 KB | 既有裸双链新增解析 | 方向是"更多边"，且跨库隔离不变（R4）；上线前在生产快照核对 |
| 嵌入端点不稳定 | 文档导入失败 | 实体页 `--no-embed` 绕开；文档导入沿用既有重试；图边不依赖嵌入（R11） |
| 图查询面误暴露实体页 | 文档面污染回流 | 文档面过滤走类型（前端/HTTP），MCP 面按 D4 决策 |
| **回收误删共享实体页** | 其他文档的图断裂 | 三重护栏（分区 + 来源标记 + `--mode inbound` 零存活入边）；建图失败批次不回收（FR-019） |
| **回收误删用户自建页** | 数据丢失 | 来源标记是硬门槛；单测构造反例（孤儿用户页不被删，SC-009） |
| 软删不级联 → 边行残留 | `links` 表膨胀 | 图视图已过滤（R13），不影响正确性；数据卫生问题，可随页级 purge 一并解决 |
| **实体页不落盘**（`import` 路径） | 不在备份链路；DB 重建后需重导恢复 | 定位为派生数据（R17）；恢复流程 = 重导文档；文档明示 |
| **dream `sync` 阶段删页** | 极端情况下页被软删 | `sync` 由 **git 变更**驱动（R17）——`import` 建的实体页从未入 git，不在删除列表；`MASS_RECONCILE_RATIO` 另有保护 |
| **dream `extract` 自动建边** | 与服务的即时提取重复 | 幂等（边有唯一约束）；两者同源同逻辑，实测第二次跑 `links_created: 0` |
