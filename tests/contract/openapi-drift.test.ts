import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, copyFileSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { OpenAPIHono } from "@hono/zod-openapi";
import { loadConfig } from "../../packages/core/src/config";
import { connect, type DB } from "../../packages/core/src/db";
import { Upstream } from "../../packages/core/src/gbrain-upstream";
import { McpGateway } from "../../packages/core/src/mcp-gateway";
import { loadAdminProxy } from "../../packages/core/src/admin-proxy";
import { createApp, buildOpenApiDoc } from "../../apps/server/src/app";

/**
 * FR-004 / SC-002：服务描述 paths 与实际注册路由双向一致（零漂移）。
 * 纯构造测试：注册真实路由模块 + 桩 Services（处理器不执行）。
 */

const cfg = loadConfig({
  ADMIN_TOKEN: "test-token-0123456789",
  DATABASE_URL: "postgres://stub@127.0.0.1:5/stub",
  DOCLING_URL: "https://docling.test",
  GBRAIN_SERVE_ENABLED: "false",
} as Record<string, string>);

let db: DB;
let docPaths: string[];
let registeredPaths: string[];
let tmpDir: string;
// 白名单使用归一化形态（:param → {param}）：基础设施路由本身即文档/资源，不进业务描述
const WHITELIST = new Set([
  "/*", // cors 中间件注册的全局匹配（非业务端点）
  "/openapi.json",
  "/docs",
  "/swagger-ui/{file}",
  "/v1/admin/openapi/gbrain.json",
  "/v1/admin/gbrain/*",
]);

beforeAll(() => {
  // tmp 清理挂 afterAll（见文件尾）
  db = connect("postgres://stub@127.0.0.1:5/stub"); // 惰性连接，注册期不触达
  const upstream = new Upstream("http://127.0.0.1:1");
  const gateway = new McpGateway({
    baseUrl: "http://127.0.0.1:1",
    upstream,
    lookup: async () => null,
  });
  // 测试缝隙：spec 数据副本指向假二进制（宿主机无 gbrain；不改上游 cli2api 源码）
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "drift-clis-"));
  writeFileSync(path.join(tmpDir, "fake-gbrain"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(path.join(tmpDir, "fake-gbrain"), 0o755);
  const specYaml = readFileSync("./deploy/clis/gbrain.yaml", "utf8").replace(
    "binary: /usr/local/bin/gbrain",
    `binary: ${path.join(tmpDir, "fake-gbrain")}`,
  );
  writeFileSync(path.join(tmpDir, "gbrain.yaml"), specYaml);
  const adminProxy = loadAdminProxy(tmpDir);
  const app = createApp({
    cfg,
    db,
    upstream,
    gateway,
    adminProxy,
    lookupKey: async () => null,
    serveReady: () => false,
    doclingOk: async () => true,
    submitJob: async () => {
      throw new Error("not used in drift test");
    },
    retrieve: async () => {
      throw new Error("not used in drift test");
    },
    onKbCreated: async () => undefined,
    onKbPurged: async () => undefined,
  });

  const doc = buildOpenApiDoc(app);
  docPaths = Object.keys((doc.paths ?? {}) as Record<string, string>).sort();

  const norm = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  registeredPaths = [
    ...new Set(
      (app.routes ?? [])
        .map((r: { path: string }) => norm(r.path))
        .filter((p: string) => !WHITELIST.has(p)),
    ),
  ].sort();
  void WHITELIST;
});

afterAll(() => {
  if (typeof tmpDir === "string") rmSync(tmpDir, { recursive: true, force: true });
});

describe("FR-004 零漂移：文档 paths vs 注册路由", () => {
  test("文档中不存在未注册条目", () => {
    const extra = docPaths.filter((p) => !registeredPaths.includes(p));
    expect(extra).toEqual([]);
  });

  test("注册路由不存在文档缺失", () => {
    const missing = registeredPaths.filter((p) => !docPaths.includes(p));
    expect(missing).toEqual([]);
  });

  test("三平面分组均有条目（SC-001 形状）", () => {
    expect(docPaths).toContain("/health"); // system
    expect(docPaths).toContain("/v1/kb/{id}/retrieval"); // tenant
    expect(docPaths).toContain("/v1/keys"); // admin
    // 引擎代理面为独立描述文档（/v1/admin/openapi/gbrain.json，research D4），不在服务 paths 中
    expect(docPaths).toContain("/mcp"); // 说明条目
  });
});
