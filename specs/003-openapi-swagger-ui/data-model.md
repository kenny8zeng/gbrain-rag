# Data Model: 003-openapi-swagger-ui

无新增持久化实体。本特性核心是三份"描述文档"的结构契约与一条路由清单的映射关系。

## 1. 服务接口描述（Service OpenAPI Document）

运行时生成的 OpenAPI 3.x 对象：

| 字段 | 内容 | 来源 |
|---|---|---|
| `info` | `{ title: "gbrain-rag", version }` | 应用版本 |
| `servers` | `[{ url: "/" }]` | 部署相对根 |
| `paths` | 租户面 + 管理面全部注册路由，含 parameters / requestBody / responses（引用 components.schema） | OpenAPI 路由定义（唯一事实源） |
| `components.securitySchemes` | `adminToken`（http bearer）、`apiKey`（header X-API-Key） | 两个鉴权平面 |
| `paths[*].security` | 按路由所属平面引用对应 scheme；health/openapi/docs 公开无 security | 路由定义平面标注 |
| `tags` | `tenant` / `admin` / `system` 分组 | 路由定义分组标注 |

校验规则（drift test 断言）：`paths` 键集合 ≡ Hono 路由注册集合（双向）；MCP 网关端点以说明条目存在（不含请求体 schema）。

## 2. 引擎代理描述（Engine Proxy Document）

既有 55 路由描述数据，原样透出（不重写）。消费方式：稳定地址响应 + 统一文档页第二分组。本特性唯一允许的加工：为缺失流式标注的流式路由补一行说明（D5）。

## 3. 路由清单映射

```text
注册事实（Hono app.routes: {method, path}[]）
  ↕ 双向一致（drift test）
服务描述 paths（/openapi.json）
  ↕ 分组引用
统一文档页 urls = [服务描述, 引擎代理描述]
```

## 4. 文档页（/docs）

自托管页面：加载同源交互资源 → 按 urls 渲染分组（服务 / 引擎代理）→ 支持录入 `Bearer`/`X-API-Key` 后在线执行。页面自身不承载接口语义（语义全部在描述文档中），故无漂移面。
