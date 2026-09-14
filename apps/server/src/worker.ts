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
export interface WorkerOptions {
  /** 轮询间隔（测试可注入缩短） */
  tickDelayMs?: number;
  /** 并发循环数（测试可注入单循环） */
  concurrency?: number;
  /** 僵尸任务周期回收间隔（测试可注入短间隔） */
  recoverIntervalMs?: number;
}

export function startWorker(cfg: Config, db: DB, handler: (job: IngestJob) => Promise<IngestOutcome>, opts?: WorkerOptions): WorkerHandle {
  let stopped = false;
  const current = new Set<Promise<void>>();
  const tickDelayMs = opts?.tickDelayMs ?? 1_500;
  const concurrency = Math.max(1, opts?.concurrency ?? Number(process.env.WORKER_CONCURRENCY ?? 2));

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
              doc_slug = ${outcome.docSlug ?? null}, error = ${outcome.error ?? null},
              parser_log = ${outcome.parserLog ?? null}, updated_at = now()
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
    // 必须 await 到任务结束：否则 tick 认领后立即返回，循环每个 tickDelayMs 又认领一个，
    // 在飞任务数 = concurrency × (单任务耗时 / tickDelayMs) → 无界（每个任务都去抢 CLI 闸门，
    // 造成 CPU/内存饱和与读路径排队）。concurrency 即"同时在飞的任务数"上界。
    const p = run();
    current.add(p);
    try {
      await p;
    } finally {
      current.delete(p);
    }
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

    // 周期回收僵尸任务：只在启动期扫描会让"启动后才陈旧"的任务永久停留在 running
    // （表现：文档永不落库且无任何报错）。单条 UPDATE，代价可忽略。
    const recoverTimer = setInterval(
      () => void recoverStale().catch(() => undefined),
      opts?.recoverIntervalMs ?? 60_000,
    );
    recoverTimer.unref?.();

    const loops = Array.from({ length: concurrency }, async () => {
      while (!stopped) {
        try {
          await tick();
        } catch (e) {
          console.error(JSON.stringify({ evt: "worker_tick_error", error: (e as Error).message }));
          await delay(3_000);
        }
        await delay(tickDelayMs);
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
