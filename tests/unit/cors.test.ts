import { describe, expect, test } from "bun:test";
import { matchOrigin } from "../../packages/core/src/cors";
import { loadConfig, corsOrigins } from "../../packages/core/src/config";

describe("matchOrigin（纯函数）", () => {
  const origins = ["https://app.example.com", "https://app.example.com:8443"];

  test("空列表 = 特性关闭", () => {
    expect(matchOrigin([], "https://app.example.com")).toBeNull();
    expect(matchOrigin([], null)).toBeNull();
  });

  test("精确匹配回显来源（含端口）", () => {
    expect(matchOrigin(origins, "https://app.example.com")).toBe("https://app.example.com");
    expect(matchOrigin(origins, "https://app.example.com:8443")).toBe("https://app.example.com:8443");
  });

  test("未列来源（含同域名异端口/异 scheme）拒绝", () => {
    expect(matchOrigin(origins, "https://evil.example.com")).toBeNull();
    expect(matchOrigin(origins, "https://app.example.com:9443")).toBeNull();
    expect(matchOrigin(origins, "http://app.example.com")).toBeNull();
  });

  test("* 显式全放行", () => {
    expect(matchOrigin(["*"], "https://anything.example.com")).toBe("*");
  });

  test("尾斜杠忽略（浏览器 Origin 语义）", () => {
    expect(matchOrigin(["https://app.example.com"], "https://app.example.com/")).toBe("https://app.example.com");
  });
});

describe("CORS_ORIGINS 配置", () => {
  const base = {
    ADMIN_TOKEN: "test-token-0123456789",
    DATABASE_URL: "postgres://stub@127.0.0.1:5/stub",
    DOCLING_URL: "https://docling.test",
  };

  test("默认空 = 关闭", () => {
    const cfg = loadConfig(base as Record<string, string>);
    expect(corsOrigins(cfg)).toEqual([]);
  });

  test("逗号分隔解析与 * 放行", () => {
    const cfg = loadConfig({ ...base, CORS_ORIGINS: "https://a.example.com, *" } as Record<string, string>);
    expect(corsOrigins(cfg)).toEqual(["https://a.example.com", "*"]);
  });

  test("非法条目启动拒绝并指明", () => {
    expect(() =>
      loadConfig({ ...base, CORS_ORIGINS: "https://ok.example.com,not-an-origin" } as Record<string, string>),
    ).toThrow(/CORS_ORIGINS/);
  });
});
