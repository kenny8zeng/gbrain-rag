# Research: 002-cors-origin-list

## D1: 中间件选型

- **Decision**: Hono 内置 `cors()` 中间件，`origin` 回调调用本项目纯函数 `matchOrigin`。
- **Rationale**: 内置中间件已实现预检短路（OPTIONS→204）、头集控制、maxAge；origin 回调支持动态匹配，恰好承载"列表精确匹配 + `*` 显式放行 + 未列拒绝"三种语义；零新依赖。
- **Alternatives**: 手写中间件（重复实现预检逻辑，无收益）。

## D2: 配置语义与校验

- **Decision**: `CORS_ORIGINS` 逗号分隔；空串=特性关闭（不产生任何 `Access-Control-*` 头）；`*`=全放行；条目按 origin 形态校验（`scheme://host[:port]`，无路径），非法条目启动期抛错并指明条目。
- **Rationale**: spec FR-001/FR-003/FR-006 直接映射；精确匹配按浏览器 Origin 头语义（含端口），尾斜杠/路径忽略。
- **Alternatives**: JSON 数组 env（过度）；运行时管理接口（spec Out of Scope）。

## D3: 契约要点

- 预检：`OPTIONS` + `Origin` 匹配来源 → 204 + `Access-Control-Allow-Origin` 回显 + 方法/头声明；不匹配 → 204 但无跨域头（或按 Hono 行为 204 无头）。
- 实际请求：匹配来源 → 响应带回显头；未匹配 → 无头（浏览器拒绝读取，服务端照常处理——spec FR-007 非浏览器零影响）。
- 中间件注册位置：`app.use("*", ...)` 位于全部路由与鉴权之前 → 预检先于鉴权（FR-005）、401/404 响应也带头（一致的浏览器行为）。

## D4: 测试分层

- 单元：`matchOrigin` 纯函数（空列表/精确/端口/`*`/非法条目启动拒绝）。
- 契约（门控 TEST_BASE_URL）：预检、放行回显、未列无头、OPTIONS 免鉴权。
- 空列表形态由单元测试覆盖（同一实例无法双配置）；部署 .env 配置 `CORS_ORIGINS=http://localhost:5173` 供契约测试使用。
