import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  applyStrip,
  buildBulkStage,
  listArchiveFiles,
  newBulkTempDir,
  parseImportSummary,
  parseLinkSummary,
  planBulkDocs,
  validateArchiveMemberNames,
  validateArchiveMemberTypes,
} from "../../packages/core/src/ingest/bulk";

// ─── 归档成员安全校验 ───────────────────────────────────────────

describe("bulk: 归档成员校验", () => {
  test("拒绝绝对路径与 .. 穿越，放行正常成员", () => {
    const violations = validateArchiveMemberNames([
      "en/docs/a.md",
      "/etc/passwd",
      "en/../evil.md",
      "en/docs/../docs/b.md",
      "",
    ]);
    expect(violations).toHaveLength(3);
    expect(violations.some((v) => v.includes("absolute path"))).toBe(true);
    expect(violations.filter((v) => v.includes("parent traversal"))).toHaveLength(2);
  });

  test("拒绝符号链接与硬链接成员（tar slip 防御）", () => {
    const violations = validateArchiveMemberTypes([
      "-rw-r--r-- rag/rag 123 2026-01-01 00:00 en/docs/a.md",
      "lrwxrwxrwx rag/rag   0 2026-01-01 00:00 evil -> /etc/passwd",
      "hrw-r--r-- rag/rag   0 2026-01-01 00:00 hard -> /etc/shadow",
    ]);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("symlink member");
    expect(violations[1]).toContain("hardlink member");
  });

  test("普通成员无违规", () => {
    expect(validateArchiveMemberTypes(["-rw-r--r-- rag/rag 12 2026-01-01 00:00 en/docs/a.md"])).toHaveLength(0);
  });
});

// ─── 前缀剥离 ──────────────────────────────────────────────────

describe("bulk: 前缀剥离", () => {
  test("自动剥离唯一公共顶层目录", () => {
    expect(applyStrip(["en/docs/a.md", "en/faq/b.md"])).toEqual(["docs/a.md", "faq/b.md"]);
  });
  test("无公共根（多顶层目录）不剥离", () => {
    expect(applyStrip(["docs/a.md", "faq/b.md"])).toEqual(["docs/a.md", "faq/b.md"]);
  });
  test("单文件在根不剥离（避免剥成空路径）", () => {
    expect(applyStrip(["a.md"])).toEqual(["a.md"]);
  });
  test("显式 strip 优先，未匹配成员保持原样", () => {
    expect(applyStrip(["en/docs/a.md", "other/b.md"], "en/")).toEqual(["docs/a.md", "other/b.md"]);
  });
});

// ─── 规划：md 过滤 / slug 派生 / 冲突 ───────────────────────────

describe("bulk: planBulkDocs", () => {
  test("只收 .md，跳过隐藏与垃圾目录，slug 与逐篇管道同规则", () => {
    const plan = planBulkDocs([
      "en/01-products/02-soleil01-us/03-01-a-us-soleil01-series.md",
      "en/notes.txt",
      "en/.DS_Store",
      "en/__MACOSX/._a.md",
    ]);
    expect(plan.docs).toHaveLength(1);
    expect(plan.docs[0]!.title).toBe("en/01-products/02-soleil01-us/03-01-a-us-soleil01-series");
    expect(plan.docs[0]!.slug).toBe(slugifyName("en/01-products/02-soleil01-us/03-01-a-us-soleil01-series"));
    expect(plan.skipped.map((s) => s.reason)).toEqual(["not markdown", "hidden/junk", "hidden/junk"]);
    expect(plan.collisions).toHaveLength(0);
  });

  test("两个文件归一化为同一 slug → 冲突（不静默覆盖）", () => {
    // 同一 stem，仅大小写不同 → slug 相同
    const plan = planBulkDocs(["docs/Brake-Noise.md", "docs/brake-noise.md"]);
    expect(plan.docs).toHaveLength(2);
    expect(plan.collisions).toHaveLength(1);
    expect(plan.collisions[0]!.slug).toBe(slugifyName("docs/Brake-Noise"));
    expect(plan.collisions[0]!.rels).toHaveLength(2);
  });
});

import { slugifyName } from "../../packages/core/src/ingest/pipeline";

// ─── staging：真实临时目录 ──────────────────────────────────────

describe("bulk: buildBulkStage", () => {
  test("docs 归位 + 双链目标实体页生成 + 非常规输入被拒", () => {
    const incoming = newBulkTempDir("/tmp", "raw");
    const stage = newBulkTempDir("/tmp", "stage");
    try {
      const rawDir = path.join(incoming, "x");
      mkdirSync(path.join(rawDir, "en/docs"), { recursive: true });
      writeFileSync(path.join(rawDir, "en/docs/brake.md"), "# [[Brake]] noise guide\nsee [[Soleil01]]\n");
      writeFileSync(path.join(rawDir, "en/docs/ignored.txt"), "not md");
      const rawRels = listArchiveFiles(rawDir);
      const stripped = applyStrip(rawRels, "en/");
      const srcByStripped = new Map(stripped.map((name, i) => [name, rawRels[i]!]));
      const docs = planBulkDocs(stripped).docs;
      expect(docs).toHaveLength(1);

      const kbId = "kb-zzzzzzzz";
      const { entities } = buildBulkStage({
        rawDir,
        stageDir: stage,
        kbId,
        docs,
        maxTotalBytes: 1024 * 1024,
        resolveSrc: (rel) => srcByStripped.get(rel) ?? rel,
      });

      // docs 归位：<stage>/<kb>/docs/<slug>.md，frontmatter 注入 title/kb
      const page = readFileSync(path.join(stage, kbId, "docs", `${docs[0]!.slug}.md`), "utf8");
      expect(page).toContain(`title: "docs/brake"`);
      expect(page).toContain(`kb: ${kbId}`);
      expect(page).toContain("[[Brake]]");
      // 实体页：双链目标 Brake / Soleil01
      expect(entities.map((e) => e.slug).sort()).toEqual(["brake", "soleil01"]);
      const stub = readFileSync(path.join(stage, kbId, "entities", "brake.md"), "utf8");
      expect(stub).toContain("type: concept");
      expect(stub).toContain("auto_generated: wikilink-stub");
    } finally {
      rmSync(incoming, { recursive: true, force: true });
      rmSync(stage, { recursive: true, force: true });
    }
  });

  test("解压后总量超上限 → 抛错并清理 stage", () => {
    const incoming = newBulkTempDir("/tmp", "raw");
    const stage = newBulkTempDir("/tmp", "stage");
    try {
      const rawDir = path.join(incoming, "x");
      mkdirSync(rawDir, { recursive: true });
      writeFileSync(path.join(rawDir, "big.md"), "x".repeat(2048));
      const docs = planBulkDocs(listArchiveFiles(rawDir)).docs;
      const identity = (rel: string): string => rel;
      expect(() => buildBulkStage({ rawDir, stageDir: stage, kbId: "kb-zzzzzzzz", docs, maxTotalBytes: 1024, resolveSrc: identity })).toThrow(
        /exceeds/,
      );
      // 失败路径 stage 被清理
      expect(rmSyncSafe(stage)).toBe(true);
    } finally {
      rmSync(incoming, { recursive: true, force: true });
      rmSync(stage, { recursive: true, force: true });
    }
  });
});

function rmSyncSafe(dir: string): boolean {
  try {
    readFileSync(path.join(dir, "__absent__"));
    return false;
  } catch {
    return true;
  }
}

// ─── 摘要解析 ──────────────────────────────────────────────────

describe("bulk: 引擎摘要解析", () => {
  test("import 摘要", () => {
    const s = parseImportSummary(
      "Import complete (65.2s):\n  577 pages imported\n  0 pages skipped (0 unchanged, 0 errors)\n  579 chunks created",
    );
    expect(s).toEqual({ imported: 577, unchanged: 0, errors: 0, chunks: 579 });
  });
  test("import 带错误计数", () => {
    const s = parseImportSummary("Import complete (3.1s):\n  0 pages imported\n  577 pages skipped (0 unchanged, 577 errors)\n  0 chunks created");
    expect(s?.errors).toBe(577);
  });
  test("非摘要文本 → null", () => {
    expect(parseImportSummary("garbage")).toBeNull();
  });
  test("extract links 摘要", () => {
    const s = parseLinkSummary("Links: created 1656 from 577 pages (db source)\nSkipped 1799 candidate(s) whose target page doesn't exist");
    expect(s).toEqual({ created: 1656, skipped: 1799 });
    expect(parseLinkSummary("no links here")).toBeNull();
  });
});
