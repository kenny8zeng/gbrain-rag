import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../packages/core/src/config";

const base = {
  ADMIN_TOKEN: "token-0123456789abcdef",
  DATABASE_URL: "postgres://gbrain:gbrain@localhost:5432/gbrain",
  DOCLING_URL: "https://docling.example.test",
};

describe("loadConfig", () => {
  test("必填缺失时抛错", () => {
    expect(() => loadConfig({} as Record<string, string>)).toThrow();
    expect(() => loadConfig({ DATABASE_URL: "x", DOCLING_URL: "https://x.test" } as Record<string, string>)).toThrow(/ADMIN_TOKEN/);
  });

  test("默认值注入", () => {
    const cfg = loadConfig(base as Record<string, string>);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.GBRAIN_BIN).toBe("/usr/local/bin/gbrain");
    expect(cfg.GBRAIN_SERVE_PORT).toBe(7333);
    expect(cfg.MCP_SURFACE).toBe("starter");
    expect(cfg.MCP_DEFAULT_CONCURRENCY).toBe(4);
    expect(cfg.JOB_MAX_ATTEMPTS).toBe(3);
    expect(cfg.MAX_UPLOAD_BYTES).toBe(104_857_600);
    expect(cfg.GBRAIN_SERVE_ENABLED).toBe(true);
  });

  test("显式覆盖生效", () => {
    const cfg = loadConfig({
      ...base,
      PORT: "8080",
      GBRAIN_SERVE_ENABLED: "false",
      MCP_SURFACE: "full",
      MAX_UPLOAD_BYTES: "1024",
    } as Record<string, string>);
    expect(cfg.PORT).toBe(8080);
    expect(cfg.GBRAIN_SERVE_ENABLED).toBe(false);
    expect(cfg.MCP_SURFACE).toBe("full");
    expect(cfg.MAX_UPLOAD_BYTES).toBe(1024);
  });
});
