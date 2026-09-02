import { ParseError } from "./parser";
import type { ResolvedParser } from "./parser";

export interface FallbackResult {
  md: string;
  /** 实际完成转换的解析器 */
  used: "docling" | "anydoc";
  /** 回退链说明（primary 失败摘要）；primary 直成时为 undefined */
  fallbackFrom?: string;
}

const SUMMARY_LEN = 200;

/**
 * 文件转换带回退（005）：try primary → 失败记录原错误 → fallback 存在则重试一次 →
 * 成功带链记录；双失败抛最终错误（含链说明）。回退仅一次由链结构保证。
 */
export async function convertWithFallback(
  chain: ResolvedParser,
  bytes: Uint8Array,
  filename: string,
): Promise<FallbackResult> {
  try {
    const { md } = await chain.primary.convertFile(bytes, filename);
    return { md, used: chain.mode };
  } catch (primaryErr) {
    const primaryMsg = (primaryErr as Error).message ?? String(primaryErr);
    if (chain.fallback) {
      try {
        const { md } = await chain.fallback.convertFile(bytes, filename);
        const fallbackKind: "docling" | "anydoc" = chain.mode === "docling" ? "anydoc" : "docling";
        return { md, used: fallbackKind, fallbackFrom: `${primaryMsg.slice(0, SUMMARY_LEN)}` };
      } catch (fallbackErr) {
        throw new ParseError(
          "fallback_failed",
          `${chain.mode} 失败（${primaryMsg.slice(0, 120)}），回退后亦失败（${(fallbackErr as Error).message.slice(0, 200)}）`,
        );
      }
    }
    throw primaryErr;
  }
}

/** parser_log 文案（data-model §2）：primary 成功 / 回退成功链 */
export function parserLogFor(result: FallbackResult): string {
  return result.fallbackFrom ? `${result.used === "docling" ? "anydoc" : "docling"}→${result.used}: ${result.fallbackFrom}` : result.used;
}
