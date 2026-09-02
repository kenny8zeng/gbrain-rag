import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../packages/core/src/config";
import { ParserUnavailableError } from "../../packages/core/src/ingest/parser";
import { AnyDocParser, describeAnyDocError, formatFromFilename } from "../../packages/core/src/ingest/anydoc-parser";


const base = {
  ADMIN_TOKEN: "test-token-0123456789",
  DATABASE_URL: "postgres://stub@127.0.0.1:5/stub",
  DOCLING_URL: "https://docling.test",
} as Record<string, string>;

describe("ParserUnavailableError", () => {
  test("url 通道文案含 DOCLING_URL 指引", () => {
    const e = new ParserUnavailableError("url");
    expect(e.message).toContain("DOCLING_URL");
    expect(e.channel).toBe("url");
  });
});

describe("describeAnyDocError 映射表", () => {
  test("needsOcr 含 OCR 指引", () => {
    expect(describeAnyDocError("needsOcr")).toContain("OCR");
  });
  test("全码覆盖（不抛未知）", () => {
    for (const code of ["needsOcr", "unsupported", "malformed", "encrypted", "resourceLimit", "missingPart", "io", "hosted"]) {
      expect(describeAnyDocError(code).length).toBeGreaterThan(0);
    }
    expect(describeAnyDocError("unknown-code")).toContain("unknown-code");
  });
});

describe("formatFromFilename", () => {
  test("常见扩展名回退", () => {
    expect(formatFromFilename("a.csv")).toBe("csv");
    expect(formatFromFilename("b.PDF")).toBe("pdf");
    expect(formatFromFilename("noext")).toBeNull();
  });
});

describe("AnyDocParser（真实库 + 注入转换器）", () => {
  test("真实 docx fixture 转换（中文+表格）", async () => {
    const parser = new AnyDocParser({ ocrEnabled: false });
    const bytes = new Uint8Array(await Bun.file("tests/fixtures/test.docx").arrayBuffer());
    const { md } = await parser.convertFile(bytes, "test.docx");
    expect(md).toContain("zebra-anydoc-2026");
    expect(md).toContain("|"); // 表格转 GFM
  });

  test("needsOcr 无凭证 → ParseError 带 OCR 指引", async () => {
    const failing = async () => {
      throw { code: "needsOcr" };
    };
    const parser = new AnyDocParser({ ocrEnabled: false }, failing as never);
    expect(parser.convertFile(new Uint8Array([1]), "scan.pdf")).rejects.toMatchObject({ code: "needsOcr" });
  });

  test("needsOcr + OCR 凭证 → hosted 重试一次成功", async () => {
    let calls = 0;
    const convert = (async (_b: Uint8Array, _f?: unknown, opts?: { ocr?: string; apiKey?: string }) => {
      calls++;
      if (calls === 1) throw { code: "needsOcr" };
      expect(opts?.ocr).toBe("hosted");
      expect(opts?.apiKey).toBe("test-key");
      return "# ocr done";
    }) as never;
    const parser = new AnyDocParser({ ocrEnabled: true, apiKey: "test-key" }, convert);
    const { md } = await parser.convertFile(new Uint8Array([1]), "scan.pdf");
    expect(md).toContain("ocr done");
    expect(calls).toBe(2);
  });

  test("hosted 重试仍失败 → hosted 错误", async () => {
    const convert = (async () => {
      throw { code: "hosted", message: "upstream down" };
    }) as never;
    const parser = new AnyDocParser({ ocrEnabled: true, apiKey: "k" }, convert);
    expect(parser.convertFile(new Uint8Array([1]), "scan.pdf")).rejects.toMatchObject({ code: "hosted" });
  });
});
