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

## 7. 知识图谱检索

```bash
# ① 图谱增强检索（一次调用拿两条通道；不传 graph 就是纯向量，行为与历史一致）
curl -s -X POST "$BASE/v1/kb/$KB/retrieval" -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"query":"brake abnormal noise","top_k":3,
       "graph":{"depth":2,"seed_k":3,"max_results":10}}' | jq .
# results[]      → 向量排名（slug/title/snippet/score）
# graph_results[] → 图谱发现的相邻文档（slug/via_concepts/seed_slugs/shared_concepts/weight）

# ② 直接走图：从概念出发的多跳遍历（省略 direction 默认 both）
curl -s "$BASE/v1/kb/$KB/graph/traverse?slug=$KB/entities/brake&depth=2" \
  -H "X-API-Key: $KEY" | jq '.paths[] | {from_slug, to_slug, link_type, context}'
# context = 该关系在原文中的出处片段，可作答案引用

# ③ 取全文（两条通道返回的都是 slug）
curl -s "$BASE/v1/kb/$KB/page?slug=$KB/docs/<name>" -H "X-API-Key: $KEY" | jq -r .content
```

**读法**：`graph_results` 的排序是启发式（`weight` 压制品牌名之类无处不在的概念），**判断相关性优先看 `via_concepts`**——它直接说明这篇文档因为哪个概念被连上。图谱命中是「推导出的关联」而非排序结果，故独立数组、不给分数。

## 8. MCP 接入（Agent）

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

**图谱相关 MCP 工具**（Agent 可直接调用）：

```
traverse_graph  {"slug":"<kb>/entities/brake","depth":2,"direction":"both"}
get_links       {"slug":"<kb>/docs/<name>"}     # 出边
get_backlinks   {"slug":"<kb>/entities/brake"}  # 入边
list_link_sources {}
```

⚠️ 两点差异：
- **文档面读工具（`search`/`query`/`list_pages`）已注入文档类型过滤**——实体页不会出现在 Agent 的文档视图里（与 REST 面语义一致）；调用方显式传 `types` 时不覆盖
- **图工具不受该过滤影响**（这正是查图谱的通道）

⚠️ `traverse_graph` 的**返回形状随 `direction` 变化**：省略 → 节点树（`{slug,links[]}`）；传 `in`/`out`/`both` → 边列表（`{from_slug,to_slug,link_type,context,depth}`）。要边列表就必须传 `direction`。

## 9. 运维示例

```bash
# 引擎状态（结构化）
curl -s -H "$AUTH" "$BASE/v1/admin/gbrain/engine/status?format=json" | jq .

# 任务列表（按状态过滤）
curl -s -H "$AUTH" "$BASE/v1/jobs?status=failed" | jq '.jobs[] | {type, error}'

# Swagger 交互文档
open http://localhost:3000/docs
```
