import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../packages/core/src/config";
import { DreamRunner, DREAM_TIMEOUT_MS } from "../../packages/core/src/dream";

const base = {
  ADMIN_TOKEN: "test-token-0123456789",
  DATABASE_URL: "postgres://stub@127.0.0.1:5/stub",
  DOCLING_URL: "",
} as Record<string, string>;

function mkRunner(over: Record<string, string> = {}, exec?: (args: string[]) => Promise<{ stdout: string; exitCode: number }>) {
  const cfg = loadConfig({ ...base, ...over });
  return new DreamRunner(cfg, { exec: exec ?? (async () => ({ stdout: "{}", exitCode: 0 })) });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("DreamRunner 锁与触发", () => {
  test("默认关闭：enabled=false 且无定时（T003 env 默认）", () => {
    const r = mkRunner();
    expect(r.status().enabled).toBe(false);
    expect(r.status().nextDue).toBeNull();
  });

  test("轻量档启动 → args=dream --phase extract --json；完成后 running=false + lastRun", async () => {
    let captured: string[] = [];
    const r = mkRunner({ DREAM_ENABLED: "true" }, async (args) => { captured = args; return { stdout: '{"phase":"extract","ok":true}', exitCode: 0 }; });
    const res = await r.start("manual", "light");
    expect(res.accepted).toBe(true);
    expect(captured).toEqual(["dream", "--phase", "extract", "--json"]);
    await sleep(20);
    expect(r.status().running).toBe(false);
    expect(r.status().lastRun?.ok).toBe(true);
    expect(r.status().lastRun?.tier).toBe("light");
  });

  test("完整档 → args=dream --json", async () => {
    let captured: string[] = [];
    const r = mkRunner({}, async (args) => { captured = args; return { stdout: "{}", exitCode: 0 }; });
    await r.start("manual", "full");
    expect(captured).toEqual(["dream", "--json"]);
    await sleep(10);
  });

  test("运行中手工触发 → 拒绝（互斥）", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => { release = res; });
    const r = mkRunner({}, async () => { await gate; return { stdout: "{}", exitCode: 0 }; });
    const first = await r.start("manual", "light");
    expect(first.accepted).toBe(true);
    const second = await r.start("manual", "light");
    expect(second.accepted).toBe(false);
    expect(second.reason).toContain("already running");
    release();
    await sleep(10);
  });

  test("定时到点 + running → 跳过顺延（不叠跑）", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => { release = res; });
    let calls = 0;
    const r = mkRunner({ DREAM_ENABLED: "true", DREAM_INTERVAL_HOURS: "1" }, async () => { calls++; await gate; return { stdout: "{}", exitCode: 0 }; });
    // 推进 nextDue 到过去
    (r as unknown as { nextDue: number | null }).nextDue = Date.now() - 1000;
    await r.start("manual", "light"); // 占锁（running）
    await r.maybeScheduled(); // 到点但 running → 跳过
    expect(calls).toBe(1); // 未叠跑
    expect(r.status().running).toBe(true);
    release();
    await sleep(10);
    expect(r.status().running).toBe(false);
  });

  test("定时启用且到点且空闲 → 触发；未到点不触发", async () => {
    let calls = 0;
    const r = mkRunner({ DREAM_ENABLED: "true", DREAM_INTERVAL_HOURS: "24" }, async () => { calls++; return { stdout: "{}", exitCode: 0 }; });
    await r.maybeScheduled(); // nextDue = now+24h → 不触发
    expect(calls).toBe(0);
    (r as unknown as { nextDue: number | null }).nextDue = Date.now() - 1000;
    await r.maybeScheduled();
    expect(calls).toBe(1);
    await sleep(10);
  });

  test("失败记录 lastRun.ok=false + lastError；运行结束可再触发", async () => {
    const r = mkRunner({}, async () => ({ stdout: "boom exit", exitCode: 1 }));
    await r.start("manual", "light");
    await sleep(20);
    expect(r.status().lastRun?.ok).toBe(false);
    expect(r.status().lastError).toBeTruthy();
    const again = await r.start("manual", "light");
    expect(again.accepted).toBe(true);
    await sleep(20);
  });

  test("DREAM_AT 每日时刻：nextDue = 当日 HH:MM（未过）", async () => {
    const now = Date.now();
    const d = new Date(now);
    const at = d.getHours().toString().padStart(2, "0") + ":" + String(Math.min(d.getMinutes() + 5, 59)).padStart(2, "0"); // 未来 5 分钟
    const r = mkRunner({ DREAM_ENABLED: "true", DREAM_AT: at });
    const nd = new Date(r.status().nextDue!);
    expect(nd.getHours() * 60 + nd.getMinutes()).toBe(Number(at.split(":")[0]) * 60 + Number(at.split(":")[1]));
    expect(nd.getTime()).toBeGreaterThan(now);
  });

  test("DREAM_AT 已过当日时刻 → nextDue = 次日同刻", async () => {
    const d = new Date();
    const past = (d.getHours() - 1 + 24) % 24; // 必然早于现在
    const at = past.toString().padStart(2, "0") + ":00";
    const r = mkRunner({ DREAM_ENABLED: "true", DREAM_AT: at });
    const nd = new Date(r.status().nextDue!);
    expect(nd.getHours() * 60 + nd.getMinutes()).toBe(past * 60);
    expect(nd.getTime()).toBeGreaterThan(Date.now()); // 次日
  });

  test("DREAM_AT 到点触发 → 完成后 nextDue 推进到次日同刻", async () => {
    let calls = 0;
    const d = new Date();
    const at = d.getHours().toString().padStart(2, "0") + ":" + String(Math.min(d.getMinutes() + 5, 59)).padStart(2, "0");
    const r = mkRunner({ DREAM_ENABLED: "true", DREAM_AT: at }, async () => { calls++; return { stdout: "{}", exitCode: 0 }; });
    (r as unknown as { nextDue: number | null }).nextDue = Date.now() - 1000; // 模拟到点
    await r.maybeScheduled();
    expect(calls).toBe(1);
    await sleep(10);
    // 完成后 nextDue 应 > 现在（次日/未来同刻）且非 null
    const nd = r.status().nextDue;
    expect(nd).not.toBeNull();
    expect(new Date(nd!).getTime()).toBeGreaterThan(Date.now());
  });

  test("DREAM_AT 非法 → 回退间隔模式", async () => {
    const r = mkRunner({ DREAM_ENABLED: "true", DREAM_AT: "25:99" });
    // nextDue = now+interval（间隔 24h）
    const delta = new Date(r.status().nextDue!).getTime() - Date.now();
    expect(delta).toBeGreaterThan(23 * 3600_000);
  });

  test("超时常量导出（防挂死永久锁）", () => {
    expect(DREAM_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
