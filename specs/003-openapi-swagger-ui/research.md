# Research: 003-openapi-swagger-ui

Phase 0 输出。spec 无 [NEEDS CLARIFICATION]；本文档解决技术选型。核查均于 2026-08-31 在本机环境完成。

## D1: 文档生成策略——OpenAPI 路由定义迁移

- **Decision**: 租户/管理面路由迁移到 `@hono/zod-openapi`（OpenAPIHono + 路由定义携带 Zod schema），文档由路由定义结构化生成；一致性校验测试作为第二道保险。
- **Rationale**: FR-004 零漂移的最强保证是"路由定义即文档源"。已核实 `@hono/zod-openapi@1.6.1` 需要 zod ^4 + hono ≥4.10（现 hono 4.13.5 满足，zod 3.25 需升级）。既有 Zod schema 均为简单形状（string/array/object/enum/coerce，约 8 处），v4 迁移面可控；36 项既有测试构成回归闸门。Hono `app.routes` 已核实可枚举（{method,path}），支撑漂移校验。
- **Alternatives considered**: (a) 手维护静态文档对象——即现状（13 路径仅摘要），已被 spec 判为精度不足且必然漂移； (b) 自建 manifest + `zod-to-json-schema`——schema 双份维护，回退路径保留（若 zod4 迁移摩擦超预算则切换，时间箱 0.5 天）。

## D2: zod v3→v4 升级

- **Decision**: 全仓 `zod@^4`，`bun add zod@^4 @hono/zod-openapi` 后以全量测试回归；已知差异点：`.url()` 类方法弃用为顶层 `z.url()`（v3 兼容层可用，逐步替换）、错误消息结构变化（现无断言依赖错误文案，仅断言 code）。
- **Rationale**: 官方升级路径；一次到位避免双版本并存。
- **Alternatives considered**: 停留 zod3 + zod-to-json-schema（见 D1 回退路径）。

## D3: Swagger UI 自托管

- **Decision**: `swagger-ui-dist` 声明为直接依赖（版本随锁文件），由服务静态路由分发页面资源；`/docs` 页面以多分组(urls 数组)方式加载三份描述（服务自有 /openapi.json + 引擎代理描述），全部同源。
- **Rationale**: spec FR-003/SC-003 要求零外部网络依赖；swagger-ui-dist 已存在于依赖图（cli2api 传递引入），升为直接依赖消除传递不确定性。cli2api 的 /docs 页面实现（urls 切换 + 静态白名单）为成熟同构参考。
- **Alternatives considered**: CDN 加载（现状，违反 SC-003，弃）；redoc（只读无"试一试"，不满足 FR-003 试用要求）。

## D4: 引擎代理描述分组

- **Decision**: 不迁移不改写：进程内已持有的引擎代理描述数据直接作为第二份描述文档在稳定地址透出，并在统一文档页 urls 中注册为独立分组。
- **Rationale**: 55 路由描述由上游 gen 脚本维护，本地重写即制造新漂移源；spec FR-002 明言"复用既有描述数据"。
- **Alternatives considered**: 合并进单一文档——引擎路由的参数形状（argv 映射语义）与服务面 schema 语义不同构，强合反而失真。

## D5: 流式接口标注

- **Decision**: 引擎代理描述数据中流式路由的响应说明保留其既有流式语义标注（缺失处由描述数据生成侧补一行"流式 SSE 输出"说明）；服务面无流式 REST 接口；MCP 网关端点在服务文档中以一行说明条目标注（指向 MCP 契约文档），不做 OpenAPI 化。
- **Rationale**: spec FR-005 如实标注即可；OpenAPI 对 SSE 无标准结构，伪装成普通 JSON 响应即失真。
- **Alternatives considered**: 将 MCP 端点从文档剔除——统一入口完整性受损，一行说明条目是平衡点。

## D6: 文档可见性

- **Decision**: 沿 spec 假设：描述与页面公开可读，不设文档级鉴权；部署方如需隐藏走网络层。
- **Rationale**: spec Assumptions 已定；避免为假设性需求预建开关。
- **Alternatives considered**: 环境变量开关 DOCS_PUBLIC——YAGNI，spec Out of Scope 明言推翻公开假设时另行立项。
