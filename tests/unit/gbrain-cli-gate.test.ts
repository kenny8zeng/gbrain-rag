import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../packages/core/src/config";
import { CliBusyError, cliGateState, runGbrain } from "../../packages/core/src/gbrain-cli";

/**
 * 闸门用真进程验证：把 GBRAIN_BIN 指向 `/bin/sleep`，参数即睡眠秒数——
 * runGbrain 的契约（spawn + argv 直传）与真实引擎一致。
 */
function cfgWith(over: Record<string, string>) {
  return loadConfig({
    ADMIN_TOKEN: "test-token-0123456789",
    DATABASE_URL: "postgres://stub@127.0.0.1:5/stub",
    DOCLING_URL: "",
    GBRAIN_BIN: "/bin/sleep",
    ...over,
  } as Record<string, string>);
}

describe("CLI 并发闸门（生产 143 崩溃的根因修复）", () => {
  test("并发上限生效：5 个 1s 调用 / 上限 2 → 明显快于串行，且不超 2 个并发", async () => {
    const cfg = cfgWith({ GBRAIN_CLI_CONCURRENCY: "2", GBRAIN_CLI_QUEUE_WAIT_MS: "30000" });
    const t0 = Date.now();
    let peak = 0;
    const tick = setInterval(() => {
      peak = Math.max(peak, cliGateState().active);
    }, 20);
    await Promise.all(Array.from({ length: 5 }, () => runGbrain(cfg, { args: ["1"] })));
    clearInterval(tick);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(2500); // 至少 3 批（2+2+1）
    expect(elapsed).toBeLessThan(4800); // 远快于串行 5s
    expect(peak).toBeLessThanOrEqual(2);
    expect(cliGateState()).toEqual({ active: 0, waiting: 0 });
  }, 20000);

  test("排队超时 → CliBusyError（可重试语义）", async () => {
    const cfg = cfgWith({ GBRAIN_CLI_CONCURRENCY: "1", GBRAIN_CLI_QUEUE_WAIT_MS: "120" });
    const first = runGbrain(cfg, { args: ["1"] });
    await Bun.sleep(30); // 让第一个拿到槽
    expect(await runGbrain(cfg, { args: ["1"] }).then(() => "ran").catch((e) => (e as Error).name)).toBe(
      "CliBusyError",
    );
    await first;
    expect(cliGateState()).toEqual({ active: 0, waiting: 0 });
  }, 20000);

  test("命令失败时槽位必须释放（否则闸门永久卡死）", async () => {
    const cfg = cfgWith({ GBRAIN_CLI_CONCURRENCY: "1", GBRAIN_CLI_QUEUE_WAIT_MS: "5000" });
    await runGbrain(cfg, { args: ["0"] }); // sleep 0 → exit 0
    const bad = cfgWith({ GBRAIN_CLI_CONCURRENCY: "1", GBRAIN_BIN: "/bin/false" });
    await expect(runGbrain(bad, { args: [] })).rejects.toThrow();
    expect(cliGateState().active).toBe(0);
    // 关键：失败后仍能继续拿槽
    await runGbrain(cfg, { args: ["0"] });
    expect(cliGateState().active).toBe(0);
  }, 20000);

  test("排队等待不计入执行超时（执行预算不被队列吃掉）", async () => {
    const cfg = cfgWith({
      GBRAIN_CLI_CONCURRENCY: "1",
      GBRAIN_CLI_QUEUE_WAIT_MS: "30000",
    });
    const holder = runGbrain(cfg, { args: ["1"] });
    await Bun.sleep(20);
    // 排队 ~1s（等 holder），执行超时仅 500ms —— 若超时含排队，此调用必失败
    const queued = runGbrain(cfg, { args: ["0"], timeoutMs: 500 });
    await expect(queued).resolves.toBeDefined();
    await holder;
  }, 20000);

  test("CliBusyError 携带命令名与等待时长", () => {
    const e = new CliBusyError(["put"], 1234);
    expect(e.name).toBe("CliBusyError");
    expect(e.message).toContain("put");
    expect(e.message).toContain("1234");
  });
});
