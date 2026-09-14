# 使用介绍

## 1. 概念模型

| 概念 | 对应实现 | 说明 |
|---|---|---|
| 知识库（KB） | gbrain source（`kb-<8hex>`） | 内容隔离单元；建库即建独立分区（页面/索引互不可见） |
| Agent 凭证 | API key（`gbrag_<32hex>`） | 唯一身份：**写分区 0/1 个 + 读分区列表**（事前审批组合）；上游 OAuth client 硬隔离 |
| 导入任务 | rag_jobs | 异步摄取（转换→入库→索引）；失败自动重试 3 次 |
| 文档解析 | docling / anydoc | `DOCLING_URL` 配置则双解析器（失败自动回退）；未配置则 anydoc 唯一 |
| 页面 | gbrain page（`<kb>/docs/<name>`） | 单文档单页面；重复导入覆盖更新（upsert，版本历史可回滚） |
| 知识图谱 | gbrain links + 实体页 | 文档正文的 `[[双链]]` 自动连成关系图；双链指向的概念自动拥有节点页（`<kb>/entities/<name>`），供实体级多跳查询 |

**权限模型**：凭证能做什么由签发时组合决定——写操作（导入/删页面）只允许在**写分区**；读操作（列表/检索）允许在**写分区 ∪ 读分区**；其余一律 403（不泄露存在性）。跨库检索自动合并，Agent 无需指定分区。

### 知识图谱（双链）

导入的 markdown 里写 `[[概念]]`，服务会：

1. 为每个双链目标**自动创建实体页**（`<kb>/entities/<规范化名>`；已存在的页一律不动）
2. 建边（引擎的 auto_link 在写入时即建关系，服务另做一次幂等提取兜底）
3. 删除文档后**自动回收**"不再被任何存活文档引用"的实体页（共享节点保留）

| 事实 | 说明 |
|---|---|
| 节点 = 页 | gbrain 的图是"页到页"；`[[电池]]` 的语义是"指向名为电池的那一页"，目标页不存在则链被丢弃 |
| 命名规范化 | 大小写不敏感、空格→`-`、重音折叠（`[[Soleil01 SE]]` → `soleil01-se`）；中文原样保留 |
| 文档面隔离 | 实体页对租户面**不可见**：`GET /documents` 与检索按类型 + `<kb>/docs/` 前缀双重过滤；`GET /page` 只接受 `docs/` 前缀（非本分区 422） |
| 实体页不入检索 | 实体页不参与向量嵌入（零嵌入成本），专供图查询 |
| 跨库隔离 | 实体页位于各库自己的 `entities/` 分区，同名概念在不同库互不串边 |
| 派生数据 | 实体页由文档双链推导（不落磁盘、不进备份）；丢失可经重新导入文档 100% 重建 |

**组合检索（推荐形态）**：向量负责"按语义找文档"，图谱负责"展开相关概念与关联文档"，两者互补。

**一次调用即可拿到两条通道**（`graph` 参数缺省时 = 纯向量/关键词，行为与历史完全一致）：

```bash
# 向量 + 图谱（同一次请求）
curl -X POST "$BASE/v1/kb/$KB/retrieval" -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"query":"brake abnormal noise","mode":"hybrid","top_k":1,
       "graph":{"depth":2,"seed_k":3,"max_results":10}}'
# → {"results":[{slug,title,snippet,score,source_id}],          ← 向量排名（保持不变）
#    "graph_results":[{slug,via_concepts,seed_slugs,shared_concepts,weight}], ← 图谱发现（新增）
#    "mode":"hybrid","degraded":[]}
```

| `graph` 字段 | 默认 | 说明 |
|---|---|---|
| `depth` | 2 | 展开跳数。**2 = 文档→概念→相邻文档**（拿到"同概念的另一批文档"） |
| `seed_k` | 全部结果 | 用向量前 N 条做种子 |
| `max_results` | 10 | 图谱发现上限 |

**为何不合并成一个数组**：图谱命中是**推导出的关联**而非排序结果（无向量分）。混排会凭空造分数，因此独立数组 + 溯源：

| 字段 | 含义 |
|---|---|
| `via_concepts` | 把该文档与种子文档连起来的概念（**最该看这个**） |
| `seed_slugs` | 由哪几篇种子文档发现 |
| `shared_concepts` | 共现概念数（原始计数，事实） |
| `weight` | 特异性加权分 = `Σ 1/fanout(概念)`，**排序依据**。`fanout` = 该概念在本轮连到多少篇相邻文档——品牌名之类无处不在的概念 fanout 大、贡献趋 0（实测某库 `soleil01` 仅贡献 ≈0.07，而 `troubleshooting` 贡献 1.0）；专有概念贡献接近 1 |

> 排序是启发式：`weight` 用于排序，但**判断相关性请优先看 `via_concepts`**——它直接告诉你这两篇文档是因为哪个概念被联系起来的。

**实测**（`top_k=1`，逼向量只给 1 篇）：
```
results:       a-seed       (0.946)
graph_results: b-sibling    via_concepts=["brake"]  shared_concepts=1
```
`b-sibling` 讲的是"用哪种刹车"，与"异响"语义不同（向量不召），但同属 brake 概念（图能连上）。

**也可分开调用**（需要更细控制时）：

```bash
# 图谱遍历：从概念或被发现的文档出发
curl "$BASE/v1/kb/$KB/graph/traverse?slug=$KB/entities/brake&depth=2" -H "X-API-Key: $KEY"
# → {"paths":[{"from_slug","to_slug","link_type","context","depth"}]}
#   context = 该关系在原文中的出处片段；direction 缺省为 both

# 取全文（graph/retrieval 返回的都是 slug，配此端点拿内容）
curl "$BASE/v1/kb/$KB/page?slug=$KB/docs/<name>" -H "X-API-Key: $KEY"
# → {"slug","content"}
```

**实测对照**（同一问题「刹车异响排查」）：

| 通道 | 命中 |
|---|---|
| 向量（top 5） | 3 篇故障排查文档 |
| 图谱（`brake` 二跳） | 3 篇，其中 **2 篇向量漏掉**（同为 ICT 刹车主题，但问的是"用哪种刹车/是否需要组装"——语义不同、概念相同） |
| 两者并集 | 5 篇，覆盖"怎么排查"与"是什么"两侧面 |

**要点**：
- `graph/traverse` 返回的 **`context` 字段**直接给出关系出处（原文片段），可作答案引用
- **每个端点限定单个 `{id}`**（响应 `source_id` 即该库）——多库需分别调用后自行合并
- 概念 slug 规范：`[[Soleil01 SE]]` → `<kb>/entities/soleil01-se`（小写、空格→`-`、重音折叠；CJK 原样）
- `degraded` 非空表示部分通道降级（如向量层不可用，仅关键词生效）

**图查询端点**

租户面（受读授权管控）：

```bash
# 多跳关系遍历（起点 slug 须属本 key 可读的库；返回路径已收敛到可读库内）
GET /v1/kb/{id}/graph/traverse?slug=<kb>/entities/battery&depth=2&direction=both
```

管理面（全库，运维/调试用）：

```bash
GET /v1/admin/graph/entity?slug=<kb>/entities/battery     # 实体卡：页面摘要 + 出/入边
GET /v1/admin/graph/traverse?slug=...&depth=2&direction=both
```

Agent 侧经 MCP 可用 `traverse_graph` / `entity` / `get_links` / `get_backlinks`（以 `tools/list` 实际返回为准）。**MCP 的文档面读工具（`search`/`query`/`list_pages`）已注入文档类型过滤**——实体页不会出现在你的文档视图里；图工具不受影响。

## 2. 接口平面

所有接口统一入口（单端口），两个鉴权平面 + 公开面。**认证模型系统说明见 [auth-model.md](auth-model.md)**（机制/生命周期/安全属性）；此处为速查。

| 平面 | 鉴权 | 覆盖 |
|---|---|---|
| 管理面 | `Authorization: Bearer $ADMIN_TOKEN` | 知识库生命周期、凭证签发/变更/吊销、任务查询、模型配置、引擎运维代理 |
| 租户面 | `X-API-Key: gbrag_...` | 导入、页面管理、检索、任务状态 |
| 公开 | 无 | 健康检查、OpenAPI 文档、Swagger UI、MCP 端点（X-API-Key 鉴权） |

> 管理面（含 `/v1/admin/gbrain/*` 引擎代理）覆盖**破坏性运维**（purge/吊销/引擎级删除——引擎 CLI 自带确认语义）。`ADMIN_TOKEN` 即全权凭证：高强度随机、仅部署者持有、定期轮换；破坏性操作不在服务层二次确认（信任边界 = 管理面本身）。

### 管理面

| 方法/路径 | 作用 |
|---|---|
| `POST /v1/kb` · `GET /v1/kb` · `GET/DELETE /v1/kb/:id` | 创建/列表/详情（归档态 410）/归档（72h 保留） |
| `POST /v1/kb/:id/purge` | 永久清除（有引用需 `?force=true` 联动吊销） |
| `POST /v1/keys` · `PATCH/DELETE /v1/keys/:id` · `GET /v1/keys` | 签发（明文仅一次）/变更授权（即时生效）/吊销/列表 |
| `GET /v1/jobs` · `/v1/jobs/:id` | 任务列表（kb/status 过滤）/详情 |
| `/v1/admin/gbrain/*` | gbrain 引擎全量运维（55 路由；SSE 流式，只读状态路由支持 `?format=json`） |
| `POST/GET /v1/admin/dream` | 梦境周期：手工触发一次（异步 202）/ 状态查询（运行中触发 409 `DREAM_RUNNING`） |
| `GET /v1/admin/graph/entity` · `/v1/admin/graph/traverse` | 知识图谱：实体卡（入/出边）/ 多跳遍历（`depth`/`direction`/`link_type`） |
| `/v1/admin/models` | 模型配置装配（POST 预检+config set 装配 / GET 状态聚合） |

### 租户面

| 方法/路径 | 作用 | 权限 |
|---|---|---|
| `POST /v1/kb/:id/documents` | 导入（multipart 文件 / `{url}` / text-markdown） | 写分区 |
| `GET /v1/kb/:id/documents` | 页面列表 | 读授权 |
| `GET /v1/kb/:id/page?slug=...` | **页面全文**（markdown，slug 须属本 kb） | 读授权 |
| `DELETE /v1/kb/:id/documents/docs/:name` | 删除页面 | 写分区 |
| `GET /v1/kb/:id/documents/jobs/:jobId` | 任务状态 | 读授权 |
| `POST /v1/kb/:id/retrieval` | 检索（`mode: hybrid\|keyword`） | 读授权 |
| `GET /v1/kb/:id/graph/traverse` | 图谱多跳遍历（`slug`/`depth`/`direction`/`link_type`） | 读授权 |

### 三种导入输入

```bash
# ① 文件/图片（docling 模式；anydoc 模式支持文档类，图片需 docling）
curl -F file=@report.docx http://.../v1/kb/$KB/documents

# ② 网页 URL（仅 docling 模式；anydoc 模式 422 指引）
curl -d '{"url":"https://example.com/doc"}' http://.../v1/kb/$KB/documents

# ③ Markdown 直传（不经解析器，两模式一致；X-Slug 控制页面名）
# X-Slug 仅允许 ASCII（字母/数字/._-）；中文标题请用正文首行 #（非 ASCII slug 显式 422）
curl -H 'Content-Type: text/markdown' -H 'X-Slug: notes' --data-binary @note.md ...
```

### 检索

```json
POST /v1/kb/{id}/retrieval
{"query": "退货政策", "mode": "keyword", "top_k": 8}
```

- `mode`: `hybrid`（默认，语义扩展+向量）依赖 embedding 配置；`keyword`（tsvector）开箱即用
- 结果：`results[]`（slug/title/snippet/score/source_id）+ mode/degraded
  - `snippet` ≤ 2000 字符；**命中仅返回元数据**（slug/title/snippet），全文内容经文档 API（`GET /v1/kb/:id/documents`）获取
  - `degraded[]` 非空 = 该检索有降级（如 `embed_unavailable`/`rerank_unavailable`），空数组 = 全链路正常
- rerank/语义质量由引擎侧配置（embedding/reranker 端点），服务透传

## 3. MCP（Agent 接入）

- 端点：`POST|GET /mcp`（Streamable HTTP），鉴权 `X-API-Key`（租户密钥）
- 工具面：上游 OAuth client 钉定（默认 starter：内容管理 + 检索；可按凭证调 full）
- Agent 连接后：在其**写分区**内建/改/删页面；检索自动覆盖全部**读分区**（跨源合并）；任何请求参数都无法触达未授权分区

典型工具（starter 面）：`put_page`/`get_page`/`delete_page`/`search`/`query`/`list_pages` 等（以 `tools/list` 实际返回为准）。

## 4. 文档与契约

| 地址 | 内容 |
|---|---|
| `GET /docs` | Swagger UI（服务接口 + 引擎运维代理两组，可录凭证在线执行） |
| `GET /openapi.json` | 服务接口 OpenAPI 描述（租户/管理面，双鉴权方案） |
| `GET /v1/admin/openapi/gbrain.json` | 引擎代理 55 路由描述 |

接口契约与文档**零漂移**（路由定义即文档源，CI 闸门保证）。

## 5. 错误码速查

| code | HTTP | 场景 |
|---|---|---|
| UNAUTHORIZED | 401 | 无/错凭证 |
| FORBIDDEN | 403 | 越权（无存在性信息） |
| NOT_FOUND | 404 | 资源不存在 |
| KB_IN_USE | 409 | 归档/purge 有引用（force 联动） |
| ARCHIVED | 410 | 目标已归档 |
| PAYLOAD_TOO_LARGE | 413 | 超 MAX_UPLOAD_BYTES |
| INVALID_PARAMS | 422 | 参数不合法 |
| PARSER_UNAVAILABLE | 422 | 当前解析模式不支持该通道（如 anydoc 模式的 URL） |
| DREAM_RUNNING | 409 | 梦境周期已在运行（再次触发被拒） |
| RATE_LIMITED | 429 | 并发超限 |
| UPSTREAM_BUSY | 503 | 知识引擎容量饱和（CLI 并发闸门排满，可重试） |
| INTERNAL | 500 | 服务端错误（日志含详情） |

**引擎容量与并发**：所有 `gbrain` CLI 调用经**全局并发闸门**（默认 3，`GBRAIN_CLI_CONCURRENCY`）——每个调用是独立进程（~1s 启动 CPU + 常驻内存），且 `put` 期间挂着外部嵌入请求。排队超过 `GBRAIN_CLI_QUEUE_WAIT_MS`（默认 60s）即返回 503 而非无限等待。大批量导入请**顺序提交**并轮询任务；建图收尾（建边兜底 + 孤儿回收的全库扫描）按 `GRAPH_SETTLE_MS`（默认 60s）去抖。

**删除语义**：`DELETE /v1/kb/:id` → 200 `{"status":"archived"}`（**归档非物理删除**，72h 保留可恢复）；物理清除走 `POST /v1/kb/:id/purge`（有引用凭证时 `?force=true` 联动吊销）。凭证吊销后 401（`invalid api key`），与"凭证不存在"同响应（不泄露存在性）。

完整契约与示例见 [examples.md](examples.md) 与 [部署说明](deployment.md)。
