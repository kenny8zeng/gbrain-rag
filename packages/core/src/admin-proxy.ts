import { loadCliDirectory, type CliRoute, type CliSpec } from "cli2api/src/registry";
import { buildArgv } from "cli2api/src/argv";
import { runCli, Semaphore, encodeSse } from "cli2api/src/runner";

/**
 * 并发闸门（自愈）：对称 acquire/release + 60s 残留自动清空。
 * cli2api runCli 在部分异常/客户端断开路径可能不触发调用方预期的完成回调，
 * 长时间运行可能残留占用——自愈保证闸门不被永久占死（D14）。
 */
class ProxyGate {
  private count = 0;
  private since = 0;

  constructor(
    private readonly max: number,
    private readonly staleMs = 60_000,
  ) {}

  tryAcquire(): boolean {
    const now = Date.now();
    // 自愈：闸门占满超过 staleMs（远超任何单次 CLI 调用时长）→ 判定为残留并清空
    if (this.count >= this.max && this.since > 0 && now - this.since > this.staleMs) {
      this.count = 0;
      this.since = 0;
    }
    if (this.count >= this.max) return false;
    if (this.count === 0) this.since = now;
    this.count++;
    return true;
  }

  release(): void {
    if (this.count > 0) this.count--;
    if (this.count === 0) this.since = 0;
  }
}

/**
 * 只读状态类路由的 JSON 输出映射（key = `${method}|${argvPrefix.join(".")}`）。
 * format=json 语义在本网关实现，cli2api 上游零改动；提案合入后迁移至 spec 注记。
 */
const JSON_ROUTES: Record<string, string> = {
  "get|sources.list": "--json",
  "get|sources.status": "--json",
  "get|sources.archived": "--json",
  "get|jobs.list": "--json",
  "get|jobs.get": "--json",
  "get|jobs.stats": "--json",
  "get|stats": "--json",
  "get|health": "--json",
  "get|features": "--json",
  "get|storage.status": "--json",
  "get|engine.status": "--json",
  "get|auth.clients": "--json",
};

export interface AdminProxy {
  spec: CliSpec;
  /** 并发闸门（自愈 ProxyGate；与 runCli 内部释放解耦——cli2api runCli 异常/断开路径可能不完成，D14） */
  gate: ProxyGate;
  /** 供 runCli 释放的哑 semaphore（其无条件 release 不影响 gate 计数） */
  cliSem: Semaphore;
}

export function loadAdminProxy(specsDir: string): AdminProxy {
  const { registry, errors } = loadCliDirectory(specsDir);
  if (errors.length > 0) {
    throw new Error(`invalid CLI specs: ${errors.join("; ")}`);
  }
  const spec = registry.list().find((s: CliSpec) => s.id === "gbrain");
  if (!spec) throw new Error(`gbrain spec not found in ${specsDir}`);
  // gate 与 cliSem 分离：gate 由本模块对称 acquire/release（自愈）；
  // cliSem 仅供 runCli 内部 release（其 release 无 acquire 配对，负计数无害）
  return { spec, gate: new ProxyGate(spec.maxConcurrency), cliSem: new Semaphore(1) };
}

function findRoute(spec: CliSpec, method: string, subPath: string): CliRoute | undefined {
  return spec.routes.find((r) => r.method === method && r.regex.test(subPath));
}

function jsonErr(status: number, code: string, message: string, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: { code, message, ...extra } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleAdminRequest(proxy: AdminProxy, req: Request, mountPrefix: string): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method.toLowerCase();
  const subPath = url.pathname.slice(mountPrefix.length) || "/";

  const route = findRoute(proxy.spec, method, subPath);
  if (!route) return jsonErr(404, "NOT_FOUND", `no route ${method.toUpperCase()} ${subPath}`);

  // 并发闸门：本模块对称 acquire/release（不依赖 runCli 内部释放——其异常路径可能不 release，D14）
  if (!proxy.gate.tryAcquire()) {
    return jsonErr(429, "RATE_LIMITED", "admin CLI concurrency limit exceeded");
  }
  let gateHeld = true;
  const releaseGate = () => {
    if (gateHeld) {
      gateHeld = false;
      proxy.gate.release();
    }
  };

  const wantJson = url.searchParams.get("format") === "json";
  const jsonFlag = JSON_ROUTES[`${method}|${route.argvPrefix.join(".")}`];
  if (wantJson && !jsonFlag) {
    return jsonErr(400, "FORMAT_NOT_SUPPORTED", `route ${method.toUpperCase()} ${subPath} does not support format=json`);
  }

  let body: string | undefined;
  if (route.hasBody) {
    body = await req.text();
    if (route.bodyRequired && (body === undefined || body.length === 0)) {
      return jsonErr(400, "BAD_REQUEST", "request body is required");
    }
  }

  // buildArgv 只认 URL 查询参数；format=json 是网关自有参数，剔除后再组装
  const cleanUrl = new URL(url.toString());
  cleanUrl.searchParams.delete("format");
  const built = buildArgv(proxy.spec, route, cleanUrl, req.headers, body, subPath);
  if (!built.ok) {
    return jsonErr(400, "INVALID_PARAMS", built.error, { details: built.details });
  }
  const argv = wantJson ? [...built.argv, jsonFlag] : built.argv;

  if (wantJson) {
    const chunks: string[] = [];
    let exitCode: number | null = null;
    try {
      await runCli(proxy.spec, argv, proxy.cliSem, {
        signal: req.signal,
        onEvent: (e) => {
          if (e.type === "stdout") chunks.push(e.data);
          else if (e.type === "exit") exitCode = e.exitCode;
        },
      });
    } catch {
      releaseGate();
      return jsonErr(502, "CLI_FAILED", "admin CLI execution failed");
    }
    releaseGate();
    if (exitCode !== 0) {
      return jsonErr(502, "CLI_FAILED", `admin CLI exited with ${exitCode}`, { output: chunks.join("").slice(0, 2000) });
    }
    const text = chunks.join("");
    try {
      const parsed = JSON.parse(text) as unknown;
      return new Response(JSON.stringify(parsed), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      return jsonErr(502, "UPSTREAM_NOT_JSON", "admin CLI output is not valid JSON", { raw: text.slice(0, 2000) });
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      runCli(proxy.spec, argv, proxy.cliSem, {
        signal: req.signal,
        onEvent: (e) => controller.enqueue(encodeSse(e)),
      })
        .catch(() => undefined)
        .finally(() => {
          releaseGate();
          controller.close();
        });
    },
    cancel() {
      // 客户端断开：runCli 可能尚未 settle——立即释放闸门（D14）
      releaseGate();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
