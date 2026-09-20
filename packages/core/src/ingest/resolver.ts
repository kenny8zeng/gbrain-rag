import type { Config } from "../config";
import { DoclingParser } from "./docling";
import { createAnyDocParser } from "./anydoc-parser";
import { resolveParser, type FileParser, type ResolvedParser, type UrlParser } from "./parser";

/**
 * 解析器运行时单例（按影响解析链的**全部**配置项缓存；配置不变进程内稳定）。
 * 缓存键必须包含 PARSER_PREFERENCE —— 漏掉它会让「同一进程内换偏好却复用旧链」
 * （首选/回退方向错误），并使能力自描述与实际解析行为不一致。
 */
let cached: { key: string; resolved: ResolvedParser } | null = null;

export function resolveParserFor(cfg: Config): ResolvedParser {
  const key = `${cfg.PARSER_MODE}|${cfg.DOCLING_URL}|${cfg.PARSER_PREFERENCE}`;
  if (cached && cached.key === key) return cached.resolved;
  const docling: FileParser & UrlParser = new DoclingParser(cfg);
  const resolved = resolveParser(cfg, docling, createAnyDocParser(cfg));
  cached = { key, resolved };
  return resolved;
}
