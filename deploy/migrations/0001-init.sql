-- rag_keys / rag_jobs：gbrain-rag 自有表（其余数据归 gbrain schema 管理）
CREATE TABLE rag_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash      TEXT NOT NULL UNIQUE,
  key_prefix    TEXT NOT NULL,
  label         TEXT NOT NULL UNIQUE,
  write_kb      TEXT,
  read_kbs      JSONB NOT NULL DEFAULT '[]',
  surface       TEXT NOT NULL DEFAULT 'starter',
  client_id     TEXT,
  client_secret TEXT,
  concurrency   INT NOT NULL DEFAULT 4,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ
);

CREATE TABLE rag_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_id        TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('file', 'url', 'md')),
  source_ref   TEXT NOT NULL,
  title        TEXT,
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'done', 'done_with_warnings', 'failed')),
  attempts     INT NOT NULL DEFAULT 0,
  error        TEXT,
  doc_slug     TEXT,
  outcome      TEXT CHECK (outcome IN ('created', 'updated')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ
);

CREATE INDEX rag_jobs_kb_status ON rag_jobs (kb_id, status);
CREATE INDEX rag_jobs_status_queued ON rag_jobs (status, created_at) WHERE status = 'queued';
