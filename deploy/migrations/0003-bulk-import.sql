-- 009：bulk 批量导入 —— 任务类型扩展 + 导入摘要
ALTER TABLE rag_jobs DROP CONSTRAINT IF EXISTS rag_jobs_type_check;
ALTER TABLE rag_jobs ADD CONSTRAINT rag_jobs_type_check CHECK (type IN ('file', 'url', 'md', 'bulk'));
ALTER TABLE rag_jobs ADD COLUMN IF NOT EXISTS result_summary TEXT;
