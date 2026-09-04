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

  test("超时常量导出（防挂死永久锁）", () => {
    expect(DREAM_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
