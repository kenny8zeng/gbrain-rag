# Implementation Plan: 文档解析优先级与回退

**Branch**: `005-parser-priority-fallback` | **Date**: 2026-09-02 | **Spec**: [spec.md](./spec.md)

## Summary

docling 配置时双解析器并存：`PARSER_PREFERENCE` 决定首选（默认 docling），文件转换失败自动回退另一解析器一次，任务记录 `parser_log` 暴露实际路径；docling 未配置时 anydoc 唯一（004 不变）；URL/图片永不走 anydoc。测试方案升级为四实例优先级矩阵。

## Technical Context

**Language/Version**: TypeScript on Bun（同 004）

**Primary Dependencies**: 004 解析器抽象（无新增依赖）

**Storage**: migration 0002（rag_jobs.parser_log TEXT）

**Testing**: 单测（convertWithFallback 注入故障确定性）+ 集成矩阵（3000/3101/3102/3103 四实例）

**Target Platform**: Linux Docker（compose.test.yaml 扩展）

**Constraints**: 回退仅一次；URL/图片不回退；强制模式（PARSER_MODE）不回退；回退链必须可观测

**Scale/Scope**: resolveChain 重构 + convertWithFallback + migration + health 字段 + 矩阵实例与测试

## Constitution Check

constitution 未批准模板 → 替代 gate：spec SC-001~005。Phase 0 决策无未决澄清；既有 101 项为 docling 可用默认路径零回归基线（3000 语义 docling 可用 → primary 成功 → 行为不变）。Phase 1 复核：parser_log 新增列与 health 字段为向后兼容扩展——无违反项。

## Project Structure

```text
packages/core/src/ingest/
├── parser.ts        # resolveParser → resolveChain（primary/fallback/url + 强制模式矩阵）
├── fallback.ts      # convertWithFallback：try primary → fallback 一次 → {md, used, fallbackFrom?}
├── anydoc-parser.ts # 不变
├── docling.ts       # 不变（doclingParser）
└── resolver.ts      # resolveParserFor 返回链
apps/server/src/openapi/routes/system.ts  # health + parser_primary/parser_preference
apps/server/src/worker.ts                  # 成功路径写 parser_log
deploy/migrations/0002-parser-log.sql      # rag_jobs.parser_log TEXT
deploy/compose.test.yaml                   # +3102（pref=anydoc）+3103（docling 不可达+pref=docling）
tests/
├── unit/fallback.test.ts          # 注入故障：primary 成功/回退成功/双失败链记录
├── unit/parser.test.ts 扩展       # 链矩阵（5 行）
├── integration/us6-priority.test.ts  # 3102/3103 断言（parser_log 与回退链）
docs/testing-strategy.md           # 四实例矩阵更新
```

## Complexity Tracking

无违反项（无新依赖、单列迁移、抽象演进）。
