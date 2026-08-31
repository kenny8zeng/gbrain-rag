# Contract: Admin Proxy (`/v1/admin/gbrain/*`)

cli2api 以 **bun git 依赖**引入（`github.com/kenny8zeng/cli2api`，锁定 tag，零源码改动），按库消费其 registry（路由匹配/argv 装配）与 runner（onEvent 执行）；挂载于 Hono 子路由，`deploy/clis/gbrain.yaml`（本地数据文件）55 路由全部暴露。鉴权统一为管理面 Bearer（cli2api 自身 API_TOKEN 机制由网关中间件替代，不再单独设 token）。

## 默认行为：SSE 流式

与上游 cli2api 语义一致：HTTP 请求 → argv（path/query/header 按 cli2api 映射规则）→ spawn 镜像内 `/usr/local/bin/gbrain`（上游 `fixtures/gbrain` 的 docker-exec wrapper 不适用，本服务内 gbrain 为本地二进制，spec 数据文件已改 binary 路径）。响应 SSE：

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

仅对网关内置 **JSON 路由表**中的只读状态类路由生效（初版清单：sources list、sources status、sources archived、jobs list、jobs get、jobs stats、stats、health、features、storage status、engine status、auth clients，各自映射 CLI 的 `--json` 类 flag）。带 `?format=json` 时：

1. 网关组装 argv 时追加该路由的 JSON flag（追加发生在我们的封装层，cli2api 源码零改动）
2. 经 runner 的 onEvent 回调缓冲 stdout，不流式
3. exit 0 且输出可 JSON 解析 → `200 application/json`
4. exit 0 但解析失败 → `502 {"error":{"code":"UPSTREAM_NOT_JSON","raw":"<text>"}}`
5. exit ≠ 0 → `502 {"error":{"code":"CLI_FAILED","exitCode":N,"stderr":"..."}}`

未列入路由表的路由带 `?format=json` → 400 `FORMAT_NOT_SUPPORTED`。该行为以提案反馈上游（jsonArg spec 注记 + binary 配置化），合入后迁移至上游实现。


## 白名单与安全

- binary 白名单锁定为镜像内 gbrain；argv 不经 shell，无注入面
- `[DESTRUCTIVE]` 标注路由（sources remove/purge、page delete、db-repair 等）在 OpenAPI description 保留标注；本代理不做二次确认，全部调用进结构化审计日志
- 单 CLI 并发上限沿用 `clis/gbrain.yaml` 的 `maxConcurrency`
