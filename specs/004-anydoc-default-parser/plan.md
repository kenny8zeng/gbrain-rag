# Implementation Plan: anydoc 作为默认文档解析器

**Branch**: `004-anydoc-default-parser` | **Date**: 2026-09-02 | **Spec**: [spec.md](./spec.md)

## Summary

`DOCLING_URL` 为空时，文件导入自动走进程内 anydoc（native，毫秒级）；url/图片导入明确拒绝并指引（Q1=A）。docling 配置时现状不变。OCR 为可选升级（env 开启）。健康检查以 `parser_mode` 如实表达当前解析模式。

## Technical Context

**Language/Version**: TypeScript on Bun 1.3+（同 001）

**Primary Dependencies**: `@firecrawl/anydoc`（新增，root 依赖，实测可用）

**Storage**: 无新增

**Testing**: 单元（解析器选择/错误映射/OCR 分支）+ 集成（默认模式 docx 全链路导入检索 + url/图片拒绝 + docling 模式零回归）

**Target Platform**: Linux Docker（debian bookworm-slim，NAPI glibc 兼容构建期验证）

**Constraints**: DOCLING_URL 空 = anydoc（仅文件）；url/图片需 docling；OCR 默认关闭（env 可选）；错误分类映射集中

**Scale/Scope**: 1 个解析器抽象 + 2 实现 + 错误映射 + health 字段 + ~8 测试

## Constitution Check

constitution 未批准模板 → 替代 gate：spec SC-001~005。Phase 0 已实测 npm 集成（D1），无未决澄清。Phase 1 复核：FR-002（docling 路径零回归）由全量既有测试保障——无违反项。

## Project Structure

```text
packages/core/src/ingest/
├── parser.ts          # 解析器接口 + 选择（DOCLING_URL 空 → anydoc）
├── anydoc-parser.ts   # native 转换 + 错误分类映射 + OCR 可选重试
└── docling.ts         # 现状（doclingParser 适配）
apps/server/src/openapi/routes/tenant.ts  # url/图片于 anydoc 模式 → 422 PARSER_UNAVAILABLE
apps/server/src/app.ts                    # /health 增加 parser_mode
tests/
├── unit/parser.test.ts          # 选择逻辑/错误映射/OCR 分支（mock code）
└── integration/us5-anydoc.test.ts  # 默认模式 docx 导入→检索 / url拒绝 / docling模式回归
tests/fixtures/test.docx          # 构造 fixture（含中文+表格）
deploy/.env.example               # FIRECRAWL_API_KEY（可选）注释
```

## Complexity Tracking

无违反项（单依赖新增 + 抽象层，Dockerfile 构建期验证 NAPI 加载）。
