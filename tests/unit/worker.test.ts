import { describe, expect, test, afterEach } from "bun:test";
import { startWorker } from "../../apps/server/src/worker";
import type { DB } from "../../packages/core/src/db";
import type { Config } from "../../packages/core/src/config";
import type { IngestJob, IngestOutcome } from "../../packages/core/src/ingest/pipeline";

/**
 * Worker 队列单元测试（回归 001 的 worker 饿死缺陷）：
 * 用可编程 tagged-template 假 DB 断言认领 SQL、重试计数、并发不阻塞、回收扫描。
 */
interface SqlCall {
  text: string;
  values: unknown[];
}

interface FakeDb {
  calls: SqlCall[];
  /** 认领 UPDATE 的返回行（每次取一个，模拟队列） */
  claimRows: Array<Record<string, unknown>>;
  /** 记录 handler 启动/完成时间戳，断言并发交错 */
  handlerStarted: number[];
  handlerFinished: number[];
}

const cfg = {
  JOB_MAX_ATTEMPTS: 3,
  JOB_STALE_MS: 1_800_000,
  JOB_RETENTION_DAYS: 30,
} as Config;

function makeDb(): { db: DB; fake: FakeDb } {
  const fake: FakeDb = {
    calls: [],
    claimRows: [],
    handlerStarted: [],
    handlerFinished: [],
  };
  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    fake.calls.push({ text, values });
    // 认领是唯一含 FOR UPDATE SKIP LOCKED 的调用；shift 必须在分支内，
    // 否则 recoverStale/retention 等非认领调用会吞掉队列行（worker 行为断言失效）
    if (text.includes("FOR UPDATE SKIP LOCKED")) {
      const claim = fake.claimRows.shift();
      return Promise.resolve(claim ? [claim] : []);
    }
    return Promise.resolve([]);
  }) as unknown as DB;
  return { db, fake };
}

const JOB_A: Record<string, unknown> = { id: "job-a", kb_id: "kb-11111111", type: "md", source_ref: "x.md", title: null, attempts: 0 };
const JOB_B: Record<string, unknown> = { id: "job-b", kb_id: "kb-22222222", type: "md", source_ref: "y.md", title: null, attempts: 0 };

function toJob(r: Record<string, unknown>): IngestJob {
  return { id: String(r.id), kbId: String(r.kb_id), type: r.type as "md", sourceRef: String(r.source_ref), title: null };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("worker: 认领与状态机", () => {
  afterEach(() => {
    Bun.gc(true);
  });

  test("认领 SQL 特征（SKIP LOCKED / attempts 上限 / 排序）", async () => {
    const { db, fake } = makeDb();
    fake.claimRows = [JOB_A];
    const w = startWorker(cfg, db, async () => ({ status: "done", outcome: "created", docSlug: "s" }), { tickDelayMs: 5, concurrency: 1 });
    await delay(50);
    await w.stop();
    const claim = fake.calls.find((c) => c.text.includes("FOR UPDATE SKIP LOCKED"));
    expect(claim).toBeDefined();
    expect(claim!.text).toContain("attempts < ?");
    expect(claim!.text).toContain("ORDER BY created_at");
    expect(claim!.text).toContain("RETURNING *");
    expect(claim!.values).toContain(3); // JOB_MAX_ATTEMPTS
  });

  test("认领后执行 handler 并写入成功终态", async () => {
    const { db, fake } = makeDb();
    fake.claimRows = [JOB_A];
    let handled: IngestJob | null = null;
    const w = startWorker(cfg, db, async (job) => {
      handled = job;
      return { status: "done", outcome: "created", docSlug: "kb-11111111/docs/x" };
    }, { tickDelayMs: 5, concurrency: 1 });
    await delay(50);
    await w.stop();
    expect(handled).not.toBeNull();
    expect(handled!.id).toBe("job-a");
    const done = fake.calls.find((c) => c.text.includes("status = ?") && c.values.includes("done"));
    expect(done).toBeDefined();
    expect(done!.values).toContain("kb-11111111/docs/x");
  });

  test("handler 恒抛 → 重试计数达上限后 failed", async () => {
    const { db, fake } = makeDb();
    // 三次认领（attempts 0→1→2→3），每次 handler 抛错
    // RETURNING 行的 attempts = 认领后（1/2/3）；第三次 3 ≥ max → failed，不 requeue
    fake.claimRows = [{ ...JOB_A, attempts: 1 }, { ...JOB_A, attempts: 2 }, { ...JOB_A, attempts: 3 }];
    const w = startWorker(cfg, db, async () => {
      throw new Error("boom");
    }, { tickDelayMs: 5, concurrency: 1 });
    await delay(120);
    await w.stop();
    // requeue SQL 特征："status = 'queued', error"（failed SQL 亦含 error = ?，需排除）
    const requeued = fake.calls.filter((c) => c.text.includes("status = 'queued', error"));
    const failed = fake.calls.find((c) => c.text.includes("status = 'failed'"));
    expect(requeued.length).toBe(2); // attempts 1、2 后回队列
    expect(failed).toBeDefined(); // 第三次（attempts=3 ≥ max）终态 failed
    expect(failed!.values).toContain("boom");
  });

  test("慢任务不阻塞队列（并发 2）：后任务在慢任务完成前被认领", async () => {
    const { db, fake } = makeDb();
    fake.claimRows = [{ ...JOB_A, attempts: 0 }, { ...JOB_B, attempts: 0 }];
    const times: Record<string, { start: number; finish: number }> = {};
    const w = startWorker(cfg, db, async (job) => {
      times[job.id] = { start: Date.now(), finish: 0 };
      if (job.id === "job-a") await delay(150); // 慢任务
      times[job.id]!.finish = Date.now();
      return { status: "done", outcome: "created", docSlug: job.id };
    }, { tickDelayMs: 5, concurrency: 2 });
    await delay(300);
    await w.stop();
    // job-b 的 handler 在 job-a 完成之前启动（并发交错，而非串行等待）
    expect(Object.keys(times).sort()).toEqual(["job-a", "job-b"]);
    expect(times["job-b"]!.start).toBeLessThan(times["job-a"]!.finish);
  });

  test("启动期回收扫描：过期 running 重置为 queued（make_interval + stale 秒数）", async () => {
    const { db, fake } = makeDb();
    const w = startWorker(cfg, db, async () => ({ status: "done" }), { tickDelayMs: 5, concurrency: 1 });
    await delay(30);
    await w.stop();
    const recover = fake.calls.find((c) => c.text.includes("make_interval"));
    expect(recover).toBeDefined();
    expect(recover!.text).toContain("heartbeat_at < now() - make_interval");
    expect(recover!.values).toContain(1800); // JOB_STALE_MS / 1000
  });
});

void toJob;
