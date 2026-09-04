# 使用介绍

## 1. 概念模型

| 概念 | 对应实现 | 说明 |
|---|---|---|
| 知识库（KB） | gbrain source（`kb-<8hex>`） | 内容隔离单元；建库即建独立分区（页面/索引互不可见） |
| Agent 凭证 | API key（`gbrag_<32hex>`） | 唯一身份：**写分区 0/1 个 + 读分区列表**（事前审批组合）；上游 OAuth client 硬隔离 |
| 导入任务 | rag_jobs | 异步摄取（转换→入库→索引）；失败自动重试 3 次 |
| 文档解析 | docling / anydoc | `DOCLING_URL` 配置则双解析器（失败自动回退）；未配置则 anydoc 唯一 |
| 页面 | gbrain page（`<kb>/docs/<name>`） | 单文档单页面；重复导入覆盖更新（upsert，版本历史可回滚） |

**权限模型**：凭证能做什么由签发时组合决定——写操作（导入/删页面）只允许在**写分区**；读操作（列表/检索）允许在**写分区 ∪ 读分区**；其余一律 403（不泄露存在性）。跨库检索自动合并，Agent 无需指定分区。

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
| `/v1/admin/models` | 模型配置装配（POST 预检+config set 装配 / GET 状态聚合） |

### 租户面

| 方法/路径 | 作用 | 权限 |
|---|---|---|
| `POST /v1/kb/:id/documents` | 导入（multipart 文件 / `{url}` / text-markdown） | 写分区 |
| `GET /v1/kb/:id/documents` | 页面列表 | 读授权 |
| `DELETE /v1/kb/:id/documents/docs/:name` | 删除页面 | 写分区 |
| `GET /v1/kb/:id/documents/jobs/:jobId` | 任务状态 | 读授权 |
| `POST /v1/kb/:id/retrieval` | 检索（`mode: hybrid\|keyword`） | 读授权 |

### 三种导入输入

```bash
# ① 文件/图片（docling 模式；anydoc 模式支持文档类，图片需 docling）
curl -F file=@report.docx http://.../v1/kb/$KB/documents

# ② 网页 URL（仅 docling 模式；anydoc 模式 422 指引）
curl -d '{"url":"https://example.com/doc"}' http://.../v1/kb/$KB/documents

# ③ Markdown 直传（不经解析器，两模式一致；X-Slug 控制页面名）
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
| INTERNAL | 500 | 服务端错误（日志含详情） |

**删除语义**：`DELETE /v1/kb/:id` → 200 `{"status":"archived"}`（**归档非物理删除**，72h 保留可恢复）；物理清除走 `POST /v1/kb/:id/purge`（有引用凭证时 `?force=true` 联动吊销）。凭证吊销后 401（`invalid api key`），与"凭证不存在"同响应（不泄露存在性）。

完整契约与示例见 [examples.md](examples.md) 与 [部署说明](deployment.md)。
