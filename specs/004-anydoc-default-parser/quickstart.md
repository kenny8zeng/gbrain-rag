# Quickstart: 004-anydoc-default-parser

## 前置

compose 栈运行中。**默认解析器模式**：`deploy/.env` 中注释掉 `DOCLING_URL`（置空）后 `docker compose up -d --build`。

## 验证场景

### 1. 默认模式：docx 全链路（US1 / SC-001/002）

```bash
# 上传 tests/fixtures/test.docx（含中文与表格）
curl -s -X POST -H "X-API-Key: $KEY" -F file=@tests/fixtures/test.docx \
  http://localhost:3000/v1/kb/$KB/documents        # → 202 job_id
# 轮询任务 → done
# 检索命中表格内容
curl -s -X POST -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"query":"退货政策","mode":"keyword"}' http://localhost:3000/v1/kb/$KB/retrieval
```

预期：job done；页面 `$KB/docs/test`；检索命中中文文本与表格标记。

### 2. url/图片明确拒绝（US2 / SC-003）

```bash
curl -s -X POST -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}' http://localhost:3000/v1/kb/$KB/documents
# → 422 {"error":{"code":"PARSER_UNAVAILABLE",...}} 指引配置 DOCLING_URL
# 图片 multipart 同断言
```

### 3. 健康检查（FR-007）

```bash
curl -s http://localhost:3000/health   # parser_mode=anydoc, docling=false, status=ok
```

### 4. docling 模式零回归（FR-002/SC-004）

```bash
# .env 恢复 DOCLING_URL 后重建；跑全量测试
TEST_BASE_URL=http://localhost:3000 ADMIN_TOKEN=... bun run test   # 73 项零回归
```

### 5. OCR 语义（SC-005，可选路径）

单元测试覆盖（mock needsOcr）：无 key → failed 带 OCR 指引；配置 `FIRECRAWL_API_KEY` → hosted 重试分支。

## 验收对照

| Spec | 验证点 |
|---|---|
| SC-001 | 场景 1（docx）+ fixture 多格式抽样 |
| SC-002 | 场景 1 端到端计时 |
| SC-003 | 场景 2 |
| SC-004 | 场景 4 |
| SC-005 | 场景 5 |
