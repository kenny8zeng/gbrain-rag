# Contract: 解析优先级与回退（005）

## 配置语义

| env | 取值 | 生效 |
|---|---|---|
| DOCLING_URL | URL / 空 | 空 = anydoc 唯一（URL/图片 422，004 不变） |
| PARSER_PREFERENCE | docling（默认）\| anydoc | 仅 DOCLING_URL 配置时生效：并存首选 |
| PARSER_MODE | auto（默认）\| docling \| anydoc | docling/anydoc = 强制单解析器（无回退，测试/排障） |

## 文件导入行为矩阵

| 场景 | 尝试顺序 | 成功记录（parser_log） | 失败语义 |
|---|---|---|---|
| docling 可用 + pref=docling | docling →（失败）anydoc | `docling` / `docling→anydoc: …` | 双失败 → failed（error 含链） |
| docling 可用 + pref=anydoc | anydoc →（失败）docling | `anydoc` / `anydoc→docling: …` | 同上 |
| docling 不可达 + pref=docling | docling（必然失败）→ anydoc | `docling→anydoc: …` | anydoc 亦失败 → failed |
| docling 未配置 | anydoc（唯一） | `anydoc` | failed（无回退） |
| PARSER_MODE=docling（强制） | docling（不回退） | `docling` | failed（无回退） |
| PARSER_MODE=anydoc（强制） | anydoc（不回退） | `anydoc` | failed（无回退） |

## URL/图片导入

- 恒走 docling（URL 配置时）；失败 = 任务 failed（**不回退 anydoc**，FR-004），由既有 attempts=3 重试兜底
- docling 未配置 → 422 PARSER_UNAVAILABLE（004 契约不变）

## 回退触发与终止

- 触发：primary 任何转换失败（HTTP 错误/超时/空 md/解析器错误码）
- 终止：回退仅一次（链结构保证）；回退后失败即 failed
- docling 返回空 md 视为失败（触发回退），不产生半成品

## 健康检查

`/health`：`parser_mode`（004 语义）+ `parser_primary`（首选）+ `parser_preference`（配置）+ `docling`（布尔）——四字段组合如实表达配置与生效路径。

## 任务可观测

- 成功：`parser_log` 非空（primary 或链）
- 失败：`error` 含最终解析器分类与回退链说明（如 "docling 失败(超时) 已回退 anydoc，anydoc 亦失败(needsOcr)"）
