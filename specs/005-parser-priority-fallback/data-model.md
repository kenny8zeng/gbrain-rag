# Data Model: 005-parser-priority-fallback

## 1. 解析链（运行时单例，resolver 缓存）

| 属性 | 说明 |
|---|---|
| mode | docling / anydoc（当前首选） |
| primary | FileParser：首选文件解析器 |
| fallback | FileParser \| null：回退（强制模式/anydoc 唯一时为 null） |
| url | UrlParser \| null：docling 独有能力 |

选择矩阵见 research D2。配置键：`DOCLING_URL` + `PARSER_PREFERENCE`（docling\|anydoc，默认 docling）+ `PARSER_MODE`（auto\|docling\|anydoc，强制）。

## 2. rag_jobs.parser_log（migration 0002）

`ALTER TABLE rag_jobs ADD COLUMN parser_log TEXT;`

| 场景 | parser_log 值 |
|---|---|
| primary 成功 | `"docling"` / `"anydoc"` |
| primary 失败 → fallback 成功 | `"docling→anydoc: <原错误摘要≤200字>"` |
| 双失败 / 无 fallback 失败 | null（error 列承载最终错误与链说明） |

校验：任务终态 done/done_with_warnings 时 parser_log 非空（primary 或链）。

## 3. 健康字段

| 字段 | 语义 |
|---|---|
| parser_mode | docling 配置态（004 保留：docling\|anydoc——anydoc 唯一实例为 anydoc） |
| parser_primary | 当前首选（docling\|anydoc，同 chain.mode） |
| parser_preference | PARSER_PREFERENCE 配置值（docling\|anydoc；docling 未配置时无意义） |

## 4. 回退链（任务记录内联语义）

```text
primary 抛错 → 记录原错误 → fallback（存在）→ 成功：parser_log="<primary>→<fallback>: <err>"
                                                → 失败：error="<fallback 错误>（primary 已失败: <err>）"
```
