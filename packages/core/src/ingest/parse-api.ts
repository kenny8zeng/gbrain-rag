import type { Config } from "../config";
import type { ResolvedParser } from "./parser";
import { ParserUnavailableError } from "./parser";
import { formatFromFilename, sniffFormatFromBytes, supportedExtensions } from "./anydoc-parser";
import { convertWithFallback } from "./fallback";
import { resolveParserFor } from "./resolver";

/**
 * 裸解析（009）：把既有解析链（005）暴露为对外只读能力。
 * 零写入——不产生页面/图谱/任务，输入仅内存传递（不落盘）。
 *
 * 与导入路径的**唯一**差异：`.txt` 也直通（导入路径对 .txt 会送解析链并失败）。
 * 见 specs/009-document-parse-api/research.md R10/R11。
 */

// ─── 类型（对齐 specs/009-document-parse-api/data-model.md）────────

export type ParseInputKind = "file" | "url" | "text";

/** 实际生效的解析路径：具体解析器，或纯文本直通 */
export type ParsePath = "docling" | "anydoc" | "passthrough";

export interface ParseResult {
  markdown: string;
  parser: ParsePath;
  /** 发生回退时给出首选失败的摘要（≤200 字符） */
  fallback_from: string | null;
  duration_ms: number;
  chars: number;
  /** 正文为空仍为成功（不伪装失败） */
  empty: boolean;
}

export interface ParseCapabilityProfile {
  primary: "docling" | "anydoc";
  available_channels: Array<"anydoc" | "docling">;
  /** 是否接受网页地址（== chain.url !== null，即外部解析服务可用） */
  accepts_url: boolean;
  /** 可受理**扩展名**（内容嗅探可受理列表外类型，见 sniff note） */
  supported_file_types: string[];
  passthrough_types: string[];
  concurrency: number;
}

/** 纯文本类扩展名（直通；与导入路径的 md 直通对齐，.txt 为本端点扩展） */
export const PASSTHROUGH_EXTS = ["md", "txt"] as const;

/** 解析失败分类码（与 contracts/parse-api.md 错误码表一致） */
export type ParseFailureCode =
  | "UNSUPPORTED_FILE_TYPE"
  | "PARSER_UNAVAILABLE"
  | "PARSE_FAILED"
  | "PARSE_TIMEOUT"
  | "PARSE_BUSY";

// ─── 解析专用有界信号量（T006）─────────────────────────────────
// 与 gbrain-cli.ts 同构：上限获取、有界排队、超等待抛饱和、finally 释放。
// **执行超时不含排队时间**（排队超时即饱和错误，不进入执行）。

export class ParseBusyError extends Error {
  readonly code = "PARSE_BUSY";
  constructor(readonly waitMs: number) {
    super(`parse concurrency saturated (waited ${waitMs}ms); retry shortly`);
    this.name = "ParseBusyError";
  }
}

let parseActive = 0;
const parseWaiters: Array<{ resolve: (release: () => void) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

/** 测试/观测：当前在飞与排队数 */
export function parseGateState(): { active: number; waiting: number } {
  return { active: parseActive, waiting: parseWaiters.length };
}

function makeRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    parseActive -= 1;
    const next = parseWaiters.shift();
    if (next) {
      clearTimeout(next.timer);
      parseActive += 1;
      next.resolve(makeRelease());
    }
  };
}

async function acquireParseSlot(limit: number, waitMs: number): Promise<() => void> {
  if (parseActive < limit) {
    parseActive += 1;
    return makeRelease();
  }
  return new Promise<() => void>((resolve, reject) => {
    const entry = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const i = parseWaiters.indexOf(entry);
        if (i >= 0) parseWaiters.splice(i, 1);
        reject(new ParseBusyError(waitMs));
      }, waitMs),
    };
    parseWaiters.push(entry);
  });
}

/** 在解析闸门内执行；饱和抛 ParseBusyError（调用方映射 503） */
export async function withParseSlot<T>(cfg: Config, fn: () => Promise<T>): Promise<T> {
  const limit = Number.isFinite(cfg.PARSE_CONCURRENCY) && cfg.PARSE_CONCURRENCY > 0 ? cfg.PARSE_CONCURRENCY : 4;
  const waitMs = Number.isFinite(cfg.GBRAIN_CLI_QUEUE_WAIT_MS) && cfg.GBRAIN_CLI_QUEUE_WAIT_MS > 0
    ? cfg.GBRAIN_CLI_QUEUE_WAIT_MS
    : 60_000;
  const release = await acquireParseSlot(limit, waitMs);
  try {
    return await fn();
  } finally {
    release();
  }
}

// ─── 受理判定（T007 双轨）──────────────────────────────────────

function extOf(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

/** 扩展名轨：用于**能力自描述**（无内容可嗅探）与内容不可识别时的回退 */
export function isSupportedByExtension(filename: string): boolean {
  return formatFromFilename(filename) !== null;
}

/**
 * 内容轨：**实际受理判定**必须用它（FR-008 内容优先）。
 * 与解析通道自身的判定链完全一致：内容嗅探 → 扩展名回退。
 */
export function isSupportedBytes(bytes: Uint8Array, filename: string): boolean {
  return sniffFormatFromBytes(bytes) !== null || formatFromFilename(filename) !== null;
}

/** 纯文本直通判定（`.md`/`.txt`，大小写不敏感） */
export function isPassthroughInput(filename: string): boolean {
  return (PASSTHROUGH_EXTS as readonly string[]).includes(extOf(filename));
}

/** 独立图片（外部解析服务独有能力；未配置时应报通道不可用而非类型不支持） */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif", "svg", "heic"]);
export function isImageInput(filename: string): boolean {
  return IMAGE_EXTS.has(extOf(filename));
}

// ─── 能力自描述（T008）────────────────────────────────────────

/** 扩展名轨的白名单：直接取 anydoc 的单一事实来源（键序稳定，无需第二份表） */
export function supportedExtensionList(): string[] {
  return supportedExtensions();
}

export function buildCapabilityProfile(cfg: Config, chain?: ResolvedParser): ParseCapabilityProfile {
  const resolved = chain ?? resolveParserFor(cfg);
  const channels: Array<"anydoc" | "docling"> = ["anydoc"];
  if (resolved.url !== null) channels.push("docling");
  return {
    primary: resolved.mode,
    available_channels: channels,
    accepts_url: resolved.url !== null,
    supported_file_types: supportedExtensionList(),
    passthrough_types: [...PASSTHROUGH_EXTS],
    concurrency: cfg.PARSE_CONCURRENCY,
  };
}

// ─── 解析主流程（T012）───────────────────────────────────────

export class UnsupportedFileTypeError extends Error {
  readonly code = "UNSUPPORTED_FILE_TYPE";
  constructor(readonly fileName: string) {
    super(
      `unsupported file type: ${fileName} cannot be parsed by the built-in parser, and no external parse service is configured (set the external parse service address to enable broader format coverage)`,
    );
    this.name = "UnsupportedFileTypeError";
  }
}

export function toFailureCode(e: unknown): ParseFailureCode {
  if (e instanceof ParseBusyError) return "PARSE_BUSY";
  if (e instanceof UnsupportedFileTypeError) return "UNSUPPORTED_FILE_TYPE";
  if (e instanceof ParserUnavailableError) return "PARSER_UNAVAILABLE";
  const name = (e as { name?: string })?.name ?? "";
  if (name === "TimeoutError" || name === "AbortError") return "PARSE_TIMEOUT";
  return "PARSE_FAILED";
}

export interface ParseDeps {
  cfg: Config;
  /** 可注入解析链（测试用）；缺省走 resolveParserFor(cfg) */
  chain?: ResolvedParser;
}

/** 纯文本直通（零解析、不消耗并发额度） */
export function parsePassthrough(text: string, startedAt: number): ParseResult {
  const markdown = text;
  return {
    markdown,
    parser: "passthrough",
    fallback_from: null,
    duration_ms: Date.now() - startedAt,
    chars: markdown.length,
    empty: markdown.trim() === "",
  };
}

/**
 * 文件解析：受理判定（内容优先）→ 解析链（primary → 回退）。
 * 不经引擎 CLI，故不占用知识库引擎容量（FR-011）。
 */
export async function parseFile(deps: ParseDeps, bytes: Uint8Array, filename: string, startedAt: number): Promise<ParseResult> {
  const chain = deps.chain ?? resolveParserFor(deps.cfg);
  if (chain.url === null && !isSupportedBytes(bytes, filename)) {
    throw new UnsupportedFileTypeError(filename);
  }
  const r = await convertWithFallback(chain, bytes, filename);
  return {
    markdown: r.md,
    parser: r.used,
    fallback_from: r.fallbackFrom ?? null,
    duration_ms: Date.now() - startedAt,
    chars: r.md.length,
    empty: r.md.trim() === "",
  };
}

/** 网页解析：能力归属外部解析服务；未配置即通道不可用（判定先于任何出站） */
export async function parseUrl(deps: ParseDeps, url: string, startedAt: number): Promise<ParseResult> {
  const chain = deps.chain ?? resolveParserFor(deps.cfg);
  if (chain.url === null) throw new ParserUnavailableError("url");
  const { md } = await chain.url.convertUrl(url);
  return {
    markdown: md,
    parser: "docling",
    fallback_from: null,
    duration_ms: Date.now() - startedAt,
    chars: md.length,
    empty: md.trim() === "",
  };
}

/** 图片：外部解析服务独有能力（未配置即通道不可用） */
export async function parseImage(deps: ParseDeps, bytes: Uint8Array, filename: string, startedAt: number): Promise<ParseResult> {
  const chain = deps.chain ?? resolveParserFor(deps.cfg);
  if (chain.url === null) throw new ParserUnavailableError("image");
  return parseFile(deps, bytes, filename, startedAt);
}

/** 供路由统一收口：把 domain 错误映射为失败码 */
export function describeParseFailure(e: unknown): { code: ParseFailureCode; message: string } {
  const code = toFailureCode(e);
  const msg = (e as Error)?.message ?? String(e);
  return { code, message: msg.slice(0, 400) };
}
