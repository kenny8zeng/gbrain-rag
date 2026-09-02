# Feature Specification: 文档解析优先级与回退

**Feature Branch**: `005-parser-priority-fallback`

**Created**: 2026-09-02

**Status**: Draft

**Input**: "修改文档解析功能：docling 配置时 anydoc 是优先还是回退可经环境变量设置；未配置 docling 时 anydoc 唯一并拒绝 URL/图片；更新测试方案与用例覆盖优先级。"

## 背景

004 确立了 `DOCLING_URL` 空 → anydoc 唯一的二选一模型。本特性将其演进为：docling 配置时**双解析器并存**（默认 docling 优先 + anydoc 回退；可切换 anydoc 优先），利用 anydoc 毫秒级本地能力与 docling 全能力（URL/图片/OCR/复杂版面）互补。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - docling 优先 + anydoc 回退（默认） (Priority: P1)

部署方配置了 docling（当前默认形态）。文件导入优先走 docling；docling 转换失败（服务不可达、超时、拒绝、空结果等）时自动以 anydoc 重试一次，任务仍成功，失败对调用方透明。URL 与图片导入走 docling（anydoc 无此能力，失败即任务失败，不产生半成品）。

**Why this priority**: 消除 docling 单点——其故障不再使文件导入全挂；本地回退保底。

**Independent Test**: 指向不可达的 docling 地址部署 → 上传 docx → 任务成功且内容可检索（anydoc 回退生效）；健康状态如实反映 docling 不可达。

**Acceptance Scenarios**:

1. **Given** docling 配置但服务不可达，**When** 上传 Word 文档，**Then** 任务成功（anydoc 回退），失败痕迹记录于任务（含原错误）。
2. **Given** docling 正常，**When** 上传文档，**Then** 由 docling 完成（回退不触发）。
3. **Given** docling 不可达，**When** 提交 URL 导入，**Then** 任务失败并记录原因（无回退可用），无半成品页面。

---

### User Story 2 - anydoc 优先 + docling 回退（环境变量切换） (Priority: P1)

部署方设置优先级 env（`PARSER_PREFERENCE=anydoc`）。文件导入直接走 anydoc（毫秒级本地）；anydoc 无法处理的（扫描 PDF、公式/复杂版面、超限等）自动回退 docling 重试一次。URL/图片导入仍走 docling。

**Why this priority**: 常规文档毫秒级本地转换（省外部服务流量），复杂文档自动升级 docling——性能与质量兼得。

**Independent Test**: anydoc 优先配置部署 → 上传 docx 秒级成功（anydoc 路径）；上传 anydoc 报 needsOcr 的扫描 PDF → 回退 docling 成功（需真实 docling 可用）。

**Acceptance Scenarios**:

1. **Given** `PARSER_PREFERENCE=anydoc`，**When** 上传 Office 文档，**Then** 任务成功且转换由 anydoc 完成（无 docling 调用痕迹）。
2. **Given** 同上配置，**When** 上传 anydoc 本地失败类型的文档（扫描 PDF），**Then** 自动回退 docling，任务成功且记录回退痕迹。
3. **Given** docling 亦失败，**Then** 任务 failed，错误为最终解析器的分类原因（含回退链）。

---

### User Story 3 - docling 未配置：anydoc 唯一（现状保留） (Priority: P1)

未配置 docling 时行为与 004 一致：文件导入 anydoc 唯一，URL 与独立图片导入明确拒绝（422 + 指引）。

**Acceptance Scenarios**:

1. **Given** 未配置 docling，**When** 上传文档文件，**Then** anydoc 处理成功。
2. **Given** 未配置 docling，**When** 提交 URL/图片，**Then** 422 PARSER_UNAVAILABLE 指引（004 契约不变）。

---

### User Story 4 - 优先级矩阵可观测与回归 (Priority: P2)

任务结果与健康检查如实反映实际生效的解析路径：任务记录含本次转换使用的解析器与回退链；健康检查暴露配置模式（docling 配置与否、优先级设置）。测试方案新增优先级矩阵用例，保证三模式（anydoc 唯一 / docling 优先 / anydoc 优先）行为不被后续改动破坏。

**Why this priority**: 双解析器路径的透明性与防回归是长期可维护前提。

**Acceptance Scenarios**:

1. **Given** 任一优先级模式，**When** 文件导入成功，**Then** 任务记录含本次解析器（docling/anydoc）与回退链（若有）。
2. **Given** 三模式配置各自部署，**When** 跑对应集成用例集，**Then** 全部通过（矩阵回归闸门）。

### Edge Cases

- docling 返回空 Markdown / 部分失败 → 视为失败触发回退（不产生半成品）
- 回退后仍失败 → 任务 failed，错误含两级原因与回退链说明
- URL/图片在 docling 失败 → 不向 anydoc 回退（能力缺失），failed 带原因；重试机制（既有 3 次）兜底
- 两个解析器均不可用（docling 未配置且 anydoc 加载失败）→ 文件导入明确报"无可用解析实现"
- md 直传不经解析器，各模式一致

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: docling 配置时，系统必须同时具备两个文件解析实现，并以环境变量设定的优先级选择首选（默认 docling 优先，可设 anydoc 优先）。
- **FR-002**: 首选解析器转换失败时，系统必须自动以另一解析器重试一次（仅文件类）；最终失败才标记任务 failed。
- **FR-003**: 任务记录必须包含本次实际使用的解析器与回退链（原错误摘要），失败原因含最终解析器分类与回退说明。
- **FR-004**: URL 与独立图片导入必须仅由 docling 处理（docling 失败即任务失败，不触发向 anydoc 的回退）。
- **FR-005**: docling 未配置时行为与 004 一致：文件 anydoc 唯一，URL/图片 422 PARSER_UNAVAILABLE 指引。
- **FR-006**: 健康检查必须如实暴露解析配置（docling 配置状态、当前优先级设置）。
- **FR-007**: 回退语义必须可配置关闭（强制单解析器模式保留，供测试与排障），测试方案含三模式矩阵回归用例。

### Key Entities

- **解析配置**: `DOCLING_URL`（开关）+ `PARSER_PREFERENCE`（docling|anydoc，docling 配置时生效）+ `PARSER_MODE`（auto|docling|anydoc，强制模式供测试）。
- **回退链（任务记录）**: 首选解析器 → 失败摘要 → 回退解析器 → 最终结果。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: docling 不可达时文件导入成功率与 docling 可用时一致（≥95%，20 份样本口径；anydoc 回退补偿）。
- **SC-002**: 回退路径端到端成功且任务记录含回退链（抽样 10 个回退任务 100% 有记录）。
- **SC-003**: 三模式（anydoc 唯一 / docling 优先 / anydoc 优先）各有独立通过的集成用例集（优先级矩阵回归绿）。
- **SC-004**: docling 可用时默认模式 docling 完成转换（回退触发率为 0 的抽样验证）；anydoc 优先模式下常规 Office 文档不经 docling。
- **SC-005**: URL/图片在 docling 失败时不产生 anydoc 回退尝试（行为断言）。

## Assumptions

- 回退触发条件 = 首选解析器的任何转换失败（HTTP 错误/超时/空结果/解析器错误码），不细分错误类型——简单且覆盖 needsOcr、docling 504 等真实场景；回退仅一次防循环。
- 回退痕迹记录于任务 error/元数据字段与结构化日志，不新增独立审计存储。
- 强制单解析器模式（PARSER_MODE=docling|anydoc）保留——测试隔离与故障排障需要，非回退语义的一部分。
- 优先级配置变更经重启生效（与既有配置机制一致）。

## Dependencies

- 004 的解析器抽象（Parser/UrlParser/resolveParser）与 anydoc 实现。
- 既有任务错误通道（rag_jobs.error）与重试机制。

## Out of Scope

- URL/图片的 anydoc 支持（能力边界不变）
- 逐文件/逐任务级优先级选择（优先级是部署级配置）
- 回退结果缓存（同一文件反复回退不做记忆）
- 解析器健康探测驱动的自动主备切换（超出"失败回退"语义）
