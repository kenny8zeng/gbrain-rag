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
  test("预算内长名原样保留（旧的 64 字符硬截断已废弃）", () => {
    const name = "x".repeat(100);
    expect(slugifyName(name)).toBe(name);
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

  // 008：文档类型由服务钉定——引擎对 `docs/` 前缀无推断规则，会落默认 concept
  test("显式钉定 type: note（不依赖引擎路径推断）", () => {
    const out = buildMarkdown("内容", { title: "T", kb: "kb-aabbccdd", convertedAt: "now" });
    expect(out).toContain("type: note");
  });

  test("正文自带 type 被服务钉定值覆盖", () => {
    const out = buildMarkdown("---\ntitle: x\ntype: entity\n---\nbody", { title: "T", kb: "kb-1", convertedAt: "now" });
    expect(out).toContain("type: note");
    expect(out).not.toContain("type: entity");
  });
});

describe("slug 生成：超长名抗撞车（截断致静默覆盖的修复）", () => {
  // 需超过 SLUG_MAX_BYTES(200) 才会触发截断
  const long = (tail: string) =>
    `02-per-series-troubleshooting-and-error-codes-03-01-fault-troubleshooting-2-fault-code-` +
    `a-really-long-descriptive-tail-because-this-corpus-uses-verbose-names-${tail}`;

  test("短名不变（向后兼容，含中文）", () => {
    expect(slugifyName("Battery Pack")).toBe("battery-pack");
    expect(slugifyName("电池说明")).toBe("电池说明");
    expect(slugifyName("a.md")).toBe("a");
  });

  test("超长名截断后附哈希：不同的长名不再撞车", () => {
    const a = slugifyName(`${long("e01")}.md`);
    const b = slugifyName(`${long("e02")}.md`);
    expect(a).not.toBe(b); // 修复前两者前缀相同 → 截断后相同
    expect(Buffer.byteLength(a, "utf8")).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(b, "utf8")).toBeLessThanOrEqual(200);
  });

  test("同名重复导入幂等（哈希稳定）", () => {
    const n = `${long("e01")}.md`;
    expect(slugifyName(n)).toBe(slugifyName(n));
    // 大小写/标点差异归一后仍稳定
    expect(slugifyName(n.toUpperCase())).toBe(slugifyName(n));
  });

  test("哈希基于完整名：仅尾部差异必须改变哈希", () => {
    const base = long("");
    const h1 = slugifyName(`${base}alpha`).slice(-8);
    const h2 = slugifyName(`${base}beta`).slice(-8);
    expect(h1).not.toBe(h2);
  });

  test("边界：字节预算内原样；超出才截断加哈希", () => {
    const inBudget = "a".repeat(200);
    expect(slugifyName(inBudget)).toBe(inBudget); // 200 ASCII 字节 = 恰好预算内
    const over = slugifyName("a".repeat(201));
    expect(Buffer.byteLength(over, "utf8")).toBeLessThanOrEqual(200);
    expect(over).not.toBe("a".repeat(200));
    expect(over.startsWith("a".repeat(191))).toBe(true); // head = 200-8-1
  });

  test("CJK 按字节截断：不越 255 字节文件名上限（避免 ENAMETOOLONG）", () => {
    const longCjk = "电池".repeat(100); // 200 字符 = 600 字节
    const s = slugifyName(`${longCjk}.md`);
    expect(Buffer.byteLength(s, "utf8")).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(`${s}.md`, "utf8")).toBeLessThan(255);
    expect(s).not.toContain("\uFFFD"); // 未截断多字节字符
  });

  test("截断处的连字符被剥离（不产生双连字符或尾连字符）", () => {
    const s = slugifyName(`aaaa-bbbb-cccc-dddd-eeee-ffff-gggg-hhhh-iiii-jjjj-kkkk-llll-mmmm-nnnn-oooo-pppp-qqqq-rrrr-ssss-tttt-uuuu-vvvv-wwww-xxxx-yyyy-zzzz`);
    expect(s).not.toContain("--");
    expect(s.endsWith("-")).toBe(false);
  });

  test("空名/纯标点回退 doc", () => {
    expect(slugifyName("")).toBe("doc");
    expect(slugifyName("!!!")).toBe("doc");
  });
});
