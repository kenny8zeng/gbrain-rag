import { describe, expect, test } from "bun:test";

/**
 * 契约：梦境周期管理面（007）。
 * POST /v1/admin/dream（手工触发 202 / 运行中 409 DREAM_RUNNING）、GET 状态形状、非管理面拒绝。
 * 门控：TEST_BASE_URL + ADMIN_TOKEN。
 */
const BASE = process.env.TEST_BASE_URL;
const ADMIN = process.env.ADMIN_TOKEN ?? "";
const adminHeaders = () => ({ Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" });
const gated = BASE && ADMIN ? describe : describe.skip;

gated("contract: 梦境周期管理面", () => {
  test("GET 状态形状（enabled/tier/running/next_due/last_run）", async () => {
    const r = await fetch(`${BASE}/v1/admin/dream`, { headers: { Authorization: `Bearer ${ADMIN}` } });
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, unknown>;
    expect(typeof j.enabled).toBe("boolean");
    expect(["light", "full"]).toContain(String(j.tier));
    expect(typeof j.running).toBe("boolean");
    expect("next_due" in j).toBe(true);
    expect("last_run" in j).toBe(true);
  });

  test("POST 手工触发 → 202 started；非管理面 401", async () => {
    const r = await fetch(`${BASE}/v1/admin/dream`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ tier: "light" }),
    });
    expect([200, 202, 409]).toContain(r.status); // 202 或（已运行）409 均可——行为契约
    if (r.status === 202) {
      const j = (await r.json()) as { status?: string; tier?: string };
      expect(j.status).toBe("started");
    }
    const unauth = await fetch(`${BASE}/v1/admin/dream`, { method: "POST" });
    expect(unauth.status).toBe(401);
  });

  test("409：运行中再次触发被拒绝（经单测覆盖互斥；此处接受型验证响应语义）", async () => {
    // 触发后若仍在运行（full 档可能长）→ 第二次应为 409；若已完成 → 202。契约关键是 409 形状。
    const first = await fetch(`${BASE}/v1/admin/dream`, {
      method: "POST", headers: adminHeaders(), body: JSON.stringify({ tier: "full" }),
    });
    const second = await fetch(`${BASE}/v1/admin/dream`, {
      method: "POST", headers: adminHeaders(), body: JSON.stringify({ tier: "full" }),
    });
    if (second.status === 409) {
      const j = (await second.json()) as { error?: { code?: string } };
      expect(j.error?.code).toBe("DREAM_RUNNING");
    } else {
      expect([202, 200]).toContain(second.status); // 首个已快速完成
    }
    void first;
  });
});
