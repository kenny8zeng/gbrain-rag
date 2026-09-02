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
  kind: "docling" | "anydoc";
  file: FileParser;
  url: UrlParser | null; // anydoc 模式为 null（FR-004）
}

/**
 * 解析器选择：PARSER_MODE=anydoc|docling 显式覆盖；auto（默认）按 DOCLING_URL 是否配置。
 * 启动/首次调用解析一次（配置不变）。
 */
export function resolveParser(cfg: Config, docling: FileParser & UrlParser, anydoc: FileParser): ResolvedParser {
  const mode = cfg.PARSER_MODE === "auto" ? (cfg.DOCLING_URL ? "docling" : "anydoc") : cfg.PARSER_MODE;
  return mode === "docling"
    ? { kind: "docling", file: docling, url: docling }
    : { kind: "anydoc", file: anydoc, url: null };
}
