import type { Config } from "./config";

/** CLI 非零退出 / 超时 */
export class CliError extends Error {
  constructor(
    readonly args: string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`gbrain ${args.join(" ")} exited with ${exitCode ?? "signal"}: ${cleanCliStderr(stderr).slice(0, 500)}`);
    this.name = "CliError";
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
