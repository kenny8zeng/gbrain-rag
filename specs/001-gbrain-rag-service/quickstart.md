# Quickstart: 001-gbrain-rag-service

端到端验证指南。前置：Docker + compose；可访问的 Docling 实例（默认 `https://docling.ml.aesiot.dev`）与 OpenAI 兼容 embedding 端点。

## 1. 启动

```bash
cp deploy/.env.example deploy/.env   # 填 ADMIN_TOKEN / DOCLING_URL / EMBEDDING_*
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml logs -f gbrain-rag   # 等待 "listening" 就绪日志
```

容器内自检：`gbrain init --url $DATABASE_URL` 幂等执行 → server 拉起 `gbrain serve --http`（回环）→ worker loop 启动。

## 2. 全流程冒烟（对应 spec 验收）

```bash
BASE=http://localhost:3000
ADMIN="Authorization: Bearer $ADMIN_TOKEN"

# 建库（US1）
curl -s -H "$ADMIN" -H 'Content-Type: application/json' \
  -d '{"name":"产品文档"}' $BASE/v1/kb
# → {"id":"kb-xxxxxxxx",...}

# 签发凭证（US1）：写 kb-A 读 kb-A,kb-B（先建第二个库）
curl -s -H "$ADMIN" -H 'Content-Type: application/json' \
  -d '{"label":"agent-1","write_kb":"kb-AAAAAAAA","read_kbs":["kb-AAAAAAAA","kb-BBBBBBBB"]}' \
  $BASE/v1/keys
# → {"key":"gbrag_..."}   明文仅此一次

# 导入 PDF（US2）——接受即 202
curl -s -H "$ADMIN" -H "X-API-Key: $KEY" \
  -F file=@fixtures/sample.pdf $BASE/v1/kb/kb-AAAAAAAA/documents
# → {"job_id":"..."}；轮询直至 done
curl -s -H "$ADMIN" -H "X-API-Key: $KEY" \
  $BASE/v1/kb/kb-AAAAAAAA/documents/jobs/$JOB

# URL 与图片导入同理（type=url / file）；MD 直传：
curl -s -H "$ADMIN" -H "X-API-Key: $KEY" -H 'Content-Type: text/markdown' \
  --data '# 知识\n正文' $BASE/v1/kb/kb-AAAAAAAA/documents

# REST 检索（US4）
curl -s -H "$ADMIN" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"query":"退货规则","mode":"hybrid","top_k":8}' \
  $BASE/v1/kb/kb-AAAAAAAA/retrieval
```

## 3. MCP 会话验证（US3）

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/mcp ...)   # 经 MCP 客户端（如 @modelcontextprotocol/inspector）
# inspector: npx @modelcontextprotocol/inspector   → transport: streamable-http
#   url: http://localhost:3000/mcp  header: X-API-Key: $KEY
```

断言清单（与 contracts/mcp-gateway.md 验证基线一致）：

1. `tools/list` 非空（starter 面）
2. `put_page` slug 在 `<写分区>/` 内成功；越栅栏被上游拒绝
3. federated-read [A,B] 凭证 `search` 一次同时命中两库内容；仅 [A] 凭证看不到 B
4. `DELETE /v1/keys/:id` 后下一请求 401

## 4. 管理代理（US5）

```bash
curl -s -H "$ADMIN" "$BASE/v1/admin/gbrain/engine/status?format=json"   # 结构化
curl -sN -H "$ADMIN" "$BASE/v1/admin/gbrain/list?limit=3"               # SSE 流式
```

## 5. 集成测试

```bash
bun install && bun test            # 单测 + 契约
bun test tests/integration/        # 需 compose 栈在跑（双源隔离断言含于此）
```

## 6. 验收对照

| Spec | 快速验证点 |
|---|---|
| SC-001/SC-002 | sample.pdf 任务 done 耗时 / 检索响应计时 |
| SC-003 | MCP 断言 3（双源对照） |
| SC-005 | 本页 2→3 步骤全程人工可完成 |
| SC-006 | 故意提交坏 URL → job failed 带 error |
| SC-007 | 第 4 节两类输出均成功 |
