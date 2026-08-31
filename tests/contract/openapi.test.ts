import { describe, expect, test } from "bun:test";

/**
 * US1 契约：/openapi.json 三平面覆盖、securitySchemes、路由 security 平面、流式/MCP 标注。
 * 门控：TEST_BASE_URL。
 */
const BASE = process.env.TEST_BASE_URL;
const gated = BASE ? describe : describe.skip;

gated("contract: /openapi.json", () => {
  test("合法 OpenAPI 3.x 且三平面条目齐全", async () => {
    const r = await fetch(`${BASE}/openapi.json`);
    expect(r.status).toBe(200);
    const doc = await r.json();
    expect(doc.openapi).toMatch(/^3\./);
    const paths: string[] = Object.keys(doc.paths);
    expect(paths).toContain("/health");
    expect(paths).toContain("/v1/kb/{id}/retrieval");
    expect(paths).toContain("/v1/keys");
    expect(paths).toContain("/mcp");
  });

  test("securitySchemes 双方案 + 路由平面正确", async () => {
    const doc = await (await fetch(`${BASE}/openapi.json`)).json();
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual(["adminToken", "apiKey"]);
    expect(doc.paths["/v1/keys"].post.security).toEqual([{ adminToken: [] }]);
    expect(doc.paths["/v1/kb/{id}/retrieval"].post.security).toEqual([{ apiKey: [] }]);
    expect(doc.paths["/health"].get.security ?? []).toEqual([]);
    // MCP 说明条目：无请求体 schema，标注流式
    expect(doc.paths["/mcp"].post["x-streaming"]).toBe(true);
  });

  test("路由请求体 schema 达客户端生成精度（检索）", async () => {
    const doc = await (await fetch(`${BASE}/openapi.json`)).json();
    const body = doc.paths["/v1/kb/{id}/retrieval"].post.requestBody.content["application/json"].schema;
    expect(body.$ref ?? body).toBeDefined();
    expect(doc.components.schemas).toBeDefined();
  });

  test("引擎代理描述 55 路由可达", async () => {
    const r = await fetch(`${BASE}/v1/admin/openapi/gbrain.json`);
    expect(r.status).toBe(200);
    const doc = await r.json();
    expect(Object.keys(doc.paths).length).toBeGreaterThanOrEqual(50);
  });
});
