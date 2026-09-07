import { mkdirSync, existsSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config";
import { docsDir, incomingDir } from "../config";
import { runGbrain, pageExists } from "../gbrain-cli";
import { resolveParserFor } from "./resolver";
import { convertWithFallback, parserLogFor } from "./fallback";

export interface IngestJob {
  id: string;
  kbId: string;
  type: "file" | "url" | "md";
  sourceRef: string;
  title: string | null;
}

export interface IngestOutcome {
  status: "done" | "done_with_warnings" | "failed";
  outcome?: "created" | "updated";
  docSlug?: string;
  error?: string;
  /** 解析路径记录（primary 或回退链，md 直传为空） */
  parserLog?: string;
}

/** 小写、非字母数字折叠为 -、去首尾 -、≤64 字符 */
export function slugifyName(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return s.length > 0 ? s : "doc";
}

export function deriveSlug(kbId: string, baseName: string): string {
  return `${kbId}/docs/${slugifyName(baseName)}`;
}

/** 剥离 body 已有的 YAML frontmatter（若有），统一替换为本服务的元数据块 */
export function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end === -1) return md;
  return md.slice(md.indexOf("\n", end + 1) + 1).replace(/^\n+/, "");
}

export function buildMarkdown(
  md: string,
  meta: { title: string; kb: string; sourceFile?: string; sourceUrl?: string; convertedAt: string },
): string {
  const body = stripFrontmatter(md);
  const lines = [
    "---",
    `title: ${JSON.stringify(meta.title)}`,
    `kb: ${meta.kb}`,
    ...(meta.sourceFile ? [`source_file: ${JSON.stringify(meta.sourceFile)}`] : []),
    ...(meta.sourceUrl ? [`source_url: ${JSON.stringify(meta.sourceUrl)}`] : []),
    `converted_at: ${meta.convertedAt}`,
    "---",
    "",
    body.trimStart(),
  ];
  return lines.join("\n");
}

/** 执行单个摄取任务：转换 → 规范化 → put(upsert) → embed。抛错即任务失败（worker 负责重试） */
export async function processIngestJob(cfg: Config, job: IngestJob): Promise<IngestOutcome> {
  let md: string;
  let baseName: string;
  let sourceFile: string | undefined;
  let sourceUrl: string | undefined;
  let parserLog: string | undefined;

  if (job.type === "md") {
    const rawPath = path.join(incomingDir(cfg), job.sourceRef);
    const raw = readFileSync(rawPath, "utf8");
    md = raw;
    baseName = job.title ?? job.sourceRef.replace(/\.md$/i, "");
    sourceFile = job.sourceRef;
  } else if (job.type === "url") {
    const r = await resolveParserFor(cfg).url!.convertUrl(job.sourceRef);
    md = r.md;
    baseName = (job.title ?? slugifyName(new URL(job.sourceRef).pathname.split("/").filter(Boolean).pop() ?? "")) || new URL(job.sourceRef).hostname;
    sourceUrl = job.sourceRef;
  } else {
    const rawPath = path.join(incomingDir(cfg), job.sourceRef);
    if (!existsSync(rawPath)) throw new Error(`incoming file missing: ${job.sourceRef}`);
    const bytes = readFileSync(rawPath);
    const conv = await convertWithFallback(resolveParserFor(cfg), new Uint8Array(bytes), path.basename(rawPath));
    md = conv.md;
    parserLog = parserLogFor(conv);
    baseName = job.title ?? path.basename(rawPath);
    sourceFile = job.sourceRef;
  }

  const title = baseName.trim() || "untitled";
  const slug = deriveSlug(job.kbId, title);
  const markdown = buildMarkdown(md, {
    title,
    kb: job.kbId,
    sourceFile,
    sourceUrl,
    convertedAt: new Date().toISOString(),
  });

  const existed = await pageExists(cfg, job.kbId, slug);

  let status: IngestOutcome["status"] = "done";
  let error: string | undefined;
  try {
    await runGbrain(cfg, {
      args: ["put", slug, "--content", markdown],
      source: job.kbId,
      timeoutMs: cfg.JOB_TIMEOUT_MS,
    });
  } catch (e) {
    const msg = (e as Error).message;
    // 存储层错误（repo/磁盘/写盘失败）= 页面未写入的真失败——绝不降级 warning
    if (/repo_not_found|storage_error|could not be written|no such file|ENOENT/i.test(msg)) {
      throw e;
    }
    // 其余 put 失败：gbrain put 会连带 embed——embedding 端点不可达时 CLI 非零退出但页面可能已写入。
    // 复核存在性：已写入则降级 done_with_warnings（关键词检索可用），否则真失败。
    if (await pageExists(cfg, job.kbId, slug)) {
      return {
        status: "done_with_warnings",
        outcome: existed ? "updated" : "created",
        docSlug: slug,
        error: `put partially failed (embed/unreachable?): ${msg.slice(0, 300)}`,
        parserLog,
      };
    }
    throw e;
  }

  // 注：不另跑显式 embed——gbrain put 已连带 embed（source 由 put 上下文正确解析）。
  // 引擎 embed 命令忽略 GBRAIN_SOURCE env 且无公开 --source（帮助未列），显式调用恒以
  // source=default 失败并误报 done_with_warnings；put 连带 embed 失败时上方 pageExists
  // 复核分支已降级处理（页面写入但未索引 → 关键词可检索）。

  // 归档原始文件（md/url 类型仅在 md 有暂存文件时归档）
  if (job.type === "file") {
    const src = path.join(incomingDir(cfg), job.sourceRef);
    const destDir = docsDir(cfg, job.kbId);
    mkdirSync(destDir, { recursive: true });
    renameSync(src, path.join(destDir, `${slugifyName(title)}${path.extname(job.sourceRef) || ".bin"}`));
  } else if (job.type === "md") {
    const src = path.join(incomingDir(cfg), job.sourceRef);
    const destDir = docsDir(cfg, job.kbId);
    mkdirSync(destDir, { recursive: true });
    renameSync(src, path.join(destDir, `${slugifyName(title)}.md`));
  }

  return { status, outcome: existed ? "updated" : "created", docSlug: slug, error, parserLog };
}
