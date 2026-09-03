# Implementation Plan: OpenAI 兼容统一模型配置（干净重构）

**Branch**: `006-model-config-unified` | **Date**: 2026-09-03 | **Spec**: [spec.md](spec.md)

**Input**: 端点三要素心智 + 用户指令"清除旧的模型配置逻辑，不要堆屎山"

## Summary

把模型配置面重构为**端点三要素**（每能力 = `*_BASE_URL` + `*_MODEL` + `*_API_KEY`），仅支持 OpenAI 兼容 API；服务通过**配置时真实探测**（端点/型号/钥匙/能力/重排路径形态/输出维度）完成全部引擎适配。**删除全部旧配置逻辑**（PROVIDER 中间面、entrypoint bash 映射、供应商档案/白名单预检、引擎透传作为配置入口）——干净重构，不保留双轨兼容。

## Technical Context

**Language/Version**: TypeScript + Bun（现有 mono-repo：`packages/core` 无 HTTP / `apps/server` 装配）

**Primary Dependencies**: 现有（Hono + zod-openapi + gbrain CLI 子进程）；新增零依赖（探测用原生 fetch）

**Storage**: PostgreSQL（引擎 config DB 级——`config set` 目标不变）

**Testing**: `bun run test`（132 基线）；新增探测单元测试（mock fetch）

**Target Platform**: Linux 容器（现有 Dockerfile）

**Project Type**: web-service（monorepo）

**Performance Goals**: 探测仅发生在配置/启动时（一次性，秒级）；热路径零新增开销

**Constraints（用户拍板）**:
- **BREAKING：删除旧配置面**——PROVIDER 三要素（v1 中间产物，未发布）、entrypoint `map_env/map_model` bash 映射、model-profiles 供应商档案/白名单预检、引擎透传变量作为文档化入口，全部移除
- 中立字段名（`EMBEDDING_BASE_URL/MODEL/API_KEY/DIMENSIONS`、`RERANK_*`）**保留并成为新面**（其语义本就是端点三要素）
- 生产实例（Zeabur）配置在 006 发布时一次性迁移（维护者执行，用户无感）
- spec FR-010（旧格式兼容）被用户否决 → 替换为"单一面 + 发布时一次性迁移"
- spec FR-009（端点凭证跨能力复用）v1 简化：每能力显式三要素（重复填成本低、心智最简），复用不作自动推断

**Scale/Scope**: 配置面重构 + 探测模块 + 文档/测试/生产迁移

### 引擎槽位映射（实证事实，探测后内部执行）

| 用户能力 | 引擎槽位 | 机制（已实证） |
|---|---|---|
| chat | openrouter 槽 | `OPENROUTER_BASE_URL` env 可指向任意 OpenAI 兼容端点；chat 无白名单；模型 `openrouter:<纯名>`；key 值注入 `OPENROUTER_API_KEY` |
| embedding | llama-server 槽 | `LLAMA_SERVER_BASE_URL` 指向任意 OpenAI 兼容端点；无白名单（生产实证）；模型 `llama-server:<纯名>`；key 注入 `LLAMA_SERVER_API_KEY`；维度 = 探测默认输出（gbrain 不发 dimensions 参数） |
| rerank（探测 `/reranks`） | dashscope-rerank 槽 | config set `provider_base_urls.dashscope-rerank`（任意 URL）+ `search.reranker.model dashscope-rerank:<纯名>` + `enabled true`；key 注入 `DASHSCOPE_API_KEY` |
| rerank（探测 `/rerank` 单数） | llama-server-reranker 槽 | `LLAMA_SERVER_RERANKER_BASE_URL/API_KEY`；模型 `llama-server-reranker:<纯名>` |

## Constitution Check

无项目宪法约束（constitution.md 为占位模板）；遵循仓库既有纪律：core 无 HTTP 依赖、路由走 OpenAPI、测试纪律、用户中文沟通。无违反。

## Project Structure

### Documentation (this feature)

```text
specs/006-model-config-unified/
├── plan.md            # 本文件
├── research.md        # 探测协议实证汇总
├── data-model.md      # 配置实体模型
├── quickstart.md      # 验证指南
├── contracts/         # env schema / 探测协议 / API v2
└── tasks.md           # (/speckit.tasks 生成)
```

### Source Code（改造清单，沿用现有结构）

```text
packages/core/src/
├── config.ts                 # schema 重构：删除 PROVIDER 面/透传入口；保留并正式化端点三要素
├── model-router.ts           # 重写：端点三要素 → 引擎槽位派生（删除 PROVIDER 逻辑）
├── model-profiles.ts         # 删除（档案/白名单被探测替代）
├── model-config.ts           # 重写：就绪判定 = 每能力(端点+模型+key)；预检删白名单改缺口提示
├── endpoint-probe.ts         # 新增：真实探测（/models、/embeddings、rerank 路径形态、维度）
└── model-router-cli.ts       # 保留：entrypoint 调用派生（输出 export + config set 标记）

deploy/entrypoint.sh          # 删除 map_env/map_model；保留单点 TS 派生调用

apps/server/src/
├── index.ts                  # 自愈保留（config set 装配）
└── openapi/routes/model-admin.ts  # API v2：探测报告入响应；删档案引用

tests/unit/                   # model-profiles.test.ts 删除；model-router/probe/config 重写
docs/deployment.md §4         # 端点三要素唯一入口（删除档案/白名单/引擎变量讲解）
```

**Structure Decision**: 沿用现有 core/server 分层；不新增目录。

## Complexity Tracking

无宪法违规（干净重构为简方向，非增复杂度）。
