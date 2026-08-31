# Contract: Admin Proxy (`/v1/admin/gbrain/*`)

vendored cli2api（packages/cli2api）以库形态挂载，`clis/gbrain.yaml` 55 路由全部经 Hono 子路由暴露。鉴权统一为管理面 Bearer（cli2api 自身 API_TOKEN 机制由网关中间件替代，不再单独设 token）。

## 默认行为：SSE 流式

与上游 cli2api 语义一致：HTTP 请求 → argv（path/query/header 按 cli2api 映射规则）→ spawn 镜像内 `/usr/local/bin/gbrain`（上游项目的 `fixtures/gbrain` docker-exec wrapper 不随库迁移，本服务内 gbrain 为本地二进制）。响应 SSE：

```text
event: stdout
data: <chunk>

event: stderr
data: <chunk>

event: exit
data: {"exitCode":0,"reason":"exit","durationMs":123}
```

超时 kill、断开 kill、429 并发（maxConcurrency）、400/404/405 校验错误语义不变。

## 扩展行为：`?format=json`

仅对 spec 中标注 `x-cli.jsonArg` 的只读状态类路由生效（初版清单：sources list、sources status、sources archived、jobs list、jobs get、jobs stats、stats、health、features、storage status、engine status、auth clients）。带 `?format=json` 时：

1. runner 追加该路由声明的 JSON flag（如 `--json`）
2. 缓冲 stdout，不流式
3. exit 0 且输出可 JSON 解析 → `200 application/json`
4. exit 0 但解析失败 → `502 {"error":{"code":"UPSTREAM_NOT_JSON","raw":"<text>"}}`
5. exit ≠ 0 → `502 {"error":{"code":"CLI_FAILED","exitCode":N,"stderr":"..."}}`

未标注路由带 `?format=json` → 400 `FORMAT_NOT_SUPPORTED`。

## 白名单与安全

- binary 白名单锁定为镜像内 gbrain；argv 不经 shell，无注入面
- `[DESTRUCTIVE]` 标注路由（sources remove/purge、page delete、db-repair 等）在 OpenAPI description 保留标注；本代理不做二次确认，全部调用进结构化审计日志
- 单 CLI 并发上限沿用 `clis/gbrain.yaml` 的 `maxConcurrency`
