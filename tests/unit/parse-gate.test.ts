import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../packages/core/src/config";
import { ParseBusyError, parseGateState, withParseSlot } from "../../packages/core/src/ingest/parse-api";

/**
 * 009 解析专用并发闸门：与引擎 CLI 闸门**独立**（解析不经 runGbrain）。
 * 验证上限、排队、饱和可重试、失败释放、执行超时不含排队。
 */

function cfgWith(over: Record<string, string>) {
  return loadConfig({
    ADMIN_TOKEN: "test-token-0123456789",
    DATABASE_URL: "postgres://stub@127.0.0.1:5/stub",
    DOCLING_URL: "",
    GBRAIN_SERVE_ENABLED: "false",
    ...over,
  } as Record<string, string>);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("解析闸门：上限与排队", () => {
  test("上限内并发通过，且从不超过上限", async () => {
    const cfg = cfgWith({ PARSE_CONCURRENCY: "2", GBRAIN_CLI_QUEUE_WAIT_MS: "30000" });
    let peak = 0;
    const tick = setInterval(() => {
      peak = Math.max(peak, parseGateState().active);
    }, 10);
    await Promise.all(
      Array.from({ length: 4 }, () => withParseSlot(cfg, async () => sleep(120))),
    );
    clearInterval(tick);
    expect(peak).toBe(2);
    expect(parseGateState().active).toBe(0); // 全部释放
  });

  test("饱和且等待超限 → ParseBusyError（可重试语义）", async () => {
    const cfg = cfgWith({ PARSE_CONCURRENCY: "1", GBRAIN_CLI_QUEUE_WAIT_MS: "120" });
    const first = withParseSlot(cfg, async () => sleep(600));
    await sleep(30); // 让 first 占住槽位
    const err = await withParseSlot(cfg, async () => sleep(10)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ParseBusyError);
    expect((err as ParseBusyError).code).toBe("PARSE_BUSY");
    await first;
    expect(parseGateState().active).toBe(0);
  });

  test("排队者在限额内被唤醒（不是全部拒绝）", async () => {
    const cfg = cfgWith({ PARSE_CONCURRENCY: "1", GBRAIN_CLI_QUEUE_WAIT_MS: "5000" });
    const order: string[] = [];
    await Promise.all([
      withParseSlot(cfg, async () => {
        order.push("a-start");
        await sleep(120);
        order.push("a-end");
      }),
      withParseSlot(cfg, async () => {
        order.push("b-start");
        await sleep(20);
        order.push("b-end");
      }),
      withParseSlot(cfg, async () => {
        order.push("c-start");
      }),
    ]);
    // 串行化：b 必须在 a 结束之后才开始
    expect(order.indexOf("b-start")).toBeGreaterThan(order.indexOf("a-end"));
    expect(order).toContain("c-start");
  });
});

describe("解析闸门：释放语义", () => {
  test("失败路径亦释放槽位（finally）", async () => {
    const cfg = cfgWith({ PARSE_CONCURRENCY: "1", GBRAIN_CLI_QUEUE_WAIT_MS: "500" });
    await withParseSlot(cfg, async () => {
      throw new Error("boom");
    }).catch(() => undefined);
    expect(parseGateState().active).toBe(0);
    // 释放后可再次获取（不会因上次失败而永久占用）
    await withParseSlot(cfg, async () => sleep(10));
    expect(parseGateState().active).toBe(0);
  });

  test("执行耗时不受排队影响（排队超时 ≠ 执行超时）", async () => {
    const cfg = cfgWith({ PARSE_CONCURRENCY: "1", GBRAIN_CLI_QUEUE_WAIT_MS: "5000" });
    const t0 = Date.now();
    await Promise.all([
      withParseSlot(cfg, async () => sleep(150)),
      withParseSlot(cfg, async () => sleep(150)),
    ]);
    const elapsed = Date.now() - t0;
    // 两次执行各 150ms，串行 ≈300ms（若把排队算进执行超时会提前失败）
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(parseGateState().waiting).toBe(0);
  });

  test("缺省上限来自 PARSE_CONCURRENCY（默认 4）", () => {
    expect(cfgWith({}).PARSE_CONCURRENCY).toBe(4);
  });
});
