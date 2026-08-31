import { describe, expect, test } from "bun:test";

/**
 * CORS 契约（spec FR-001~005）：预检免鉴权 204、放行回显、未列拒绝、实际请求带头。
 * 门控：TEST_BASE_URL；实例以 CORS_ORIGINS=http://localhost:5173 启动。
 */
const BASE = process.env.TEST_BASE_URL;
const ALLOWED = "http://localhost:5173";
const gated = BASE ? describe : describe.skip;

gated("contract: CORS", () => {
  test("放行来源预检：204 + 回显 + 方法/头声明，且免鉴权", async () => {
    const r = await fetch(`${BASE}/v1/kb`, {
      method: "OPTIONS",
      headers: { Origin: ALLOWED, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type, authorization" },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(r.headers.get("access-control-allow-methods")).toContain("POST");
    expect(r.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-api-key");
  });

  test("未列来源预检：无跨域放行头", async () => {
    const r = await fetch(`${BASE}/v1/kb`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com", "Access-Control-Request-Method": "POST" },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("放行来源实际请求：响应带头", async () => {
    const r = await fetch(`${BASE}/health`, { headers: { Origin: ALLOWED } });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe(ALLOWED);
  });

  test("未列来源实际请求：无跨域头但服务照常处理（FR-007）", async () => {
    const r = await fetch(`${BASE}/health`, { headers: { Origin: "https://evil.example.com" } });
    expect(r.status).toBe(200); // 服务端不受影响
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
});
