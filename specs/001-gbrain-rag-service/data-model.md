# Data Model: 001-gbrain-rag-service

Phase 1 输出。自有持久化仅两张表；其余实体由 GBrain schema 管理，此处定义映射与约束。命名遵循 spec Key Entities。

## 实体

### 1. 知识库（Knowledge Base）→ GBrain source

| 属性 | 来源 | 约束 |
|---|---|---|
| id | 生成：`kb-<8hex>`（source id） | 唯一；前缀 `kb-` 保留给本项目 |
| name | 用户输入 | 非空，≤200 字符 |
| status | 本服务维护于内存/查询推导 | `active` / `archived` / `purged`（映射 sources 状态） |
| dir | `DATA_DIR/brains/<id>/` | git repo，sources add --path 指向 |
| page_count / embed_coverage / last_sync_at | `sources status --json` | 只读透出 |

状态迁移：`active → archived`（DELETE，72h 保留期起算）→ `purged`（显式 purge，不可逆）。归档态知识库：凭证请求一律 410。

### 2. Agent 凭证（rag_keys 表）

```sql
CREATE TABLE rag_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash      TEXT NOT NULL UNIQUE,          -- sha256("gbrag_<32hex>")
  key_prefix    TEXT NOT NULL,                 -- 前 8 字符，列表展示用
  label         TEXT NOT NULL,                 -- agent 名，唯一
  write_kb      TEXT,                          -- source id（kb-xxx），NULL=纯检索
  read_kbs      JSONB NOT NULL DEFAULT '[]',   -- source id 数组（含或不含 write_kb）
  surface       TEXT NOT NULL DEFAULT 'starter',
  client_id     TEXT,                          -- 上游 OAuth client（write_kb 或 read_kbs 非空时必有）
  client_secret TEXT,                          -- v1 明文（见 research D8 风险注记）
  concurrency   INT  NOT NULL DEFAULT 4,       -- MCP 网关逐凭证并发上限
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ
);
```

校验规则：`read_kbs` 引用的 source 必须存在且 active；`write_kb` ∈ read_kbs ∪ {NULL} 允许（写分区天然可读）；`label` 唯一。状态迁移：`active → revoked`（一次性，物理保留供审计）。明文 key 仅在签发响应出现一次。

### 3. 导入任务（rag_jobs 表）

```sql
CREATE TABLE rag_jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_id       TEXT NOT NULL,                 -- source id
  type        TEXT NOT NULL CHECK (type IN ('file','url','md')),
  source_ref  TEXT NOT NULL,                 -- file: 档案相对路径 / url: 网址 / md: slug 提示
  title       TEXT,                          -- 可选，覆盖派生标题
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','running','done','done_with_warnings','failed')),
  attempts    INT NOT NULL DEFAULT 0,        -- 上限 3
  error       TEXT,
  doc_slug    TEXT,                          -- 成功/更新后回填
  outcome     TEXT CHECK (outcome IN ('created','updated')),  -- FR-008 语义标注
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ                   -- running 心跳，回收扫描依据
);
CREATE INDEX rag_jobs_kb_status ON rag_jobs (kb_id, status);
```

状态迁移：

```text
queued ──认领(SKIP LOCKED)──▶ running ──┬─▶ done                (put+embed 成功)
   ▲                       │   ├─▶ done_with_warnings (embed 失败)
   │      attempts<3 重试  │   └─▶ failed            (转换/写入失败且重试耗尽)
   └───────────────────────┘
running(heartbeat > 30min) ──回收扫描──▶ queued
```

终态不可逆；`failed` 必有 `error`（转换 stderr / CLI stderr / docling status）。

### 4. 页面（Page）→ GBrain page

本服务不建表，经 CLI 操作。映射：slug = `<source-id>/docs/<派生名>`（导入）或 Agent 自定（栅栏 `<source-id>/*` 内）；frontmatter 由摄取管道注入 `title / kb / source_file|source_url / converted_at`。版本历史（FR-008 回滚兜底）由 `gbrain history <slug>` 原生提供。

### 5. 上游引擎凭证（逻辑实体）

每枚有效 rag_keys 记录对应一枚 gbrain OAuth client：`--source <write_kb>`（纯读时 `--source` 取 read_kbs[0] 且 `--scopes read`）、`--federated-read <read_kbs>`、`--bound-slug-prefixes <write_kb>/*`、`--surface <surface>`。生命周期与 rag_keys 行同步：签发=register、变更=rescope、吊销=revoke。access token 为运行时缓存（TTL 1h，401 触发刷新），不落库。

## 关系

- 知识库 1─N 页面（经 source 隔离）；知识库 1─N rag_jobs；知识库被 N 枚凭证引用（write_kb / read_kbs 成员）。
- 凭证 1─1 上游 client；凭证 1─N 并发会话（≤concurrency）。
- 删除知识库前置检查：枚举引用它的有效凭证并拒绝或要求联动吊销（契约见 contracts/rest-api.md）。
