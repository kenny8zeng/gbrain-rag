# Contract: MCP Gateway (`/mcp`)

对 Agent 暴露标准 MCP Streamable HTTP 端点（协议版本随上游 `gbrain serve --http`，≥2025-03-26）。

## 接入

```text
POST|DELETE /mcp    JSON-RPC 消息 / 会话终结
GET /mcp            SSE 流（服务器推送）
Header: X-API-Key: gbrag_...        # 唯一认证方式
        Mcp-Session-Id: <上游会话>   # initialize 后由网关透传维护
```

## 网关行为契约

1. **鉴权**：`X-API-Key` → sha256 查 `rag_keys`（revoked → 401）。单凭证并发 > `rag_keys.concurrency` → 429。
2. **上游凭证**：取该凭证的 `client_id/secret` → token 缓存（TTL 1h）→ 过期或上游 401 时重取一次并重放。
3. **头处理**：剥离调用方的 `Authorization` 与一切 `x-gbrain-*` 头；注入 `Authorization: Bearer <上游token>`。调用方无法携带任何影响 source 选择的参数（FR-005）。
4. **会话**：网关维护 per-credential 上游会话映射；上游会话失效 → 重建并透传新 `Mcp-Session-Id`。
5. **透传范围**：全部 JSON-RPC 方法原样转发（tools/list、tools/call、resources 等）；响应原样返回。工具面由上游 client `--surface` 钉定（默认 starter）。
6. **隔离保证**（引擎侧硬隔离，实证见 research D2）：
   - 写操作只落 `--source` 写分区；slug 栅栏 `<write_kb>/*` 之外的写入被上游拒绝
   - 检索自动覆盖 `--federated-read` 列表并跨源合并；未授权分区不可见
   - `--source-id` / `__all__` 等请求级参数不能越出 grant
7. **审计**：记录每次 tools/call（凭证 id、工具名、参数摘要、耗时）至结构化日志。

## 验证基线（集成测试断言）

- initialize → tools/list 返回非空工具面
- 写入：call `put_page`（slug 在栅栏内）成功；slug 越栅栏被拒
- 检索：federated-read [A,B] 凭证一次 search 命中 A、B 两源；仅 [A] 凭证对 B 内容不可见
- 吊销：DELETE /v1/keys/:id 后既有会话下一个请求 401
