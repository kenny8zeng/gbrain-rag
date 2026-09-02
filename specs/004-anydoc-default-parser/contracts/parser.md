# Contract: 解析器选择与错误语义（004）

## 解析器选择（启动期解析一次）

| 条件 | 生效解析器 | 通道 |
|---|---|---|
| `DOCLING_URL` 非空 | docling（HTTP 服务） | file（含图片）/ url / md |
| `DOCLING_URL` 为空 | anydoc（进程内 native） | **file（文档类）** / md |

## 租户面行为

- **file 导入**：两种模式均受理（202）；anydoc 模式支持 Word/PowerPoint/Excel/OpenDocument/RTF/EPUB/CSV/文本型 PDF；图片文件（jpg/png 等）在 anydoc 模式 → `422 {code:"PARSER_UNAVAILABLE", message:"图片导入需要配置 DOCLING_URL"}`。
- **url 导入**：anydoc 模式 → 同上 422 指引；docling 模式现状不变。
- **md 直传**：不经解析器，两模式一致。
- **失败分类**（任务 error 字段，anydoc 错误码映射）：
  - `needsOcr` → "扫描型 PDF，本地无 OCR；配置 FIRECRAWL_API_KEY 后可自动升级托管 OCR"
  - `unsupported` / `malformed` / `encrypted` / `resourceLimit` / `missingPart` / `io` → 对应中文原因 + 原始 code
  - OCR 已配置时 `needsOcr` 自动以 hosted OCR 重试一次，仍失败按 `hosted` 错误报

## 健康检查

`GET /health` 增加 `parser_mode: "docling" | "anydoc"`；`docling` 布尔保持原语义（未配置=false）。anydoc 模式不视作降级（status 计算不变，docling=false 仅当 docling 配置且不可达时影响 status）。

## 配置

- `FIRECRAWL_API_KEY`（可选）：配置后扫描 PDF 自动走托管 OCR
- `ANYDOC_OCR`（可选，默认 off）：显式开启 hosted OCR
- 配置变更经重启生效（与既有机制一致）
