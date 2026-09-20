import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../packages/core/src/config";
import { resolveParserFor } from "../../packages/core/src/ingest/resolver";

/**
 * 解析链单例缓存（D33 回归）。
 *
 * `resolveParserFor` 按配置缓存解析链。缓存键必须覆盖**所有影响链形态**的配置项——
 * 曾漏掉 `PARSER_PREFERENCE`，导致同一进程内变更偏好时复用旧链：首选/回退方向错误，
 * 且能力自描述（`/health` 的 parse 块）与实际解析行为不一致。
 */

function cfgOf(env: Record<string, string>) {
  return loadConfig({
    ADMIN_TOKEN: "test-token-0123456789",
    DATABASE_URL: "postgres://stub@127.0.0.1:5/stub",
    GBRAIN_SERVE_ENABLED: "false",
    ...env,
  } as Record<string, string>);
}

describe("resolveParserFor 缓存键覆盖度（D33）", () => {
  test("同一 DOCLING_URL/PARSER_MODE 下切换 PARSER_PREFERENCE 必须返回不同链", () => {
    const url = "https://d33-cache.test";
    const first = resolveParserFor(cfgOf({ PARSER_MODE: "auto", DOCLING_URL: url, PARSER_PREFERENCE: "anydoc" }));
    const second = resolveParserFor(cfgOf({ PARSER_MODE: "auto", DOCLING_URL: url, PARSER_PREFERENCE: "docling" }));
    expect(first.mode).toBe("anydoc");
    expect(second.mode).toBe("docling");
    // 回退方向随之互换
    expect(first.fallback).not.toBeNull();
    expect(second.fallback).not.toBeNull();
    expect(second.fallback).not.toBe(first.primary);
  });

  test("反向顺序同样正确（先 docling 后 anydoc）", () => {
    const url = "https://d33-cache-rev.test";
    const a = resolveParserFor(cfgOf({ PARSER_MODE: "auto", DOCLING_URL: url, PARSER_PREFERENCE: "docling" }));
    const b = resolveParserFor(cfgOf({ PARSER_MODE: "auto", DOCLING_URL: url, PARSER_PREFERENCE: "anydoc" }));
    expect(a.mode).toBe("docling");
    expect(b.mode).toBe("anydoc");
  });

  test("同一配置重复调用命中缓存（返回同一实例，保持单例语义）", () => {
    const env = { PARSER_MODE: "auto", DOCLING_URL: "https://d33-same.test", PARSER_PREFERENCE: "docling" };
    const x = resolveParserFor(cfgOf(env));
    const y = resolveParserFor(cfgOf(env));
    expect(y).toBe(x);
  });

  test("PARSER_MODE 与 DOCLING_URL 仍在缓存键内（回归保护）", () => {
    const base = { DOCLING_URL: "https://d33-key.test", PARSER_PREFERENCE: "docling" };
    const auto = resolveParserFor(cfgOf({ ...base, PARSER_MODE: "auto" }));
    const forcedAny = resolveParserFor(cfgOf({ ...base, PARSER_MODE: "anydoc" }));
    expect(auto.mode).toBe("docling");
    expect(forcedAny.mode).toBe("anydoc");
    expect(forcedAny.fallback).toBeNull();
  });
});

describe("生效矩阵（对照 docs/deployment.md）", () => {
  const cases: Array<[string, Record<string, string>, { primary: "anydoc" | "docling"; fallback: boolean; url: boolean }]> = [
    ["强制 anydoc", { PARSER_MODE: "anydoc", DOCLING_URL: "https://m1.test", PARSER_PREFERENCE: "docling" }, { primary: "anydoc", fallback: false, url: false }],
    ["强制 docling", { PARSER_MODE: "docling", DOCLING_URL: "https://m2.test", PARSER_PREFERENCE: "anydoc" }, { primary: "docling", fallback: false, url: true }],
    ["auto + URL 空", { PARSER_MODE: "auto", DOCLING_URL: "", PARSER_PREFERENCE: "docling" }, { primary: "anydoc", fallback: false, url: false }],
    ["auto + URL + pref=anydoc", { PARSER_MODE: "auto", DOCLING_URL: "https://m4.test", PARSER_PREFERENCE: "anydoc" }, { primary: "anydoc", fallback: true, url: true }],
    ["auto + URL + pref=docling", { PARSER_MODE: "auto", DOCLING_URL: "https://m5.test", PARSER_PREFERENCE: "docling" }, { primary: "docling", fallback: true, url: true }],
  ];
  for (const [label, env, want] of cases) {
    test(label, () => {
      const chain = resolveParserFor(cfgOf(env));
      expect({ primary: chain.mode, fallback: chain.fallback !== null, url: chain.url !== null }).toEqual(want);
    });
  }
});
