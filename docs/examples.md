# 使用示例

以下为可直接复制的完整示例会话。前置：服务已部署（见 [deployment.md](deployment.md)），`ADMIN_TOKEN` 与部署一致。

```bash
BASE=http://localhost:3000
ADMIN=your-admin-token
AUTH="Authorization: Bearer $ADMIN"
```

## 1. 建库 → 发凭证 → 导入 → 检索（最小闭环）

```bash
# 建两个知识库
KB_A=$(curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"产品文档"}' $BASE/v1/kb | jq -r .id)
KB_B=$(curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"价格资料"}' $BASE/v1/kb | jq -r .id)
echo "KB_A=$KB_A  KB_B=$KB_B"   # kb-xxxxxxxx 格式

# 签发凭证：写 A，读 A+B（跨库检索权限）
KEY_RESP=$(curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"label\":\"agent-1\",\"write_kb\":\"$KB_A\",\"read_kbs\":[\"$KB_A\",\"$KB_B\"]}" \
  $BASE/v1/keys)
KEY=$(echo "$KEY_RESP" | jq -r .key)
echo "KEY=$KEY"   # gbrag_... 明文仅此一次，立即保存

# 导入 Markdown（X-Slug 控制页面名）
curl -s -X POST -H "X-API-Key: $KEY" -H 'Content-Type: text/markdown' \
  -H 'X-Slug: returns-policy' \
  --data-binary '# 退货政策
七日内无理由退货，运费由平台承担。' \
  $BASE/v1/kb/$KB_A/documents
# → 202 {"job_id":"...","status":"queued"}

# 轮询任务到终态
curl -s -H "X-API-Key: $KEY" \
  $BASE/v1/kb/$KB_A/documents/jobs/<job_id> | jq '{status, outcome, doc_slug, parser_log}'
# → done / created / kb-xxx/docs/returns-policy / "docling"（或回退链）

# 关键词检索
curl -s -X POST -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"query":"退货","mode":"keyword","top_k":5}' \
  $BASE/v1/kb/$KB_A/retrieval | jq '.results[] | {slug, score, snippet}'
```

## 2. 导入文档文件（docx 走 docling 或 anydoc）

```bash
# docling 配置时默认 docling 优先；docling 失败自动回退 anydoc（parser_log 记录链）
curl -s -X POST -H "X-API-Key: $KEY" -F file=@report.docx \
  $BASE/v1/kb/$KB_A/documents | jq -r .job_id
```

支持格式：Word/PPT/Excel/OpenDocument/RTF/EPUB/CSV/PDF（anydoc）及 docling 全部格式 + 图片/网页。

## 3. 解析器模式速查

| 场景 | 配置 | 文件导入 | URL/图片 |
|---|---|---|---|
| 默认（有 docling） | `DOCLING_URL` 配置 | docling 优先 → 失败回退 anydoc | docling |
| anydoc 优先 | `PARSER_PREFERENCE=anydoc` | anydoc 毫秒级 → 失败回退 docling | docling |
| 无 docling | `DOCLING_URL` 留空 | anydoc 唯一 | 422 PARSER_UNAVAILABLE |

## 4. 权限验证

```bash
# 第三个库 C（未授权）
KB_C=$(curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"机密"}' $BASE/v1/kb | jq -r .id)

# 检索 C → 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"query":"x"}' \
  $BASE/v1/kb/$KB_C/retrieval

# 向 B 导入（B 只读）→ 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "X-API-Key: $KEY" \
  -H 'Content-Type: text/markdown' -d '# x' $BASE/v1/kb/$KB_B/documents
```

## 5. 变更授权与吊销

```bash
KEY_ID=$(curl -s -H "$AUTH" $BASE/v1/keys | jq -r \
  '.[] | select(.label=="agent-1") | .id')

# 读授权收缩为 [A]（即时生效，B 立即不可见）
curl -s -X PATCH -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"read_kbs\":[\"$KB_A\"]}" $BASE/v1/keys/$KEY_ID | jq '{read_kbs}'

# 吊销（token 级联失效，含 MCP 会话）
curl -s -X DELETE -H "$AUTH" $BASE/v1/keys/$KEY_ID -o /dev/null -w '%{http_code}\n'   # 204
```

## 6. 删除文档与知识库

```bash
# 删除页面（slug 三段：<kb>/docs/<name>）→ 204
curl -s -X DELETE -H "X-API-Key: $KEY" \
  $BASE/v1/kb/$KB_A/documents/docs/returns-policy

# 归档知识库（72h 保留）→ GET 详情 410
curl -s -X DELETE -H "$AUTH" $BASE/v1/kb/$KB_B
curl -s -o /dev/null -w '%{http_code}\n' -H "$AUTH" $BASE/v1/kb/$KB_B   # 410

# 永久清除（有凭证引用需 force=true 联动吊销）
curl -s -X POST -H "$AUTH" "$BASE/v1/kb/$KB_B/purge?force=true" | jq '{status, revoked_keys}'
```

## 7. MCP 接入（Agent）

```bash
# 方式一：MCP Inspector（浏览器交互）
npx @modelcontextprotocol/inspector
# transport: streamable-http
# URL: http://localhost:3000/mcp   Header: X-API-Key: gbrag_...

# 方式二：裸 JSON-RPC（验证连通）
curl -s -X POST http://localhost:3000/mcp \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2025-03-26","capabilities":{},
                 "clientInfo":{"name":"demo","version":"1.0"}}}'
# 之后 tools/call（例：{"name":"search","arguments":{"query":"退货"}}）
```

Agent 体验：在其写分区内自主建/改/删页面，检索自动覆盖授权读分区——内容管理 + 检索的基础能力闭环。

## 8. 运维示例

```bash
# 引擎状态（结构化）
curl -s -H "$AUTH" "$BASE/v1/admin/gbrain/engine/status?format=json" | jq .

# 任务列表（按状态过滤）
curl -s -H "$AUTH" "$BASE/v1/jobs?status=failed" | jq '.jobs[] | {type, error}'

# Swagger 交互文档
open http://localhost:3000/docs
```
