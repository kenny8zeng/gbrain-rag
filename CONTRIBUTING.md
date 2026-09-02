# 贡献指南

感谢您对 gbrain-rag 感兴趣。请阅读并遵守以下约定。

## 项目概览

gbrain-rag 是以 [GBrain](https://github.com/garrytan/gbrain) 为知识库核心的 RAG 知识库服务：统一入口聚合知识分区管理、多来源文档摄取（docling / anydoc 双解析器）、REST 检索与面向 AI Agent 的 MCP 网关。设计文档见 `specs/`（speckit 工作流产物），测试方案见 [docs/testing-strategy.md](docs/testing-strategy.md)。

## 开发环境

- [Bun](https://bun.sh) >= 1.3（唯一运行时，Node.js 不支持）
- 依赖安装：`bun install`
- 类型检查：`bun run typecheck`
- 单元测试：`bun test tests/unit`（无外部依赖，秒级）
- 全量测试：见下方"测试纪律"

## 架构约定

- `packages/core`：领域模块（无 HTTP 依赖）；`apps/server`：装配层；`packages` 内禁止反向依赖
- 路由以 OpenAPI 路由定义表达（`apps/server/src/openapi/routes/`），文档与注册零漂移由测试闸门保证——新路由必须走 `createRoute` 定义而非裸 Hono 注册
- 解析器经 `packages/core/src/ingest/parser.ts` 抽象接入（优先级/回退语义见 `specs/005-parser-priority-fallback/`）
- GBrain CLI 调用必须经 `gbrain-cli.ts` 封装（GBRAIN_SOURCE 钉定唯一入口），禁止旁路 spawn

## 测试纪律（强制）

测试体系定义见 [docs/testing-strategy.md](docs/testing-strategy.md)，核心规则：

1. **修 bug → 先补回归测试 → 再修代码**；缺陷台账（§4）随修复更新，禁止留下 ✗ 项宣称收敛
2. 全量执行入口**唯一**：`bun run test`（含 `--timeout 360000 --parallel=1`）——裸 `bun test` 的 5s 默认超时会误杀慢集成用例，文件并行会触发代理闸门竞争误报
3. 契约/集成测试需运行实例（docling 模式 3000 / 模式实例见策略 §3）；CI 中单元与类型检查先行
4. 禁止并行测试实例共享同一栈（worker 任务表交叉认领会假失败）

## 提交规范

- 提交信息：`<type>: <简述>`（type: feat/fix/docs/test/chore/perf/refactor）
- 中文或英文均可，描述行为变更而非过程；修复引用缺陷编号（如 D14）或提交上下文
- 一个提交一个逻辑变更；spec/plan/tasks 文档与代码同提交或紧邻提交

## Pull Request 流程

1. 从 `main` 切功能分支（或遵循仓库既有 speckit 分支约定）
2. 本地全量 `bun run test` 通过（需要时起测试实例）
3. 提交 PR：模板见 `.github/PULL_REQUEST_TEMPLATE.md`
4. 维护者评审：测试证据、缺陷台账更新、契约一致性（OpenAPI/契约文档）

## 行为准则

参与即同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
