import { SQL } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type DB = SQL;

export function connect(url: string): DB {
  return new SQL(url, { max: 10, idleTimeout: 30 });
}

/**
 * 按文件名序执行 deploy/migrations/*.sql，记录于 _rag_migrations，幂等。
 * 每个文件按 ";\n" 切分语句顺序执行（本项目的迁移不含函数/触发器等复杂体）。
 */
export async function migrate(db: DB, dir: string): Promise<string[]> {
  await db`CREATE TABLE IF NOT EXISTS _rag_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  const appliedRows = await db`SELECT name FROM _rag_migrations`;
  const applied = new Set(appliedRows.map((r: { name: string }) => r.name));

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const appliedNow: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const content = readFileSync(path.join(dir, f), "utf8");
    const statements = content
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    await db.begin(async (tx) => {
      for (const stmt of statements) {
        await tx.unsafe(stmt);
      }
      await tx`INSERT INTO _rag_migrations (name) VALUES (${f})`;
    });
    appliedNow.push(f);
  }
  return appliedNow;
}
