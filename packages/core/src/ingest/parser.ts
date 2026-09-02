import type { Config } from "../config";

/** 通道能力缺失：内置解析器模式不支持 url/图片（spec FR-004） */
export class ParserUnavailableError extends Error {
  constructor(readonly channel: "url" | "image") {
    super(
      channel === "url"
        ? "网页 URL 导入需要配置 DOCLING_URL（当前为内置解析器模式）"
        : "图片导入需要配置 DOCLING_URL（当前为内置解析器模式）",
    );
    this.name = "ParserUnavailableError";
  }
}

/** 解析失败（携带分类码，映射表见 anydoc-parser/错误分类） */
export class ParseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

export interface FileParser {
  kind: "docling" | "anydoc";
  /** 文档/图片文件 → Markdown（docling 模式支持图片；anydoc 模式不支持独立图片） */
  convertFile(bytes: Uint8Array, filename: string): Promise<{ md: string }>;
}

export interface UrlParser {
  /** 网页 URL → Markdown（仅 docling 模式具备） */
  convertUrl(url: string): Promise<{ md: string }>;
}

export interface ResolvedParser {
  /** 首选（当前生效主解析器） */
  mode: "docling" | "anydoc";
  primary: FileParser;
  /** 回退解析器（仅文件类；强制模式/anydoc 唯一时为 null——无回退） */
  fallback: FileParser | null;
  /** docling 独有能力（URL/图片）；anydoc 唯一/强制时为 null（FR-004） */
  url: UrlParser | null;
}

/**
 * 解析链选择（005，research D2 矩阵）：
 * - PARSER_MODE=docling|anydoc：强制单解析器（无回退，测试/排障语义）
 * - auto + DOCLING_URL 空：anydoc 唯一（无回退、无 url）
 * - auto + DOCLING_URL 配置：双解析器并存，PARSER_PREFERENCE 决定首选，另一为回退
 */
export function resolveParser(cfg: Config, docling: FileParser & UrlParser, anydoc: FileParser): ResolvedParser {
  const forced = cfg.PARSER_MODE !== "auto" ? cfg.PARSER_MODE : null;
  if (forced === "docling") return { mode: "docling", primary: docling, fallback: null, url: docling };
  if (forced === "anydoc") return { mode: "anydoc", primary: anydoc, fallback: null, url: null };
  if (!cfg.DOCLING_URL) return { mode: "anydoc", primary: anydoc, fallback: null, url: null };
  return cfg.PARSER_PREFERENCE === "anydoc"
    ? { mode: "anydoc", primary: anydoc, fallback: docling, url: docling }
    : { mode: "docling", primary: docling, fallback: anydoc, url: docling };
}
