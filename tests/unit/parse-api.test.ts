import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildCapabilityProfile,
  isImageInput,
  isPassthroughInput,
  isSupportedByExtension,
  isSupportedBytes,
  supportedExtensionList,
} from "../../packages/core/src/ingest/parse-api";
import { loadConfig } from "../../packages/core/src/config";
import { resolveParserFor } from "../../packages/core/src/ingest/resolver";

/**
 * 009 裸解析：受理判定与能力自描述单测。
 * 关键契约：FR-008 **内容优先**（扩展名不可识别但内容可嗅探 ⇒ 仍受理）。
 */

const DOCX = new Uint8Array(await Bun.file("tests/fixtures/test.docx").arrayBuffer());

function cfgOf(env: Record<string, string>) {
  return loadConfig({
    ADMIN_TOKEN: "test-token-0123456789",
    DATABASE_URL: "postgres://stub@127.0.0.1:5/stub",
    GBRAIN_SERVE_ENABLED: "false",
    ...env,
  } as Record<string, string>);
}

describe("parse-api: 扩展名轨判定（能力自描述用）", () => {
  test("白名单内类型受理", () => {
    for (const ext of supportedExtensionList()) {
      expect(isSupportedByExtension(`doc.${ext}`)).toBe(true);
    }
  });

  test("白名单外 / 无扩展名 / 未知类型不受理", () => {
    expect(isSupportedByExtension("x.xyz")).toBe(false);
    expect(isSupportedByExtension("noext")).toBe(false);
    expect(isSupportedByExtension("archive.zip")).toBe(false);
  });

  test("大小写不敏感", () => {
    expect(isSupportedByExtension("REPORT.PDF")).toBe(true);
    expect(isSupportedByExtension("Deck.PPTX")).toBe(true);
  });
});

describe("parse-api: 内容轨判定（FR-008 内容优先）", () => {
  test("内容可嗅探但扩展名不识别 ⇒ 受理（内容优先）", () => {
    // 真实 docx 字节，但扩展名误导
    expect(isSupportedByExtension("sample.bin")).toBe(false);
    expect(isSupportedBytes(DOCX, "sample.bin")).toBe(true);
  });

  test("扩展名在白名单但内容不可识别 ⇒ 仍受理（扩展名回退，交由解析层判定）", () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(isSupportedBytes(garbage, "weird.pdf")).toBe(true);
  });

  test("扩展名与内容皆不可识别 ⇒ 不受理", () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(isSupportedBytes(garbage, "mystery.dat")).toBe(false);
  });

  test("纯文本内容 + 未知扩展名 ⇒ 内容轨不受理（由直通分支处理，见 FR-005a）", () => {
    const text = new TextEncoder().encode("just some plain text\n");
    expect(isSupportedBytes(text, "notes.xyz")).toBe(false);
    expect(isSupportedByExtension("notes.xyz")).toBe(false);
  });
});

describe("parse-api: 输入形式判定", () => {
  test("纯文本直通类型（md/txt，大小写不敏感）", () => {
    expect(isPassthroughInput("a.md")).toBe(true);
    expect(isPassthroughInput("a.txt")).toBe(true);
    expect(isPassthroughInput("A.MD")).toBe(true);
    expect(isPassthroughInput("a.pdf")).toBe(false);
  });

  test("图片类型（外部解析服务独有能力）", () => {
    expect(isImageInput("shot.png")).toBe(true);
    expect(isImageInput("shot.JPEG")).toBe(true);
    expect(isImageInput("doc.pdf")).toBe(false);
  });
});

describe("parse-api: 能力自描述（SC-007 描述轨）", () => {
  test("anydoc 唯一形态：单通道、不接受 URL", () => {
    const cfg = cfgOf({ DOCLING_URL: "" });
    const p = buildCapabilityProfile(cfg, resolveParserFor(cfg));
    expect(p.primary).toBe("anydoc");
    expect(p.available_channels).toEqual(["anydoc"]);
    expect(p.accepts_url).toBe(false);
  });

  test("docling 已配置：双通道、接受 URL", () => {
    const cfg = cfgOf({ DOCLING_URL: "https://docling.test" });
    const p = buildCapabilityProfile(cfg, resolveParserFor(cfg));
    expect(p.available_channels.sort()).toEqual(["anydoc", "docling"]);
    expect(p.accepts_url).toBe(true);
  });

  test("强制 anydoc：单通道、不接受 URL（即便 DOCLING_URL 有值）", () => {
    const cfg = cfgOf({ DOCLING_URL: "https://docling.test", PARSER_MODE: "anydoc" });
    const p = buildCapabilityProfile(cfg, resolveParserFor(cfg));
    expect(p.primary).toBe("anydoc");
    expect(p.available_channels).toEqual(["anydoc"]);
    expect(p.accepts_url).toBe(false);
  });

  test("描述轨与判定轨同源（共用同一白名单）+ 直通类型与并发上限", () => {
    const cfg = cfgOf({ DOCLING_URL: "" });
    const p = buildCapabilityProfile(cfg, resolveParserFor(cfg));
    for (const ext of p.supported_file_types) expect(isSupportedByExtension(`x.${ext}`)).toBe(true);
    expect(p.passthrough_types).toEqual(["md", "txt"]);
    expect(p.concurrency).toBe(cfg.PARSE_CONCURRENCY);
  });
});
