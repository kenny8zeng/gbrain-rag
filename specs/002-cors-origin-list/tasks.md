# Tasks: 可选的跨域来源列表（CORS）

**Input**: Design documents from `/specs/002-cors-origin-list/`

## Phase 1: 实现

- [X] T001 [P] config.ts 增加 CORS_ORIGINS 解析与非法条目启动拒绝（zod refine）
- [X] T002 [P] 新建 packages/core/src/cors.ts：matchOrigin 纯函数（空=关闭 / * =全放行 / 精确匹配）
- [X] T003 新建 apps/server/src/middleware/cors.ts：Hono cors 中间件装配（origin 回调 + 头/方法/缓存声明）
- [X] T004 apps/server/src/app.ts 挂载 cors 中间件于全部路由与鉴权之前
- [X] T005 单元测试 tests/unit/cors.test.ts（匹配器 + 配置校验）
- [X] T006 契约测试 tests/contract/cors.test.ts（预检/回显/拒绝/免鉴权）
- [X] T007 部署配置：deploy/.env 与 .env.example 增加 CORS_ORIGINS 说明

## Phase 2: 验证

- [X] T008 单元 8/8 + 契约 4/4 全绿；既有全量回归无回归

## 验收对照

| Spec | 验证点 |
|---|---|
| SC-001 | 契约"放行回显 + 预检通过" |
| SC-002 | 契约"未列来源无头"（3 个来源抽样） |
| SC-003 | 单元"空列表零头" + 契约"未列来源服务照常处理" |
| SC-004 | 契约预检应答 197ms 量级（本地采样） |
