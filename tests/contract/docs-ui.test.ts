import { describe, expect, test } from "bun:test";

/**
 * US2 契约：/docs 自托管交互页 —— 零外链（SC-003）、静态资源白名单、双分组入口。
 * 门控：TEST_BASE_URL。
 */
const BASE = process.env.TEST_BASE_URL;
const gated = BASE ? describe : describe.skip;

gated("contract: /docs 与静态资源", () => {
  test("页面 200 且零外部资源引用", async () => {
    const r = await fetch(`${BASE}/docs`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("/openapi.json");
    expect(html).toContain("/v1/admin/openapi/gbrain.json");
    // 零外链：不允许任何 http(s) 绝对地址的资源引用
    expect(html).not.toMatch(/(src|href)=["']https?:\/\//);
  });

  test("静态资源白名单", async () => {
    const ok = await fetch(`${BASE}/swagger-ui/swagger-ui.css`);
    expect(ok.status).toBe(200);
    const bundle = await fetch(`${BASE}/swagger-ui/swagger-ui-bundle.js`);
    expect(bundle.status).toBe(200);
    const missing = await fetch(`${BASE}/swagger-ui/not-in-whitelist.js`);
    expect(missing.status).toBe(404);
  });
});
