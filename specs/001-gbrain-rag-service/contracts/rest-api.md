# Contract: REST API

统一入口单端口（`PORT`，默认 3000）。错误统一 JSON：`{"error": {"code", "message"}}`。

鉴权：
- 管理面：`Authorization: Bearer $ADMIN_TOKEN`（缺/错 → 401）
- 租户面：`X-API-Key: gbrag_...`（缺/错 → 401；越权 → 403，不带存在性信息）

## 管理面

### POST /v1/kb — 创建知识库

```json
// req
{"name": "产品文档"}
// 201
{"id": "kb-a1b2c3d4", "name": "产品文档", "status": "active", "created_at": "..."}
```

行为：建 `DATA_DIR/brains/<id>/`（git init + 首提交）→ `sources add <id> --path <dir>`。

### GET /v1/kb — 列表（映射 `sources list --json`）；GET /v1/kb/:id — 详情（`sources status --json`，archived → 410）

### DELETE /v1/kb/:id — 归档（`sources archive`）

存在有效凭证引用该库时 → `409 {"error":{"code":"KB_IN_USE","credential_ids":[...]}}`，需先吊销或带 `?force=true` 联动吊销后归档。

### POST /v1/kb/:id/purge — 永久清除（`sources remove --confirm-destructive`；未过 72h 保留期需 `?force=true` 显式确认）

### POST /v1/keys — 签发凭证

```json
// req
{"label": "agent-doc-writer", "write_kb": "kb-a1b2c3d4", "read_kbs": ["kb-a1b2c3d4", "kb-e5f6a7b8"], "surface": "starter", "concurrency": 4}
// 201 —— 明文 key 仅此一次
{"id": "<uuid>", "key": "gbrag_<32hex>", "label": "agent-doc-writer", "write_kb": "...", "read_kbs": ["..."], "created_at": "..."}
```

校验：read_kbs 引用存在且 active（否则 404/410）。行为：`auth register-client`（见 data-model §5）。

### PATCH /v1/keys/:id — 变更 `{write_kb?, read_kbs?, surface?, concurrency?}` → `rescope-client` 即时生效；200 返回脱敏凭证。

### DELETE /v1/keys/:id — 吊销（`revoke-client` + revoked_at）；204。

### GET /v1/keys — 列表（出 key_prefix 不出哈希）；GET /v1/jobs?kb_id=&status= — 任务列表；GET /v1/jobs/:id — 任务详情。

## 租户面

### POST /v1/kb/:id/documents — 提交导入

授权：`id == key.write_kb`（导入是写操作；否则 403）。三选一输入：

1. `multipart/form-data`：字段 `file`（文档/图片，≤100MB），可选 `title`
2. `application/json`：`{"url": "https://...", "title"?}`
3. `text/markdown`：body 即内容，header `X-Slug` 可选提示 slug

```json
// 202
{"job_id": "<uuid>", "kb_id": "kb-a1b2c3d4", "status": "queued"}
```

超限/不支持格式 → 400 列出支持范围；重复 slug 由 FR-008 upsert 语义承接。

### GET /v1/kb/:id/documents/jobs/:jobId — 任务状态（授权：id ∈ write_kb ∪ read_kbs）

```json
{"id": "...", "status": "done", "attempts": 1, "outcome": "updated", "doc_slug": "kb-a1b2c3d4/docs/report-2026", "error": null}
```

### GET /v1/kb/:id/documents — 页面列表（`gbrain list` 输出按行解析为 {slug,type,date,title}；授权同上，只读合法）

### DELETE /v1/kb/:id/documents/:dir/:name — 删页面（需 `id == key.write_kb`；slug 固定三段 `<id>/<dir>/<name>`，dir 必须为 `docs`；`gbrain delete` + 原始档案删除）；204。

### POST /v1/kb/:id/retrieval — 检索（授权：id ∈ write_kb ∪ read_kbs）

```json
// req
{"query": "退货规则", "mode": "hybrid", "top_k": 8}
// 200
{
  "results": [
    {"slug": "kb-a1b2c3d4/docs/returns", "title": "退货政策", "snippet": "...", "score": 0.87, "source_id": "kb-a1b2c3d4"}
  ],
  "mode": "hybrid", "degraded": []
}
```

`mode`: `hybrid`（默认，`gbrain query --json`）| `keyword`（`gbrain search --json`）；`top_k` → `--limit`。

## 健康与文档

- `GET /health` — `{status: "ok"|"degraded", gbrain_serve: bool, db: bool, docling: bool}`（docling 探活 5s 缓存）
- `GET /openapi.json` / `GET /docs` — 自有 REST 的 Swagger（管理代理面契约见 admin-proxy.md）

## 状态码约定

401 未认证 / 403 越权 / 404 不存在 / 409 KB_IN_USE / 410 archived / 413 超 100MB / 422 校验失败 / 429 MCP 并发超限 / 502 上游（引擎/转换）失败 / 503 引擎未就绪
