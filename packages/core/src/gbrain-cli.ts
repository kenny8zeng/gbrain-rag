import { GBRAIN_CLI_DEFAULTS, type Config } from "./config";

/** CLI 非零退出 / 超时 */
export class CliError extends Error {
  constructor(
    readonly args: string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`gbrain ${args[0] ?? "cli"} exited with ${exitCode ?? "signal"}: ${cleanCliStderr(stderr).slice(0, 400)}`);
    this.name = "CliError";
  }
}

/**
 * 并发闸门拒绝（引擎容量已满，排队超时）。可重试——语义与 CliError 区分：
 * 前者是"命令失败"，后者是"暂时没位置"。
 */
export class CliBusyError extends Error {
  constructor(
    readonly args: string[],
    readonly waitedMs: number,
  ) {
    super(`gbrain ${args[0] ?? "cli"} busy: no slot within ${waitedMs}ms (concurrency limit reached)`);
    this.name = "CliBusyError";
  }
}

export interface CliInvocation {
  args: string[];
  /** GBRAIN_SOURCE 逐调用钉定（分区隔离的唯一入口，禁止通过 args 传 source） */
  source?: string;
  stdin?: string;
  timeoutMs?: number;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** 剥离引擎 CLI 输出噪声（升级提示/版本行/key 回退警告），保留真实错误尾段 */
function cleanCliStderr(raw: string): string {
  return raw
    .split("\n")
    .filter((l) => !/UPGRADE_AVAILABLE|-> \d+\.\d+\.\d+ available|Run: gbrain self-upgrade|^gbrain \d+\.\d+\.\d+/i.test(l))
    .filter((l) => !/^\[models\] /i.test(l))
    .join("\n")
    .trim();
}

// ─── 全局 CLI 并发闸门 ──────────────────────────────────────────────
// 每个 gbrain 调用都是一个独立进程：~1s 启动 CPU + 常驻内存（单文件 bun 二进制
// ~174MB），且 put 的存活期包含**外部 embed 调用**（秒级到数十秒）。
// 无上限并发会在容量受限的节点上互相踩踏——生产实测：批量导入下 CLI 排队
// 超过调用方超时被 SIGTERM（exit 143），连 `sources list` 这类纯读命令都开始
// 超时。故所有 spawn 收敛到此闸门（唯一入口）。

let cliActive = 0;
const cliWaiters: Array<{ grant: () => void }> = [];

function releaseSlot(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    cliActive--;
    cliWaiters.shift()?.grant();
  };
}

async function acquireSlot(limit: number, waitMs: number, args: string[]): Promise<() => void> {
  if (cliActive < limit) {
    cliActive++;
    return releaseSlot();
  }
  return await new Promise<() => void>((resolve, reject) => {
    let granted = false;
    const entry = {
      grant: () => {
        granted = true;
        clearTimeout(timer);
        cliActive++;
        resolve(releaseSlot());
      },
    };
    const timer = setTimeout(() => {
      if (granted) return;
      const i = cliWaiters.indexOf(entry);
      if (i >= 0) cliWaiters.splice(i, 1);
      reject(new CliBusyError(args, waitMs));
    }, waitMs);
    cliWaiters.push(entry);
  });
}

/** 测试用：观测/复位闸门状态 */
export function cliGateState(): { active: number; waiting: number } {
  return { active: cliActive, waiting: cliWaiters.length };
}

function buildEnv(inv: CliInvocation): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  if (inv.source !== undefined) env.GBRAIN_SOURCE = inv.source;
  return env;
}

/** spawn 白名单二进制（argv 直传不经 shell），非零退出抛 CliError */
export async function runGbrain(cfg: Config, inv: CliInvocation): Promise<CliResult> {
  // 防御性归一化：Config 理论上已校验，但局部构造的对象可能缺键——此时若按
  // undefined 限流（0 个槽）会让**所有**调用立刻 busy，属灾难性失败形态。
  const limit = Number.isFinite(cfg.GBRAIN_CLI_CONCURRENCY) && cfg.GBRAIN_CLI_CONCURRENCY! > 0
    ? cfg.GBRAIN_CLI_CONCURRENCY!
    : GBRAIN_CLI_DEFAULTS.concurrency;
  const waitMs = Number.isFinite(cfg.GBRAIN_CLI_QUEUE_WAIT_MS) && cfg.GBRAIN_CLI_QUEUE_WAIT_MS! > 0
    ? cfg.GBRAIN_CLI_QUEUE_WAIT_MS!
    : GBRAIN_CLI_DEFAULTS.queueWaitMs;
  const release = await acquireSlot(limit, waitMs, inv.args);
  try {
    // 超时只覆盖**执行**，不含排队等待（否则长队列会把执行预算吃光）
    const proc = Bun.spawn([cfg.GBRAIN_BIN, ...inv.args], {
      env: buildEnv(inv),
      stdin: inv.stdin !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(inv.timeoutMs ?? 120_000),
    });
    if (inv.stdin !== undefined && proc.stdin) {
      proc.stdin.write(inv.stdin);
      proc.stdin.end();
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new CliError(inv.args, exitCode, stderr);
    return { stdout, stderr, exitCode };
  } finally {
    release();
  }
}

/** 追加 --json 并解析输出（仅用于确认支持 --json 的命令） */
export async function runGbrainJson<T>(cfg: Config, inv: CliInvocation): Promise<T> {
  const r = await runGbrain(cfg, { ...inv, args: [...inv.args, "--json"] });
  return JSON.parse(r.stdout) as T;
}

/** 探测页面是否存在（exit 0 = 存在） */
export async function pageExists(cfg: Config, source: string, slug: string): Promise<boolean> {
  try {
    await runGbrain(cfg, { args: ["get", slug], source, timeoutMs: 30_000 });
    return true;
  } catch {
    return false;
  }
}
