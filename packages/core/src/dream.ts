import type { Config } from "./config";
import { runGbrain } from "./gbrain-cli";

/**
 * 梦境周期调度（DreamRunner）：supervisor 生命周期内的单实例运行器。
 * - 触发：定时（scheduler 到点调 maybeScheduled）或管理面 API（start 手工）
 * - 成本档：light = 仅关系/时间线提取（dream --phase extract，无 LLM 合成）；full = 全部维护阶段
 * - 互斥：进程内存锁——运行中任何新触发被拒（定时跳过顺延、手工 409）；超时强杀解锁；重启自清
 * - 引擎命令实证（gbrain v0.47.6.0）：`gbrain dream [--phase <name>] [--json]`
 *   8 阶段：lint→backlinks→sync→synthesize→extract→patterns→embed→orphans
 */

export const DREAM_TIMEOUT_MS = 4 * 3600 * 1000; // 超时上限：防挂死永久锁

export type DreamTier = "light" | "full";
export type DreamTrigger = "scheduled" | "manual";

export interface DreamRunSummary {
  at: string;
  ok: boolean;
  tier: DreamTier;
  summary: string;
}

export interface DreamStatus {
  enabled: boolean;
  tier: DreamTier;
  intervalHours: number;
  running: boolean;
  startedAt: string | null;
  nextDue: string | null;
  lastRun: DreamRunSummary | null;
  lastError: string | null;
}

export class DreamRunner {
  private running = false;
  private startedAt: number | null = null;
  private nextDue: number | null = null;
  private lastRun: DreamRunSummary | null = null;
  private lastError: string | null = null;
  private tier: DreamTier;
  private readonly intervalMs: number;
  private readonly enabled: boolean;
  /** 依赖注入（可测）：默认 runGbrain；测试替换为 mock */
  private readonly exec: (args: string[]) => Promise<{ stdout: string; exitCode: number }>;

  constructor(
    private readonly cfg: Config,
    deps?: { exec?: (args: string[]) => Promise<{ stdout: string; exitCode: number }> },
  ) {
    this.enabled = cfg.DREAM_ENABLED === "true";
    const h = Number(cfg.DREAM_INTERVAL_HOURS);
    this.intervalMs = (Number.isFinite(h) && h > 0 ? h : 24) * 3600 * 1000;
    this.tier = cfg.DREAM_TIER === "full" ? "full" : "light";
    this.exec = deps?.exec ?? (async (args) => {
      try {
        const r = await runGbrain(cfg, { args, timeoutMs: DREAM_TIMEOUT_MS });
        return { stdout: r.stdout, exitCode: 0 };
      } catch (e) {
        return { stdout: String((e as Error).message ?? e), exitCode: 1 };
      }
    });
    if (this.enabled) this.scheduleNext(Date.now() + this.intervalMs);
  }

  private scheduleNext(from: number): void {
    this.nextDue = from;
  }

  get intervalHours(): number {
    return Math.round(this.intervalMs / 3600_000);
  }

  private dreamArgs(tier: DreamTier): string[] {
    return tier === "light" ? ["dream", "--phase", "extract", "--json"] : ["dream", "--json"];
  }

  /** 尝试启动一次（共享锁：running 拒绝）。返回是否已接受。 */
  async start(trigger: DreamTrigger, tier?: DreamTier): Promise<{ accepted: boolean; reason?: string }> {
    if (this.running) return { accepted: false, reason: `dream cycle already running (started at ${new Date(this.startedAt!).toISOString()})` };
    const useTier = tier ?? this.tier;
    this.running = true;
    this.startedAt = Date.now();
    this.lastError = null;
    console.log(JSON.stringify({ evt: "dream_started", tier: useTier, trigger }));
    void this.run(useTier).then(() => {
      // 完成后推进下轮
      if (this.enabled) this.scheduleNext(Date.now() + this.intervalMs);
    });
    return { accepted: true };
  }

  /** 定时到点触发：running 则跳过本轮（顺延在 run 完成/或此处推进） */
  async maybeScheduled(): Promise<void> {
    if (!this.enabled || this.nextDue === null || Date.now() < this.nextDue) return;
    if (this.running) {
      console.log(JSON.stringify({ evt: "dream_rejected", reason: "running", trigger: "scheduled" }));
      this.scheduleNext(Date.now() + this.intervalMs); // 跳过本轮，顺延
      return;
    }
    await this.start("scheduled");
  }

  private async run(tier: DreamTier): Promise<void> {
    const t0 = Date.now();
    try {
      const res = await this.exec(this.dreamArgs(tier));
      const ok = res.exitCode === 0;
      const summary = ok ? summarizeDream(res.stdout) : res.stdout.slice(0, 300);
      this.lastRun = { at: new Date().toISOString(), ok, tier, summary };
      if (!ok) this.lastError = summary;
      console.log(JSON.stringify({ evt: ok ? "dream_done" : "dream_error", tier, ms: Date.now() - t0, ok, summary: summary.slice(0, 200) }));
    } catch (e) {
      this.lastError = (e as Error).message.slice(0, 300);
      this.lastRun = { at: new Date().toISOString(), ok: false, tier, summary: this.lastError };
      console.log(JSON.stringify({ evt: "dream_error", tier, ms: Date.now() - t0, ok: false, error: this.lastError }));
    } finally {
      this.running = false;
      this.startedAt = null;
    }
  }

  status(): DreamStatus {
    return {
      enabled: this.enabled,
      tier: this.tier,
      intervalHours: this.intervalHours,
      running: this.running,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      nextDue: this.nextDue ? new Date(this.nextDue).toISOString() : null,
      lastRun: this.lastRun,
      lastError: this.lastError,
    };
  }
}

/** 从 dream --json CycleReport 提炼一行摘要（阶段计数） */
function summarizeDream(stdout: string): string {
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>;
    const parts: string[] = [];
    const pick = (key: string) => {
      const v = j[key];
      if (v !== undefined && v !== null) {
        const s = typeof v === "object" ? JSON.stringify(v) : String(v);
        if (s.length < 80) parts.push(`${key}=${s}`);
      }
    };
    for (const k of Object.keys(j).slice(0, 8)) pick(k);
    return parts.join(" ") || stdout.slice(0, 120);
  } catch {
    return stdout.slice(0, 120);
  }
}
