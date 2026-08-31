import type { Config } from "@core/config";
import type { DB } from "@core/db";
import type { IngestJob, IngestOutcome } from "@core/ingest/pipeline";

export interface WorkerHandle {
  stop(): Promise<void>;
}

interface JobDbRow {
  id: string;
  kb_id: string;
  type: "file" | "url" | "md";
  source_ref: string;
  title: string | null;
  attempts: number;
}

function toJob(r: JobDbRow): IngestJob {
  return { id: r.id, kbId: r.kb_id, type: r.type, sourceRef: r.source_ref, title: r.title };
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * 摄取 worker：SKIP LOCKED 原子认领 + heartbeat + 启动期回收扫描。
 * attempts 在认领时自增；失败且 attempts < max 则回 queued（下次认领重试），否则 failed。
 */
export function startWorker(cfg: Config, db: DB, handler: (job: IngestJob) => Promise<IngestOutcome>): WorkerHandle {
  let stopped = false;
  const current = new Set<Promise<void>>();
  const concurrency = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 2));

  async function recoverStale(): Promise<void> {
    const seconds = Math.floor(cfg.JOB_STALE_MS / 1000);
    await db`
      UPDATE rag_jobs SET status = 'queued', updated_at = now()
      WHERE status = 'running'
        AND heartbeat_at < now() - make_interval(0, 0, 0, 0, 0, 0, ${seconds})
    `;
  }

  async function tick(): Promise<void> {
    const rows = await db`
      UPDATE rag_jobs SET status = 'running', heartbeat_at = now(), attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM rag_jobs
        WHERE status = 'queued' AND attempts < ${cfg.JOB_MAX_ATTEMPTS}
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `;
    if (rows.length === 0) return;
    const row = rows[0] as unknown as JobDbRow;
    const job = toJob(row);

    // 运行期心跳，防止长转换被回收扫描误判
    const hb = setInterval(() => {
      void db`UPDATE rag_jobs SET heartbeat_at = now() WHERE id = ${job.id} AND status = 'running'`;
    }, 15_000);

    const run = async (): Promise<void> => {
      try {
        const outcome = await handler(job);
        await db`
          UPDATE rag_jobs
          SET status = ${outcome.status}, outcome = ${outcome.outcome ?? null},
              doc_slug = ${outcome.docSlug ?? null}, error = ${outcome.error ?? null}, updated_at = now()
          WHERE id = ${job.id}
        `;
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        if (row.attempts < cfg.JOB_MAX_ATTEMPTS) {
          await db`UPDATE rag_jobs SET status = 'queued', error = ${msg}, updated_at = now() WHERE id = ${job.id}`;
        } else {
          await db`UPDATE rag_jobs SET status = 'failed', error = ${msg}, updated_at = now() WHERE id = ${job.id}`;
        }
        console.log(JSON.stringify({ evt: "job_error", job: job.id, attempt: row.attempts, error: msg.slice(0, 300) }));
      } finally {
        clearInterval(hb);
      }
    };
    const p = run();
    current.add(p);
    void p.finally(() => current.delete(p));
  }

  async function loop(): Promise<void> {
    await recoverStale();
    // 启动期与每日清理过期终态任务（SC/默认保留期）
    const runRetention = async () => {
      await db`
        DELETE FROM rag_jobs
        WHERE status IN ('done', 'done_with_warnings', 'failed')
          AND updated_at < now() - make_interval(0, 0, 0, ${cfg.JOB_RETENTION_DAYS})
      `;
    };
    void runRetention();
    const retentionTimer = setInterval(() => void runRetention(), 24 * 3600 * 1000);
    retentionTimer.unref?.();

    const loops = Array.from({ length: concurrency }, async () => {
      while (!stopped) {
        try {
          await tick();
        } catch (e) {
          console.error(JSON.stringify({ evt: "worker_tick_error", error: (e as Error).message }));
          await delay(3_000);
        }
        await delay(1_500);
      }
    });
    await Promise.all(loops);
  }

  const loopPromise = loop();

  return {
    stop: async () => {
      stopped = true;
      await loopPromise.catch(() => undefined);
      await Promise.allSettled([...current]);
    },
  };
}
