import { describe, expect, test } from "bun:test";

/**
 * 引擎代理面契约补全（testing-strategy §8 缺口）：
 * SSE 事件形态（stdout/exit）、429 并发上限（cli2api maxConcurrency）。
 * 门控：TEST_BASE_URL + ADMIN_TOKEN。
 */
const BASE = process.env.TEST_BASE_URL;
const ADMIN = process.env.ADMIN_TOKEN ?? "";
const gated = BASE && ADMIN ? describe : describe.skip;

gated("contract: admin proxy SSE 与并发", () => {
  test("SSE 事件形态：stdout + exit 出现", async () => {
    const r = await fetch(`${BASE}/v1/admin/gbrain/list?limit=1`, { headers: { Authorization: `Bearer ${ADMIN}` } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const body = await r.text();
    expect(body).toContain("event: stdout");
    expect(body).toContain("event: exit");
    expect(body).toMatch(/"exitCode":0/);
  });

  test("并发超限 → 429（gbrain spec maxConcurrency=1）", async () => {
    // 三路并发 format=json（各含 gbrain CLI 进程启动，重叠窗口充足）
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        fetch(`${BASE}/v1/admin/gbrain/sources/list?format=json`, {
          headers: { Authorization: `Bearer ${ADMIN}` },
        }).then((r) => r.status),
      ),
    );
    expect(results.some((s) => s === 429)).toBe(true);
    expect(results.some((s) => s === 200)).toBe(true);
  });
});
