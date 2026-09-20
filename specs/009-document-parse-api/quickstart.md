# Quickstart: 裸文档解析 API（009）验收剧本

可运行的端到端验证指南。**不包含实现代码**；细节见 [contracts/parse-api.md](contracts/parse-api.md) 与 [data-model.md](data-model.md)。

## 前置

```bash
# 本地栈（含解析链；DOCLING_URL 留空 = anydoc 唯一形态）
docker compose -f deploy/compose.yaml up -d --build
BASE=http://localhost:3000
AT=local-dev-token-0123456789
```

**准备一个有效凭证**（本特性只需凭证有效，**无需**建库/绑定知识库 —— 这本身就是 SC-001 的一个验收点）：

```bash
# 关键：不创建任何知识库，只签发一个凭证（read_kbs 为空）
curl -s -X POST $BASE/v1/keys -H "Authorization: Bearer $AT" \
  -H 'Content-Type: application/json' \
  -d '{"label":"parse-probe","read_kbs":[]}' | tee /tmp/pk.json | jq -r .key > /tmp/pk.txt
KEY=$(cat /tmp/pk.txt)
```

## 场景 1 — 纯文本直通（任何部署形态都成功）

```bash
printf '# Title\n\nbody text [[Concept]]\n' | \
  curl -s -X POST $BASE/v1/kb/parse -H "X-API-Key: $KEY" \
    -H 'Content-Type: text/markdown' --data-binary @- | jq .
```

**期望**：`parser == "passthrough"`、`fallback_from == null`、`markdown` 与输入**逐字节相同**、`chars > 0`。

**反证**：断掉 `DOCLING_URL`（本就没配）不影响本场景成功 —— 证明直通零依赖解析通道。

## 场景 2 — 文档解析（anydoc 唯一形态）

```bash
# 用任何 docx/pdf 样本；测试素材见 tests/fixtures/
curl -s -X POST $BASE/v1/kb/parse -H "X-API-Key: $KEY" \
  -F "file=@tests/fixtures/sample.docx" | jq .
```

**期望**：`parser == "anydoc"`、`markdown` 非空、`empty == false`、`duration_ms > 0`。

## 场景 3 — 一致性：导入 vs 裸解析（SC-002 核心验收）

```bash
# 3.1 建库 + 可写凭证
KB=$(curl -s -X POST $BASE/v1/kb -H "Authorization: Bearer $AT" \
  -H 'Content-Type: application/json' -d '{"name":"parse-consistency"}' | jq -r .id)
WKEY=$(curl -s -X POST $BASE/v1/keys -H "Authorization: Bearer $AT" \
  -H 'Content-Type: application/json' \
  -d "{\"label\":\"parse-w-$RANDOM\",\"write_kb\":\"$KB\",\"read_kbs\":[\"$KB\"]}" | jq -r .key)

# 3.2 走导入
JID=$(curl -s -X POST "$BASE/v1/kb/$KB/documents" -H "X-API-Key: $WKEY" \
  -F "file=@tests/fixtures/sample.docx" | jq -r .job_id)
# 轮询至终态后，抓导入产出的正文与生效解析器（见 spec 注：实现不得改导入契约）

# 3.3 走裸解析
curl -s -X POST $BASE/v1/kb/parse -H "X-API-Key: $KEY" \
  -F "file=@tests/fixtures/sample.docx" > /tmp/parse.json

# 3.4 断言：markdown 逐字节一致 + 生效解析器相同
```

**期望**：同一部署、同一文件 → 两条路径 `markdown` **逐字节相同**、`parser` 相同。

## 场景 4 — 未配置外部解析服务时的「不支持类型」（SC-003 核心验收）

在 **anydoc 唯一**形态（`DOCLING_URL` 空）下：

```bash
# 4.1 白名单外类型 → 422 UNSUPPORTED_FILE_TYPE
curl -s -X POST $BASE/v1/kb/parse -H "X-API-Key: $KEY" \
  -F "file=@some/file.xyz;type=application/octet-stream" | jq .
# 期望：{"error":{"code":"UNSUPPORTED_FILE_TYPE", ...}} 且 message 含类型与原因

# 4.2 图片 → 422（通道不可用）
curl -s -X POST $BASE/v1/kb/parse -H "X-API-Key: $KEY" -F "file=@tests/fixtures/x.png" | jq .
# 期望：PARSER_UNAVAILABLE（message 指引所需配置）

# 4.3 URL → 422（通道不可用）
curl -s -X POST $BASE/v1/kb/parse -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"url":"https://example.com"}' | jq .
# 期望：PARSER_UNAVAILABLE
```

**零外部调用验证**：把 `DOCLING_URL` 指向一个**不存在的地址**（而非不配置），重复 4.3 —— 若实现真的触达外部，会得到连接错误（`PARSE_FAILED`）而非 `PARSER_UNAVAILABLE`。期望仍是通道不可用错误，证明**判定发生在任何出站之前**。

## 场景 5 — 能力自描述（SC-007）

```bash
curl -s $BASE/health | jq .parse
```

**期望**：块存在，且
- `available_channels` 与部署形态一致（anydoc 唯一形态下不含 docling）
- `accepts_url == false`（anydoc 唯一形态）
- `supported_file_types` 中**每一个**类型上传后都能被受理（不返回 `UNSUPPORTED_FILE_TYPE`）；列表外类型**必然**返回该错误 —— 逐项对拍（判定同源）

## 场景 6 — 无副作用（SC-001/FR-012）

```bash
# 记录调用前计数
BEFORE=$(curl -s "$BASE/v1/kb/$KB/documents" -H "X-API-Key: $WKEY" | jq '.pages|length')
# 连续 5 次解析
for i in 1 2 3 4 5; do curl -s -X POST $BASE/v1/kb/parse -H "X-API-Key: $KEY" \
  -F "file=@tests/fixtures/sample.docx" -o /dev/null; done
AFTER=$(curl -s "$BASE/v1/kb/$KB/documents" -H "X-API-Key: $WKEY" | jq '.pages|length')
```

**期望**：`BEFORE == AFTER`（页面数、图谱边数、任务记录数均不变）。

## 场景 7 — 凭证与边界

```bash
# 无效凭证 → 401（与不存在同响应）
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/v1/kb/parse -H "X-API-Key: gbrag_bogus" \
  -H 'Content-Type: text/markdown' --data-binary 'x'      # 期望 401

# 空文本 → 422 INVALID_PARAMS
printf '   \n' | curl -s -X POST $BASE/v1/kb/parse -H "X-API-Key: $KEY" \
  -H 'Content-Type: text/plain' --data-binary @- | jq .error.code

# 声明超限的文件 → 413
```

## 场景 8 — 并发饱和可重试（FR-011，可选）

并发发起远超 `PARSE_CONCURRENCY` 的解析请求：

**期望**：部分返回 503 `PARSE_BUSY`（**可重试**，与 422 类**不混**）；且此期间知识库导入/检索端点**保持可用**（解析不挤占引擎容量）。

## 全量回归

```bash
bun run test        # 唯一入口；新增单测/契约/集成均应绿
```
