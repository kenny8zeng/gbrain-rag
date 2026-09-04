# Implementation Plan: 梦境周期调度（007）

**Branch**: `007-dream-cycle-scheduler` | **Date**: 2026-09-04 | **Spec**: [spec.md](spec.md)

**Input**: env 配置 supervisor 调 dream 定时与成本；手工触发 API；运行中拒绝新触发；文档同步。

## Summary

把引擎梦境周期（`gbrain dream`，8 阶段 cron-friendly）接入服务生命周期：env 配置开关/间隔/成本档（默认关），服务内定时触发；管理面 API 手工触发与状态查询；单实例运行锁（运行中拒绝新触发 + 超时自愈）；交付同步部署/使用/认证文档与双语 README、CHANGELOG。

## Technical Context

**Language/Version**: TypeScript + Bun（沿用现有 core/server 分层）

**Primary Dependencies**: 现有（无新增）；触发走 `packages/core/src/gbrain-cli.ts` runGbrain

**Storage**: 无需新表——运行锁进程内 + 时间戳（重启即清，天然满足孤儿恢复）；状态查询读内存

**Testing**: `bun run test`；新增单测（锁/调度纯逻辑，mock runGbrain）+ 契约（API 形状/409 拒绝，桩引擎）

**Target Platform**: Linux 容器（现有）

**Project Type**: web-service（monorepo）

**Performance Goals**: 触发开销 = 一次 CLI 进程；定时检查零热路径影响

**Constraints**:
- 默认关闭（零行为变化，向后兼容）；间隔按小时
- 成本档：light = 仅关系/时间线提取（`dream --phase extract`，无 LLM 合成）；full = 全 8 阶段（含 synthesize，耗 chat 模型）
- 单实例互斥（多副本 v1 外——assumption）；锁 = 进程内存 running 标志 + startedAt；服务重启自然清锁
- 触发/执行异步（后台 Promise，不阻塞 HTTP/worker）
- 引擎命令实证（容器内）：
  - `gbrain dream` 8 阶段：lint→backlinks→sync→synthesize→extract→patterns→embed→orphans；`--phase <name>` 单跑；`--dry-run`/`--json`
  - `gbrain extract links/timeline/all` 独立提取（mentions→图边 link_source='mentions'；--ner 需模型）
  - 当前无任何调度/API（已实证）

**Scale/Scope**: 调度器 + 2 个 admin API + 锁 + 测试 + 文档

## Constitution Check

无项目宪法约束（占位模板）；遵循仓库既有纪律（core 无 HTTP/路由走 OpenAPI/测试纪律/文档同步双语）。无违反。

## Project Structure

```text
specs/007-dream-cycle-scheduler/
├── plan.md            # 本文件
├── research.md        # dream 命令面实证
├── data-model.md      # 配置/运行/锁实体
├── quickstart.md      # 验证指南
├── contracts/         # env schema / API 契约
└── tasks.md           # (/speckit.tasks)

packages/core/src/
├── config.ts          # + DREAM_ENABLED/DREAM_INTERVAL_HOURS/DREAM_TIER
└── dream.ts           # 新增：DreamRunner（锁+触发+状态，runGbrain 执行）

apps/server/src/
├── supervisor.ts      # 集成：周期检查（间隔到点 → runner.maybeStart）
├── index.ts           # 装配 runner → Services
├── openapi/routes/dream-admin.ts  # 新增：POST/GET /v1/admin/dream
└── app.ts             # 注册路由；Services + runner 依赖

docs/deployment.md §env、docs/usage.md 管理面/错误码、docs/auth-model.md 覆盖、README 双语、CHANGELOG
tests/unit/dream.test.ts + tests/contract（门控）
```

**Structure Decision**: 沿用 core 纯逻辑 + server 装配；不新增目录。

## Complexity Tracking

无宪法违规；单实例锁为明确简化（assumption 记录，多副本后续演进）。
