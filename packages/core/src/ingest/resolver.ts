import type { Config } from "../config";
import { DoclingParser } from "./docling";
import { createAnyDocParser } from "./anydoc-parser";
import { resolveParser, type FileParser, type ResolvedParser, type UrlParser } from "./parser";

/** 解析器运行时单例（按 DOCLING_URL/PARSER_MODE 缓存；配置不变进程内稳定） */
let cached: { key: string; resolved: ResolvedParser } | null = null;

export function resolveParserFor(cfg: Config): ResolvedParser {
  const key = `${cfg.PARSER_MODE}|${cfg.DOCLING_URL}`;
  if (cached && cached.key === key) return cached.resolved;
  const docling: FileParser & UrlParser = new DoclingParser(cfg);
  const resolved = resolveParser(cfg, docling, createAnyDocParser(cfg));
  cached = { key, resolved };
  return resolved;
}
