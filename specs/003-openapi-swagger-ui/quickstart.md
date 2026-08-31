# Quickstart: 003-openapi-swagger-ui

## 前置

compose 栈运行中（见 001 quickstart）；浏览器可达 `http://localhost:3000`。

## 验证场景

### 1. 机器可读描述（US1 / SC-001）

```bash
curl -s http://localhost:3000/openapi.json | jq '.info, .paths | keys | length'
curl -s http://localhost:3000/openapi.json | jq '.components.securitySchemes | keys'
curl -s http://localhost:3000/v1/admin/openapi/gbrain.json | jq '.paths | keys | length'   # 55
```

预期：服务描述含租户/管理/系统三组路径且 securitySchemes 两项；引擎描述 55 路由。

抽样调用一致性：任取文档中 3 个接口（每平面至少 1 个）按文档参数真实调用，行为与文档一致（例：`/v1/kb/{id}/retrieval` 按文档体调用；`/v1/keys` 缺鉴权头应得文档声明的 401）。

### 2. 交互文档页（US2 / SC-003）

浏览器打开 `http://localhost:3000/docs`：

- 分组切换可见"服务接口"与"引擎代理"两组
- Authorize 填入 `ADMIN_TOKEN`（Bearer）→ 对 `GET /health` 试一试 → 页面内出现真实 200 响应
- 断网验证：浏览器 DevTools Network 过滤非 `localhost:3000` 的请求 → 页面加载与试用全程无外部请求

### 3. 零漂移闸门（US3 / SC-002）

```bash
bun run test tests/contract/openapi-drift.test.ts
```

预期：通过。破坏性验证：临时在路由注册中加一条未进文档的路由（或反向）→ 校验失败并打印差异项 → 还原。

### 4. 回归

```bash
TEST_BASE_URL=http://localhost:3000 ADMIN_TOKEN=... bun run test   # 全量 36 项既有测试 + 新增文档测试全绿（zod v4 迁移零回归）
```

## 验收对照

| Spec | 验证点 |
|---|---|
| SC-001 | 场景 1 抽样调用 |
| SC-002 | 场景 3 + 全量回归 |
| SC-003 | 场景 2 断网验证 |
| SC-004 | 场景 2 首次调用完成时间 |
