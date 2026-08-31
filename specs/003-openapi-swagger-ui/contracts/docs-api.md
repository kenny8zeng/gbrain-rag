# Contract: 文档与页面（/openapi.json · /docs · /swagger-ui/* · 引擎描述地址）

公开可读（spec Assumptions）；全部同源自托管。鉴权语义由描述文档内的 securitySchemes 表达，文档与页面本身不要求鉴权。

## 稳定地址

| 地址 | 内容 | 契约要点 |
|---|---|---|
| `GET /openapi.json` | 服务描述（租户+管理面） | OpenAPI 3.x JSON；`paths` 与注册路由双向一致（FR-004）；`components.securitySchemes` 含 `adminToken`/`apiKey`；每个路由含 parameters/requestBody/responses schema |
| `GET /v1/admin/openapi/gbrain.json` | 引擎代理描述（既有数据） | 原样透出（允许流式说明补注）；独立稳定地址，供工具直取 |
| `GET /docs` | 统一交互文档页 | 多分组切换（服务 / 引擎代理）；页面与交互资源全部同源加载（零外链，SC-003） |
| `GET /swagger-ui/<file>` | 交互资源静态分发 | 仅暴露必要资源白名单（css/bundle/standalone-preset/favicon）；未列文件 404 |

## 行为契约

1. **鉴权豁免**：以上四个地址均不要求鉴权头；其余接口照常。
2. **流式标注**：引擎代理描述中的流式路由（SSE 输出）在其响应说明中含流式语义标注；服务描述中 MCP 网关以说明条目出现（无请求体 schema，描述指向 MCP 契约文档）。
3. **安全方案**：服务描述中，租户面路由 `security: [{apiKey: []}]`；管理面路由 `security: [{adminToken: []}]`；`/health`、`/openapi.json`、`/docs`、`/swagger-ui/*` 无 security。
4. **零外链**：`/docs` HTML 中不得出现外部网络资源引用（实现期以断言校验：页面内 `src=`/`href=` 全部同源相对路径）。

## 漂移校验契约（CI 闸门）

测试 `tests/contract/openapi-drift.test.ts`：

- 集合 A = 服务描述 `paths` 展开的 `{method, path}` 集合
- 集合 B = 应用注册路由集合（MCP 网关与文档/静态自身路由按白名单豁免——它们以说明条目/资源形式存在）
- 断言 A ⊆ B 且 B \ 白名单 ⊆ A；任一方向缺失即失败并打印差异项

## 错误与边界

- 未知静态资源文件 → 404（白名单外不分发）
- 引擎描述数据缺失（启动异常）→ 文档页仍可加载服务分组，引擎分组标记不可用（页面 urls 仅含可用项）
