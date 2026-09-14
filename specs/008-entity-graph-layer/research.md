# Research: 实体图层与文档面隔离（008）

本文记录方案所依赖的**实测发现**与源码依据（gbrain v0.47.6.0）。每条都有可复现的验证方式。

## R1 双链建边的唯一前提是"目标页存在"，与类型无关

- 源码 `src/commands/extract.ts` `resolveCandidateSources()`：`if (!allSlugs.has(c.targetSlug)) return { ok:false, reason:'missing_target' }`——只查 slug 集合，不查类型。
- `src/core/postgres-engine.ts:1093 getAllSlugs()`：`SELECT slug FROM pages WHERE source_id = ...`——纯 slug 集合。
- **实测**：13 篇文档（含 2439 处双链）导入后 → `{"links_created":0,"skipped_missing_target":343}`。
- **实测**：补齐 413 个实体页后再跑 → `{"links_created":1000}`；按 `kb-*` 过滤后出边 **997**，覆盖 **412** 个实体节点，未被引用的实体页 **0 个**。
- **独立核算**：脚本按引擎正则重算 uniq `(文档, 目标)` 对 = **997** → 与实际边数完全相等（提取率 100%）。
- **类型无关的证据**：上述 413 个实体页当时类型为 `concept`，边照样成立。

→ 结论：**不需要 `entity` 类型**，也不需要 `by-mention`。

## R2 `LINKABLE_ENTITY_TYPES` 只服务 `by-mention`（本方案不用）

- `src/core/by-mention.ts:38` `LINKABLE_ENTITY_TYPES = ['person','company','organization','entity']`；唯一消费点 `by-mention.ts:377` 的 gazetteer 查询 `WHERE type IN (...)`。
- `extract.ts` / `link-extraction.ts` 中**没有任何**该白名单引用。
- **实测**：把实体页改 `type: entity` 并让正文互提后跑 `extract links --by-mention --ner` → 42 条 `link_source=mentions`（其中 entity→entity 11 条）。证明该通路可用，但**依赖正文提及 + 特定类型**，与本项目"显式双链"语料不匹配。

→ 结论：本期不启用；`by-mention` 作为后续增强项。

## R3 实体页放子目录时，必须开启 `link_resolution.global_basename`

- 裸双链 `[[电池]]` 的解析分支（`src/core/link-extraction.ts:665-717`）：
  - 根级 exact 候选 `bareDirect = slugifyPath(ref.slug)` —— 只匹配根级 slug
  - basename 后缀匹配 `resolveBasenameMatches(ref.slug)` —— **仅当 `opts.globalBasename` 为真**（`isGlobalBasenameEnabled`，默认 **false**）
- **实测对照**（实体页置于 `kb-x/entities/<术语>`）：

| 引擎配置 | 结果 |
|---|---|
| `global_basename` 关（默认） | `links_created: 0` |
| `global_basename` 开 | `links_created: 6`，且边明细为 `docs/testdoc → entities/官网[wikilink_basename]` 等 |

- **实测反例**：改用根级 slug（`电池` 直接放根）时无需开关也能建边——但多库下同名实体互撞：实测 **311 条**边被 `cross_source` 拒绝（`resolveCandidateSources` 的隔离分支）。

→ 结论：**子目录 + 开启开关**是多租户下的唯一正确组合。

## R4 `global_basename` 是引擎级全局配置，跨库隔离仍由 source 保证

- `gbrain config set link_resolution.global_basename true` 写入引擎配置（非 per-source）。
- 隔离由 `resolveCandidateSources` 的 `allowCrossSource`/`crossSource` 分支保证，与 basename 解析正交。
- **实测**：开启后跨库同名实体的边仍被拒（`skipped_cross_source: 311`）。

→ 结论：全局开启安全，不破坏多租户。

## R5 类型来自"frontmatter 显式声明 > slug 路径推断 > 默认 `concept`"

- 源码 `src/core/markdown.ts:290`：`const type = explicitType || (pack ? inferTypeFromPack(filePath, pack) : inferType(filePath))`
- `src/core/import-file.ts:341`：`put`/`import` 把 **slug 当路径**参与推断 → `parseMarkdown(content, slug + '.md', ...)`
- `inferTypeFromPack`：遍历 pack `page_types[].path_prefixes`，**首个匹配胜出**；无匹配 → **`concept`**
- **实测**：`<kb>/notes/b2` → `note`（`notes/` 在 pack 中声明）；`<kb>/docs/a1` → `concept`（`docs/` 未声明）；裸 slug → `concept`
- **生产实证**：13 篇文档全部 `concept`，正是"`docs/` 未注册 → 落默认值"

→ 结论：必须在 frontmatter 显式写 `type`，不能依赖推断。

## R6 类型是开放字符串，但未声明类型不是一等公民

- **实测**：`type: whatever-i-want` 与中文 `type: 产品文档` 均成功入库、可被 `types` 过滤命中；`schema stats` 计入 typed。
- **实测**：拼错类型 `entty` 不报错，**静默返回 0 条**。
- pack `gbrain-base-v2.yaml:601` 的 catch-all 规则：`from_type: "*unknown*" → to_type: note`（原类型存入 `frontmatter.legacy_type`），由受保护 Minion handler `unify-types` 在 pack 迁移时执行。
- `src/core/schema-pack/expand-type-filter.ts` 注释澄清：`aliases` 只驱动**查询展开**，不做写入归一化。

→ 结论：用内置 `note`（文档）/ `concept`（实体）；**不引入自定义类型**——避免被 catch-all 收敛、避免维护自定义 pack。

### R6.1 "会被收敛"的精确边界：只针对**未声明的类型名**，与目录无关

**这是最容易被误读的一点**，逐条核实：

| 机制 | 触发 | 作用范围（源码精确谓词） | 能否影响 `docs/` 的页 |
|---|---|---|---|
| **catch-all 收敛** | `unify-types` handler（**manual_only**，人工在 `gbrain onboard` 时确认） | `unknownTypes = distinct type WHERE NOT declaredTypes.has(t) && NOT explicitTargets.has(t) && NOT pageToLink/AliasTargets.has(t)`（`unify-types-handler.ts:191-216`） | ❌ **不能**——页的类型是 `note`/`concept`，二者**都在声明表内** |
| **前缀指派**（`schema sync --apply`） | **手动** CLI / 迁移流程内部步骤 | `UPDATE pages SET type=$1 WHERE (type IS NULL OR type = '') AND source_path LIKE $2`（`sync.ts:123-132`） | ❌ **不能**——谓词**只填空类型**，不覆盖已有类型 |
| **写时推断** | 每次 put/import | `explicitType \|\| inferTypeFromPack(path)`（`markdown.ts:290`） | ⚠️ **只有此处涉及目录**，且 frontmatter 显式 `type` **优先级最高**，可完全覆盖推断 |

**实测验证两种结果并存于同一目录**（同一 `docs/` 文件夹）：
| 文件 | frontmatter | 落库 type |
|---|---|---|
| `docs/explicit-note.md` | `type: note` | **`note`** |
| `docs/no-type.md` | （无） | `concept`（落默认值） |

**类型声明表核实**（`gbrain-base-v2.yaml`）：
```
note      declared=True    ← 本方案选它（文档）
concept   declared=True    ← 本方案选它（实体）
document  declared=False   ← 自编名，会被 catch-all 收敛（故不用）
entity    declared=False   ← 同上
```

**结论（重要）**：
1. **目录（`docs`）永远不会"失效"**——它是 slug 路径，不是类型；三种机制中没有任何一种会因目录名而改写一个已有类型的页。
2. **"会被收敛"只针对自编的类型名**（`document`/`entity`），且仅在**人工执行** pack 迁移时发生；`note`/`concept` 因已声明而免疫。
3. **唯一涉及目录的环节是"写时推断"**，而 frontmatter 显式 `type` 优先级最高——这正是 FR-001 要写死显式类型的原因：**写定之后，目录名与时序都不再影响类型**。
4. 由此反推：改目录名（`docs/` → `notes/`）**在类型上是多余且有害的**——它对类型没有额外保护作用，却会破坏磁盘路径（R14）。**已作废该建议。**

## R7 `types` 过滤是一等参数且实测有效

- MCP `query` 参数含 `types`；`list_pages`/`list` 含 `type`；引擎 `list [--type T]`。
- **实测**（同库 13 文档 + 413 实体页 + 混入实体）：

| 调用 | 结果 |
|---|---|
| `query("电池")` 无过滤 | top-3 全为实体页（`entity\|电池`/`续航`/`充电器`） |
| `query("电池", types:["note"])` | n=8，**全部为文档页**，实体 0 条 |
| `query("电池", types:["entity"])` | n=3，仅实体页 |

→ 结论：文档面隔离靠 `types` 过滤即可，无需引擎改造。

## R8 分区隔离现状：`/page` 已天然阻断，`/documents` 与检索未阻断

- `GET /v1/kb/:id/page` 已有前缀校验：`if (!slug.startsWith(`${kbId}/docs/`)) → 422` → 实体页**天然不可读**，无需改动。
- `GET /v1/kb/:id/documents`：`runGbrain(["list","--limit","200"])` —— **无过滤**，且 200 条上限可能被实体页挤占。
- `/v1/kb/:id/retrieval` → `retrieval-serve.ts`：`args = { query, source_id, limit }` —— **无 types**。

→ 结论：需改两处，均为服务内部行为，**不改动对外契约**。

### R8.1 读侧**没有** slug 前缀栅栏——类型过滤是唯一可用机制

核实 `--bound-slug-prefixes` 的作用面：

- 引擎注释明确：**"write-side isolation symmetry"**——`enforceClientSlugFence` 作用于 put_page / delete_page / restore_page / add_tag / add_link / add_timeline_entry / revert_version / put_raw_data 等**所有 slug 变更型写入**（`src/core/ops/context.ts:189-225`）。
- **读侧无对应机制**：`query` 的参数表无 slug 前缀项；`list_pages` 亦无；`--federated-read`/`--source` 只到 source（库）粒度。
- 服务侧 `credentials.ts` 也只在 `writeKb` 存在时装配该栅栏。

**推论与实现选择**：

| 层 | 机制 | 作用 |
|---|---|---|
| 上游（引擎） | `types: [note]` | 排除实体页，**保住 top-K 召回**（不让 413 个实体页挤占文档位次） |
| 服务侧（我们代码） | 结果 `slug.startsWith(kbId + "/docs/")` **后缀过滤** | **结构性兜底**——不依赖类型正确性，即使类型漂移也不会漏进实体页 |

**两层都上**：类型过滤负责召回质量，前缀过滤负责正确性兜底（成本为零）。

**MCP 面的过滤已补**（2026-09-13，用户指出租户才是消费者后复核发现泄漏）：引擎读侧确无 slug 栅栏、无类型排除配置，`types` 是唯一杠杆 → 网关改写 `tools/call` 体注入文档类型（`search`/`query` 用 `types`、`list_pages` 用 `type`）。生产实测修复前后对比：

| 工具 | 修复前 | 修复后 |
|---|---|---|
| `list_pages` | 8 文档 + **93 实体页** | 8 文档 + **0 实体页** |
| `search`（"battery"） | top-1 = `entities/battery` | 6 条全为文档 |
| `traverse_graph` | 537 路径 | 537 路径（未受影响） |
| 显式 `types:["concept"]` | — | 生效（不过滤，逃生阀保留） |

**已知残留缺口**（记录，不扩大范围）：租户若**直连 MCP 调 `put_page`**（网关仅过滤文档面**读**工具），可绕过服务管线——写入的页拿不到钉定类型。此时：
- 若写入 `docs/` 且无显式 type → 落 `concept` → **被类型过滤挡在文档面之外**（静默不可见）
- 该路径在关联项目的设计内已被约束（其 v3.2 §D：Agent 仅注册读工具；并计划实测只读 key 调写工具是否引擎级 403）
- 若将来要加强：在 MCP 网关拦截 `tools/call` 的 `put_page` 并补钉类型（有解析成本，非本期）

## R9 实体 slug 规范化必须镜像引擎算法

- `src/core/sync.ts:627 slugifySegment()`：NFD → 去 `\u0300-\u036f` → 去 `\u0591-\u05c7` → NFC → lowercase → 去 `SLUGIFY_KEEP_RE`（保留 `\p{Ll}\p{Lm}\p{Lo}\p{M}\p{N}`、`.`、空白、`_`、`-`）→ 空白转 `-` → 折叠 `-` → 去首尾 `-`
- `SLUG_WORD_CHARS = '\p{Ll}\p{Lm}\p{Lo}\p{M}\p{N}'`，其中 `\p{Lo}` 含 CJK
- 解析侧 `buildBasenameIndex` 为每页尾段建三个键：`tail`、`tail.toLowerCase()`、`normalizeBasename(tail)`
- **实测**：`[[Soleil01 SE]]` → `soleil01-se` 命中；`[[电池]]`、`[[官网]]` 原样命中

→ 结论：服务侧实现必须**逐字符等价**并加对照单测（含 CJK、空格、大小写、重音、下划线）。

## R10 中英双语**没有**内建收敛机制（关联项目需知）

- `slug_aliases` 的唯一写入点是 pack 的 `page_to_alias` handler；其注释明确 "the alias_table IS the resolver"——但实测**该表不参与图边提取**：`extract.ts` / `link-extraction.ts` 中无 `resolveSlugWithAlias` 调用，`getAllSlugs` 只读 `pages`。
- 搜索侧 `src/core/search/hybrid.ts:645` 用 `slug_aliases` 做 `alias_resolved_boost`——**只影响排序**。
- 语料事实：`cn/` 写 `[[电池]]`、`en/` 写 `[[Battery]]` → basename 不同 → 落到**两个不同节点**，即使语料 README 声称"收敛为同一图谱节点"。
- 可选桥接：`gbrain link 电池 battery --link-type same_as`（图连通，零 pack 配置）；或统一节点语言。

→ 结论：本期需向关联项目明确此限制，并选定语言策略（plan 决策 D1）。

## R11 实体页可零嵌入批量生成

- `gbrain import <dir> [--no-embed]` 支持批量建页；**实测**：413 页 0.7s 完成（`imported=413, errors=0`），默认 `type` 由路径推断。
- 路径即 slug：把文件放 `<tmp>/<kb>/entities/<name>.md` 后 `import <tmp>` → slug `<kb>/entities/<name>`（同机制已在 425 页实验中验证）。
- 图边建立**不依赖 embedding**（`allSlugs` 只读 `pages`）→ 实体页跳过嵌入不影响建图。
- 嵌入是当前唯一不稳定的外部依赖（实测多次 `Cannot connect to API`）。

→ 结论：实体页一律 `--no-embed`，省成本、去失败面。

## R12 引擎 CLI 的已知缺陷（服务侧规避）

- `gbrain graph-query --direction both` 的树打印器按 `from_slug` 归组（`printTree`），**入边不渲染**：实测 `--depth 2 --direction both` 只打印根节点，而同一参数在 SQL 层返回 973 条路径。
- `--direction in` 正常。MCP `traverse_graph` 返回原始 `GraphPath[]`，**不受影响**。

→ 结论：图查询面走 MCP `traverse_graph` / `entity`，不用 CLI 的 `graph-query` 打印器。

## R13 删除文档**不会**回收实体页；引擎只提供"检测"，不提供"回收"

**实测场景**：建库 → 导入 1 篇文档（`[[电池]]`/`[[续航]]`/`[[充电器]]`）+ 3 个实体页 → `extract links` 建 3 条边 → 经服务 API 删除该文档 → 逐项检查。

| 检查项 | 实测结果 |
|---|---|
| 文档页 | `deleted_at=2026-09-13 00:31:52...`（**软删**，非硬删） |
| 3 个实体页 | `deleted_at=NULL` —— **全部存活，无任何自动回收** |
| `links` 表中的边 | **仍有 3 条**（软删不触发外键级联） |
| `backlinks(实体)` | `[]` —— **图视图已正确隐藏**（删掉的文档不再出现） |
| `gbrain orphans` | 3 个实体页**被正确识别为孤儿**（`12 orphans out of 12 linkable pages`） |

**机制依据**：
- `gbrain delete` 的帮助文本明确："Soft-delete a page... recoverable via `restore_page` within 72h. The autopilot purge phase hard-deletes after the recovery window."
- `links` 外键实测为 `ON DELETE CASCADE`（`links_from_page_id_fkey`/`links_to_page_id_fkey`），但**级联仅在硬删时触发**；软删只置 `deleted_at`，行与边都保留。
- 遍历与背链查询在 seed/step/select 三处均过滤 `deleted_at IS NULL`（`postgres-engine.traversePaths`），因此**图视图是干净的**——脏数据只在存储层。
- 单页**硬删没有 CLI 入口**（只有 `sources purge` 是源级）；页级硬删依赖 autopilot 的 purge 阶段（本部署未启用 autopilot）或引擎方法。

**回收原语（引擎已提供，仅检测）**：
- `gbrain orphans` 支持 `--json`、`--count`、`--source`、`--include-pseudo`、`--mode inbound|islanded`
- **默认 mode = `islanded`**（既无存活入边、也无存活出边）；回收想要的是 `--mode inbound`（**无存活入边**）——否则"被 enrich 过、有出边的实体页"不会被识别

→ 结论：**自动回收必须由服务实现**；引擎给出的是可靠的"孤儿"信号。安全前提是**来源标记**（只删自己创建的页）。

## R14 **slug 就是磁盘文件路径**——这是 `kb-x/docs/y` 结构的由来

**实测**：服务 API 导入文档后，磁盘出现对应文件。

```
DB slug: kb-86e4c440/docs/doc-two
  ↔ 磁盘: /data/rag/brains/kb-86e4c440/kb-86e4c440/docs/doc-two.md
                              └─ local_path ─┘ └────── slug ──────┘
```

- 每库的 repo 根 = `/data/rag/brains/<kb>`（即 source 的 `local_path`），内含 `.git`
- repo 根下以**库 id 命名的目录**是库命名空间（多库各自的 repo 隔离）
- 页文件路径 = `${local_path}/${slug}.md` —— **slug 不是标识符，是路径**

**两个直接推论**：
1. **改 slug 结构（如把 `docs/` 改名）成本大于收益**——会与磁盘布局、与关联项目的设计契约脱节；且**买不到任何东西**（类型来自 frontmatter，不来自目录）。前文曾建议"把目录改成 `notes/` 让引擎推出 `note` 类型"，**该建议作废**。
   > 措辞修正：早期版本写作"不能更改"，语气过头。准确表述是"**改动成本 > 收益**"，而非"技术上改不了"——`docs/` 在服务代码里只有 3 个功能位点（`deriveSlug` 生产者 / `/page` 守卫 / 删除路由形状），真要改是可行的。
2. **服务只暴露文档面**：`GET /documents` 返回的 slug 即用户在磁盘上的相对路径，语义自洽。

**生产磁盘实测**：三库 8+2+3 = **13 个 md 文件**，与 DB 的 13 页一致 → write-through 正常工作。

### R14.1 保留 `docs/` 的完整理由排序（迁移是最弱的一条）

| # | 理由 | 强度 | 依据 |
|---|---|---|---|
| 1 | **服务代码的既有约定**：`deriveSlug()` 是唯一 slug 生产者；`/page` 守卫以 `docs/` 为隔离边界；删除路由以 `docs/{dir}/{name}` 三段为形状 | 中（改 3 处即可） | `pipeline.ts:39`、`tenant.ts:293/314/330` |
| 2 | **磁盘布局**：slug = 磁盘相对路径 | 中（重建即可回正） | R14 |
| 3 | **关联项目的设计契约**（非"迁移问题"）：v3.2 §A3 明确全文获取要求**全路径 slug `kb-…/docs/…`**；台账列计划存 page slug（**草稿态**）；`knowledge_gbrain_mapping.py` 角色为"必需件" | **较强**（已确认的设计，非已发布代码） | `/tmp/kb-agent-rag-recon/07_plan_v3_2_amendments.md` §A3、`02_backend_schema_notes.md` |
| 4 | 已存数据/迁移 | **弱**（生产可重建，事实上已重建过一次） | — |

**结论**：改名唯一的**实质收益**是"绕过管线的直接写入也能凭路径推断拿到正确类型"（边缘场景）；成本是 3 处服务代码 + 关联项目设计（草稿态，便宜）+ 重导 13 篇。**建议保持 `docs/`**。

## R15 写入路径的落盘差异（决定实体页必须走哪条路）

| 路径 | `ctx.remote` | 落盘（write-through） | auto_link（建边） |
|---|---|---|---|
| 服务 `runGbrain(["put",...])`（本地 CLI） | **false** | ✅ 实测落盘 | ✅ **自动跑**（`isAutoLinkEnabled` 默认 true） |
| `gbrain import <dir>` | （import 路径） | ❌ **实测不落盘** | ❌ 不跑 |
| MCP `put_page`（远程） | true | ✅ | ❌ 跳过（`skipped: 'remote'`） |

**实测证据**：
- 服务 API 导入含 `[[Battery]]` 的文档（实体页已存在）→ 边**自动建立**，未跑任何显式 extract：
  `kb-.../docs/doc-two → kb-.../entities/battery [wikilink_basename/wikilink-resolved]`
- 同文档的 `[[Motor]]`（实体页不存在）→ **未建边** —— 再次印证"目标页必须存在"
- 用 `import --no-embed` 建的实体页：DB 有行，**磁盘无文件**

**推论**：建图**不需要显式 `extract links`**——put 的 auto_link 后钩子已覆盖。正确顺序是**先建实体页，再 put 文档**（一次到位）。保留一次显式 extract 作幂等兜底仍值得（覆盖 auto_link 被关闭 / 首次失败）。

## R16 dream 全阶段对"页"的影响（生产 DREAM_TIER=full 每日 4 点）

引擎 `config` 未设任何 `cycle.*` / `dream.*` 键 → 全用默认值。8 阶段之上 `ALL_PHASES` 实际含 ~22 个阶段：

| 阶段 | 默认 | 是否动页 | 对本方案 |
|---|---|---|---|
| `lint` | 跑 | 修**磁盘** md（LLM artifacts / 坏 frontmatter） | DB-only 时无 repo 可修 |
| `backlinks` | 跑 | **audit-only**（注释明确 "Maintenance cycles must not rewrite tracked brain pages"） | 安全 |
| `sync` | 跑 | **会 `softDeletePages`**（git deleted 驱动，`MASS_RECONCILE_RATIO` 保护） | ⚠️ 见 R18 |
| `synthesize` | **off**（需 `session_corpus_dir`） | 建页 | 未配置 → skip |
| **`extract`** | **跑** | 写 links / timeline（不建页） | ✅ **这是双链成边的另一条自动路径** |
| `extract_facts` | 跑 | 写 facts | 安全 |
| `extract_atoms` / `synthesize_concepts` | pack-gated（本 pack `phases: []`） | 建 atom/concept 页 | **skip** |
| `patterns` | 默认 **on**（但需 reflections 数据） | 建 pattern 页 | 无 reflections → 实质 skip |
| `recompute_emotional_weight` | 跑 | 改页字段 | 安全 |
| `consolidate` / `propose_takes` / `grade_takes` / `calibration_profile` | 跑（propose 默认 on） | 写 `takes` 表 | 安全 |
| `drift` | **off** | 建 report 页 | skip |
| `conversation_facts_backfill` | **off** | 写 facts | skip |
| `enrich_thin` | **off**（types 默认 `["person","company"]`） | **改写瘦页正文** | skip（且我们的页是 `concept`） |
| `embed` | 跑 | 嵌入 | 安全 |
| **`orphans`** | 跑 | **report-only**（只统计，status warn/ok） | ✅ **不删页** |

**结论**：
1. **没有任何阶段会自动删除实体页**（`orphans` 只报告；`sync` 只删 git 记录的删除）
2. **`extract` 阶段每天会自动建边** —— 即使服务不做显式提取，次日 4 点也会补齐（但有延迟，故仍需导入时即时提取）
3. 引擎自动产生的页（pattern/drift/atom）类型均非 `note` → **被文档面过滤自动挡住**

## R17 `sync` 阶段的删除语义与实体页的定位

- `sync` 是 **commit-driven**：`filtered.deleted` 来自 git 的变更（文件删除），据此 `softDeletePages`。
- 用 `import` 建的实体页**从未进入 git**（磁盘无文件、无 commit）→ 不在 git 的 deleted 列表 → **不会被 sync 删除**。
- 代价：实体页**不在磁盘、不在 git、不在备份链路**（部署文档称 git 目录是主要备份源）。
- **架构上可接受**：实体页是**纯派生数据**——可由文档双链 100% 重建。恢复流程 = 重新导入文档。
- **方案据此定位**：实体页走 `import`（快、零嵌入、不污染备份），并在文档中明确"派生数据，恢复靠重导"。

→ 若将来需要实体页纳入备份，可改走 `put`（落盘），代价是每页一次嵌入调用。

## R18 引擎 CLI 的并发容量（生产事故根因）

**症状（生产）**：并发批量导入时提交接口 `POST /documents` 出现 unhandled 500，日志为
`gbrain sources exited with 143`——**143 = SIGTERM**，即调用的 `AbortSignal.timeout` 触发。

**根因链**（无一处是"命令本身坏"）：
1. 每次 `runGbrain` 都是一个**独立进程**：单文件 bun 二进制 ~174MB，启动约 **1s CPU**（生产实测）。
2. `put` 的进程存活期**包含外部嵌入请求**——引擎源码明确 "Embed BEFORE the transaction (external API call)"，即事务外、但进程内。大文档可达数十秒。
3. 服务侧**没有任何并发上限**：worker 默认并发 2，每个任务还会串起 list/import/put/extract/orphans/get 多个 CLI；HTTP 路径的 `snapshot()` 另起 `sources list` + `sources archived`。
4. 于是批量导入时进程数爆炸 → CPU 饥饿 → 连纯读的 `sources list` 都跑不完 30s 预算 → 被 SIGTERM。
5. 该异常从 `ensureKbActive` 抛出且**未被捕获** → `unhandled_error` → 500。

**本方案对负载的放大**（须一并记账）：008 建图层每篇文档追加 `extract links` + `orphans` 两次**全库扫描**（400 页量级实测各约 1–1.5s），批量导入时与 `put` 争抢同一批 CLI 容量。

**修复**：
| 层 | 措施 |
|---|---|
| `gbrain-cli.ts` | 全局并发闸门（唯一 spawn 入口）：`GBRAIN_CLI_CONCURRENCY`（默认 3，建议 ≥ worker+1 以给读请求留槽）+ 有界排队 `GBRAIN_CLI_QUEUE_WAIT_MS`（默认 60s，超时抛 `CliBusyError`）；**执行超时不含排队**，避免长队列吃掉执行预算 |
| `kb.ts` | `snapshot()` **fail-open**：探测失败时用陈旧缓存放行——库存在性几乎不变，把一次只读探测失败放大成导入失败是错误取舍 |
| `entity-graph.ts` | 建图收尾（建边兜底 + 孤儿回收）按 `GRAPH_SETTLE_MS`（默认 60s）**去抖**；跳过安全，因为 `put` 的 auto_link 已写好本文档的边。删除路径的回收**不去抖**（显式、低频、应即时） |
| `tenant.ts` | `CliError`/`CliBusyError` → **503 `UPSTREAM_BUSY`**（可重试），不再升级成 unhandled 500 |

**评估过但**不做**的两件事**：
- **全 API 请求入队**：导入路径本就已入队（`rag_jobs` + `SKIP LOCKED`）；读路径轻量且现在有界。把读也改成异步 202 是契约大改、只增延迟。
- **CLI 独占锁**：`put` 的进程期主要是**网络 IO 的嵌入调用**，串行化会让批量导入从分钟级退化到小时级。有界并发 + 去抖已覆盖观测到的故障，无正确性理由。

**生产验证**（26 并发提交，同一库）：全部 202、26/26 任务 `done`；日志 `exited with 143` / `unhandled_error` / 闸门降级 **均为 0**；最终 13 文档 / 98 实体页（幂等）。

## R19 既有缺陷与本方案的交集

- **P10**：`/v1/kb/:id/retrieval` 请求 `top_k=2` 实测返回 5 条——`retrieval-serve.ts` 只把 `topK` 传给 `limit`，未对最终结果截断（多查询/双臂合并后超量）。→ 纳入 FR-011。
- **N4**：向量层为空时 hybrid 不报 `degraded`（`degraded: []`），但关键词臂仍返回——`sources/status` 的 `embed_coverage_pct` 可作外部判据。→ 可选增强，不在本期硬指标。
- **P9**：docling 服务因节点内存不足被 OOM 驱逐循环（日志 `Evicted: MemoryPressure`，`available: 836Ki`），导致图片通道不可用；health 200 是前端存活、转换后端已死。→ 属**部署运维项**，非本特性代码范围。
