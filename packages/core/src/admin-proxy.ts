import { loadCliDirectory, type CliRoute, type CliSpec } from "cli2api/src/registry";
import { buildArgv } from "cli2api/src/argv";
import { runCli, Semaphore, encodeSse } from "cli2api/src/runner";

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
  sem: Semaphore;
}

export function loadAdminProxy(specsDir: string): AdminProxy {
  const { registry, errors } = loadCliDirectory(specsDir);
  if (errors.length > 0) {
    throw new Error(`invalid CLI specs: ${errors.join("; ")}`);
  }
  const spec = registry.list().find((s: CliSpec) => s.id === "gbrain");
  if (!spec) throw new Error(`gbrain spec not found in ${specsDir}`);
  return { spec, sem: new Semaphore(spec.maxConcurrency) };
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
      await runCli(proxy.spec, argv, proxy.sem, {
        signal: req.signal,
        onEvent: (e) => {
          if (e.type === "stdout") chunks.push(e.data);
          else if (e.type === "exit") exitCode = e.exitCode;
        },
      });
    } catch {
      return jsonErr(502, "CLI_FAILED", "admin CLI execution failed");
    }
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
      runCli(proxy.spec, argv, proxy.sem, {
        signal: req.signal,
        onEvent: (e) => controller.enqueue(encodeSse(e)),
      })
        .catch(() => undefined)
        .finally(() => controller.close());
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
