import { describe, expect, test } from "bun:test";
import {
  slugifyName,
  deriveSlug,
  stripFrontmatter,
  buildMarkdown,
} from "../../packages/core/src/ingest/pipeline";

describe("slugifyName", () => {
  test("中文名保留、符号折叠", () => {
    expect(slugifyName("2026 产品 退货政策.pdf")).toBe("2026-产品-退货政策");
  });
  test("空串回退 doc", () => {
    expect(slugifyName("///")).toBe("doc");
  });
  test("截断 64 字符", () => {
    expect(slugifyName("x".repeat(100)).length).toBeLessThanOrEqual(64);
  });
});

describe("deriveSlug", () => {
  test("落在分区栅栏内", () => {
    expect(deriveSlug("kb-aabbccdd", "退货政策.md")).toBe("kb-aabbccdd/docs/退货政策");
  });
});

describe("stripFrontmatter", () => {
  test("剥离已有 frontmatter", () => {
    expect(stripFrontmatter("---\ntitle: x\n---\n\nbody")).toBe("body");
  });
  test("无 frontmatter 原样返回", () => {
    expect(stripFrontmatter("plain body")).toBe("plain body");
  });
});

describe("buildMarkdown", () => {
  test("注入元数据 frontmatter", () => {
    const out = buildMarkdown("内容", {
      title: "T",
      kb: "kb-aabbccdd",
      sourceUrl: "https://example.test/a",
      convertedAt: "2026-08-31T00:00:00Z",
    });
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("kb: kb-aabbccdd");
    expect(out).toContain("source_url");
    expect(out).toContain("内容");
  });
  test("直传 md 自带 frontmatter 被统一替换", () => {
    const out = buildMarkdown("---\ntitle: old\n---\nbody", { title: "new", kb: "kb-1", convertedAt: "now" });
    expect(out).not.toContain("old");
    expect(out).toContain("body");
  });
});
