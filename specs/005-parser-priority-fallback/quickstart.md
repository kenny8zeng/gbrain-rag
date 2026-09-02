# Quickstart: 005-parser-priority-fallback

## 前置

四实例矩阵（docs/testing-strategy 更新后）：

| 实例 | 配置 | 用途 |
|---|---|---|
| 3000 | docling 可用 + pref=docling | 主回归（101 项） |
| 3101 | DOCLING_URL 空 | us5（004 现状） |
| 3102 | docling 可用 + PARSER_PREFERENCE=anydoc | anydoc 优先 |
| 3103 | DOCLING_URL=不可达 + pref=docling | 回退触发 |

## 验证场景

### 1. docling 优先（3000，SC-004）

```bash
curl -s http://localhost:3000/health | jq '{parser_primary, parser_preference}'
# → {"parser_primary":"docling","parser_preference":"docling"}
# 上传 docx → 任务 done；查任务 parser_log == "docling"
```

### 2. anydoc 优先（3102，SC-004）

```bash
curl -s http://localhost:3102/health | jq '{parser_primary, parser_preference}'
# → {"parser_primary":"anydoc","parser_preference":"anydoc"}
# 上传 docx → done；parser_log == "anydoc"（常规 Office 不经 docling）
# URL 导入仍 202 → done（docling 路径可用）
```

### 3. 回退触发（3103，SC-001/002）

```bash
# docling 指向不可达（如 http://127.0.0.1:1）
curl -s http://localhost:3103/health | jq .parser_primary   # docling（首选配置不变）
# 上传 docx → done；parser_log 以 "docling→anydoc:" 开头（回退成功 + 链记录）
```

### 4. anydoc 唯一（3101，SC-003/005）

```bash
# us5 全绿（004 回归）；URL/图片 422 PARSER_UNAVAILABLE
```

### 5. 单测与回归

```bash
bun test tests/unit/fallback.test.ts tests/unit/parser.test.ts   # 确定性回退/链矩阵
TEST_BASE_URL=http://localhost:3000 ADMIN_TOKEN=... bun run test # 101 项零回归
```

## 验收对照

| Spec | 验证点 |
|---|---|
| SC-001 | 场景 3（docling 不可达回退成功） |
| SC-002 | 场景 3 parser_log 链记录 |
| SC-003 | 场景 4 + us6-priority 集成（3102/3103） |
| SC-004 | 场景 1/2 parser_primary 与 parser_log 断言 |
| SC-005 | 场景 4 + us6 URL 失败不回退断言（3103 URL → failed 无 anydoc 痕迹） |
