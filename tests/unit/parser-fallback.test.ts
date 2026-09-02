import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../packages/core/src/config";
import { resolveParser } from "../../packages/core/src/ingest/parser";
import { convertWithFallback, parserLogFor } from "../../packages/core/src/ingest/fallback";
import type { FileParser, UrlParser } from "../../packages/core/src/ingest/parser";

const base = {
  ADMIN_TOKEN: "test-token-0123456789",
  DATABASE_URL: "postgres://stub@127.0.0.1:5/stub",
  DOCLING_URL: "https://docling.test",
} as Record<string, string>;

const docling: FileParser & UrlParser = {
  kind: "docling",
  convertFile: async () => ({ md: "docling-md" }),
  convertUrl: async () => ({ md: "url-md" }),
};
const anydoc: FileParser = { kind: "anydoc", convertFile: async () => ({ md: "anydoc-md" }) };
const failDocling: FileParser & UrlParser = {
  kind: "docling",
  convertFile: async () => { throw new Error("docling down"); },
  convertUrl: async () => { throw new Error("docling down"); },
};
const failAny: FileParser = { kind: "anydoc", convertFile: async () => { throw new Error("unsupported"); } };

describe("resolveParser 链矩阵（005）", () => {
  test("auto + docling 配置 + 默认 pref=docling：primary docling、fallback anydoc、url 可用", () => {
    const p = resolveParser(loadConfig(base), docling, anydoc);
    expect(p.mode).toBe("docling");
    expect(p.primary).toBe(docling);
    expect(p.fallback).toBe(anydoc);
    expect(p.url).not.toBeNull();
  });

  test("auto + docling 配置 + PARSER_PREFERENCE=anydoc：primary anydoc、fallback docling、url 仍可用", () => {
    const p = resolveParser(loadConfig({ ...base, PARSER_PREFERENCE: "anydoc" }), docling, anydoc);
    expect(p.mode).toBe("anydoc");
    expect(p.primary).toBe(anydoc);
    expect(p.fallback).toBe(docling);
    expect(p.url).not.toBeNull();
  });

  test("auto + DOCLING_URL 空：anydoc 唯一（无回退无 url）", () => {
    const p = resolveParser(loadConfig({ ...base, DOCLING_URL: "" }), docling, anydoc);
    expect(p.mode).toBe("anydoc");
    expect(p.fallback).toBeNull();
    expect(p.url).toBeNull();
  });

  test("PARSER_MODE=docling 强制：无回退（即使 pref=anydoc）", () => {
    const p = resolveParser(loadConfig({ ...base, PARSER_MODE: "docling", PARSER_PREFERENCE: "anydoc" }), docling, anydoc);
    expect(p.mode).toBe("docling");
    expect(p.fallback).toBeNull();
  });

  test("PARSER_MODE=anydoc 强制：primary anydoc、无回退无 url", () => {
    const p = resolveParser(loadConfig({ ...base, PARSER_MODE: "anydoc" }), docling, anydoc);
    expect(p.mode).toBe("anydoc");
    expect(p.fallback).toBeNull();
    expect(p.url).toBeNull();
  });
});

describe("convertWithFallback（005 回退执行器）", () => {
  test("primary 成功 → 不回退（used=primary，parser_log 无链）", async () => {
    const r = await convertWithFallback(resolveParser(loadConfig(base), docling, anydoc), new Uint8Array([1]), "a.docx");
    expect(r.md).toBe("docling-md");
    expect(r.used).toBe("docling");
    expect(r.fallbackFrom).toBeUndefined();
    expect(parserLogFor(r)).toBe("docling");
  });

  test("primary(docling) 失败 → fallback(anydoc) 成功 + 链记录", async () => {
    const r = await convertWithFallback(resolveParser(loadConfig(base), failDocling, anydoc), new Uint8Array([1]), "a.docx");
    expect(r.md).toBe("anydoc-md");
    expect(r.used).toBe("anydoc");
    expect(r.fallbackFrom).toContain("docling down");
    expect(parserLogFor(r)).toContain("docling→anydoc:");
  });

  test("anydoc 优先：primary(anydoc) 失败 → fallback(docling) 成功", async () => {
    const cfg = loadConfig({ ...base, PARSER_PREFERENCE: "anydoc" });
    const r = await convertWithFallback(resolveParser(cfg, docling, failAny), new Uint8Array([1]), "scan.pdf");
    expect(r.used).toBe("docling");
    expect(r.md).toBe("docling-md");
    expect(parserLogFor(r)).toContain("anydoc→docling:");
  });

  test("双失败 → 链错误（含 primary 与 fallback 原因）", async () => {
    const chain = resolveParser(loadConfig(base), failDocling, failAny);
    await expect(convertWithFallback(chain, new Uint8Array([1]), "x.pdf")).rejects.toMatchObject({ code: "fallback_failed" });
    try {
      await convertWithFallback(chain, new Uint8Array([1]), "x.pdf");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("docling down");
      expect(msg).toContain("unsupported");
    }
  });

  test("无 fallback（强制/唯一模式）→ primary 错误直抛", async () => {
    const forced = resolveParser(loadConfig({ ...base, PARSER_MODE: "docling" }), failDocling, anydoc);
    await expect(convertWithFallback(forced, new Uint8Array([1]), "x.pdf")).rejects.toThrow("docling down");
  });
});
