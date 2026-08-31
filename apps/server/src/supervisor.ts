import { existsSync } from "node:fs";
import type { Config } from "@core/config";

export interface Supervisor {
  /** serve 子进程 TCP 就绪（未启用时恒 false，/health 据此降级） */
  ready(): boolean;
  pid(): number | null;
  stop(): Promise<void>;
}

const NOOP: Supervisor = { ready: () => false, pid: () => null, stop: async () => undefined };

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function tcpProbe(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) });
    void res.body?.cancel();
    return true; // 任何 HTTP 响应（含 404/401）都证明端口就绪
  } catch {
    return false;
  }
}

/** 拉起 gbrain serve --http（回环），崩溃指数退避重启；GBRAIN_SERVE_ENABLED=false 或二进制缺失时为 NOOP */
export function startSupervisor(cfg: Config): Supervisor {
  if (!cfg.GBRAIN_SERVE_ENABLED || !existsSync(cfg.GBRAIN_BIN)) {
    console.log(JSON.stringify({ evt: "supervisor", mode: "disabled" }));
    return NOOP;
  }

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let stopping = false;
  let readyFlag = false;
  let backoffMs = 1_000;

  async function spawnServe(): Promise<void> {
    if (stopping) return;
    proc = Bun.spawn([cfg.GBRAIN_BIN, "serve", "--http", "--port", String(cfg.GBRAIN_SERVE_PORT)], {
      env: { ...process.env } as Record<string, string>,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    console.log(JSON.stringify({ evt: "supervisor", mode: "started", pid: proc.pid }));

    void new Response(proc.stdout as ReadableStream)
      .text()
      .then((t) => t && console.log(`[gbrain-serve] ${t.trim()}`));
    void new Response(proc.stderr as ReadableStream)
      .text()
      .then((t) => t && console.error(`[gbrain-serve] ${t.trim()}`));

    void proc.exited.then((code) => {
      readyFlag = false;
      if (stopping) return;
      console.error(JSON.stringify({ evt: "supervisor", mode: "exited", code, restartInMs: backoffMs }));
      setTimeout(() => void spawnServe(), backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    });

    // 就绪探测：TCP 可连即视为 ready
    const deadline = Date.now() + 30_000;
    while (!stopping && Date.now() < deadline) {
      if (await tcpProbe(cfg.GBRAIN_SERVE_PORT)) {
        readyFlag = true;
        console.log(JSON.stringify({ evt: "supervisor", mode: "ready" }));
        return;
      }
      await delay(300);
    }
  }

  void spawnServe();

  return {
    ready: () => readyFlag,
    pid: () => proc?.pid ?? null,
    stop: async () => {
      stopping = true;
      if (proc) {
        proc.kill();
        await proc.exited.catch(() => undefined);
      }
    },
  };
}
