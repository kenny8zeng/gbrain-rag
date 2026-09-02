-- 005：任务记录解析路径（primary / 回退链）
ALTER TABLE rag_jobs ADD COLUMN IF NOT EXISTS parser_log TEXT;
