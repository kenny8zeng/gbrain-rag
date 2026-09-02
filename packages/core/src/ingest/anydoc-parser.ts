import { formatFromBytes, toMarkdownBytes } from "@firecrawl/anydoc";
import type { Config } from "../config";
import { ParseError, type FileParser } from "./parser";

/** anydoc 错误码 → 任务失败原因（单一映射表，data-model §2） */
export function describeAnyDocError(code: string, detail?: string): string {
  switch (code) {
    case "needsOcr":
      return "扫描型 PDF：本地无 OCR；配置 FIRECRAWL_API_KEY 后可自动升级托管 OCR";
    case "unsupported":
      return `不支持的文档格式${detail ? `：${detail}` : ""}`;
    case "malformed":
      return "文档损坏或结构非法";
    case "encrypted":
      return "文档已加密，需先解密后导入";
    case "resourceLimit":
      return "文档超出资源限制（超大或过于复杂）";
    case "missingPart":
      return "文档缺少必需部件";
    case "io":
      return "文件读取失败";
    case "hosted":
      return `托管 OCR 转换失败${detail ? `：${detail}` : ""}`;
    default:
      return `文档解析失败（${code}）`;
  }
}

const EXT_FALLBACK: Record<string, string> = {
  doc: "doc", docx: "docx", docm: "docm",
  ppt: "ppt", pptx: "pptx", pps: "pps", ppsx: "ppsx", pptm: "pptm",
  xls: "xls", xlsx: "xlsx", xlsm: "xlsm", xlsb: "xlsb",
  odt: "odt", ods: "ods", odp: "odp",
  rtf: "rtf", epub: "epub", csv: "csv", pdf: "pdf",
};

/** 内容嗅探失败时的扩展名回退（CSV 无签名须显式格式） */
export function formatFromFilename(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_FALLBACK[ext] ?? null;
}

type AnyDocConvert = (
  bytes: Uint8Array,
  format?: unknown,
  options?: { ocr?: "hosted"; apiKey?: string },
) => Promise<string>;

/**
 * 进程内 native 解析器（anydoc）。实测：docx → GFM 完整，热调用 ~0.03ms。
 * OCR 可选升级：FIRECRAWL_API_KEY 配置时 needsOcr 自动以 hosted OCR 重试一次（FR-005）。
 */
export class AnyDocParser implements FileParser {
  readonly kind = "anydoc" as const;

  constructor(
    private readonly opts: { ocrEnabled: boolean; apiKey?: string },
    private readonly convert: AnyDocConvert = (bytes, format, options) => toMarkdownBytes(bytes, format as never, options as never),
  ) {}

  async convertFile(bytes: Uint8Array, filename: string): Promise<{ md: string }> {
    const format = formatFromBytes(bytes) ?? formatFromFilename(filename);
    if (!format) {
      throw new ParseError("unsupported", `无法识别文件格式（${filename}）`);
    }
    try {
      const md = await this.convert(bytes, format);
      return { md };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      const code = err.code ?? "io";
      // OCR 可选升级：一次 hosted 重试
      if (code === "needsOcr" && this.opts.ocrEnabled) {
        try {
          const md = await this.convert(bytes, format, { ocr: "hosted", apiKey: this.opts.apiKey });
          return { md };
        } catch (e2) {
          const err2 = e2 as { code?: string; message?: string };
          throw new ParseError(err2.code ?? "hosted", describeAnyDocError(err2.code ?? "hosted", err2.message));
        }
      }
      throw new ParseError(code, describeAnyDocError(code, err.message));
    }
  }
}

/** 从配置构造 anydoc 解析器 */
export function createAnyDocParser(cfg: Config): AnyDocParser {
  return new AnyDocParser({
    ocrEnabled: cfg.ANYDOC_OCR === true && Boolean(cfg.FIRECRAWL_API_KEY),
    apiKey: cfg.FIRECRAWL_API_KEY || undefined,
  });
}
