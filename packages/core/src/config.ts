import { z } from "zod";
import path from "node:path";

export const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  ADMIN_TOKEN: z.string().min(16, "ADMIN_TOKEN must be at least 16 characters"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  /** 外部解析服务地址：空 = 内置解析器（anydoc）；PARSER_MODE=docling 时必填 */
  DOCLING_URL: z.string().refine((v) => v === "" || /^https?:\/\//.test(v), "DOCLING_URL must be a URL or empty"),
  GBRAIN_BIN: z.string().default("/usr/local/bin/gbrain"),
  GBRAIN_SERVE_PORT: z.coerce.number().int().positive().default(7333),
  /** 宿主机开发时可设 false 跳过 serve 子进程（MCP 面不可用） */
  GBRAIN_SERVE_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  DATA_DIR: z.string().default("./data"),
  ADMIN_SPEC_DIR: z.string().default("./deploy/clis"),
  MIGRATIONS_DIR: z.string().default("./deploy/migrations"),
  MCP_SURFACE: z.enum(["verbs", "starter", "full"]).default("starter"),
  MCP_DEFAULT_CONCURRENCY: z.coerce.number().int().positive().default(4),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000), // docling 调用另受 110s 下限约束
  JOB_STALE_MS: z.coerce.number().int().positive().default(1_800_000),
  JOB_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(104_857_600),
  /** 跨域来源列表（逗号分隔；空=关闭；* = 显式全放行） */
  // ---- 统一模型配置面（三要素心智：PROVIDER + 纯模型名；派生见 model-router.ts）----
  // ---- 端点三要素配置面（唯一用户入口；仅 OpenAI 兼容 API）----
  CHAT_BASE_URL: z.string().default(""),
  CHAT_MODEL: z.string().default(""),
  CHAT_API_KEY: z.string().default(""),
  // ---- 梦境周期调度（默认关；light=仅关系提取无LLM / full=全部维护阶段）----
  DREAM_ENABLED: z.string().default("false"),
  /** cron 5 段表达式（如 "0 4 * * *" 每日凌晨 4 点）；空 = 仅手工触发 */
  DREAM_CRON: z.string().default("0 4 * * *"),
  DREAM_TIER: z.enum(["light", "full"]).default("light"),
  // ---- 引擎槽位派生变量（服务内部产物，用户不配置）----
  EMBEDDING_BASE_URL: z.string().default(""),
  EMBEDDING_MODEL: z.string().default(""),
  EMBEDDING_DIMENSIONS: z.string().default(""),
  EMBEDDING_API_KEY: z.string().default(""),
  RERANK_BASE_URL: z.string().default(""),
  RERANK_MODEL: z.string().default(""),
  RERANK_API_KEY: z.string().default(""),
  /** 解析器模式：auto=按 DOCLING_URL（默认）| anydoc | docling */
  PARSER_MODE: z.enum(["auto", "anydoc", "docling"]).default("auto"),
  /** 双解析器并存时的首选（docling 配置时生效）：docling | anydoc */
  PARSER_PREFERENCE: z.enum(["docling", "anydoc"]).default("docling"),
  /** anydoc 托管 OCR（需 FIRECRAWL_API_KEY；开启后扫描 PDF 自动升级，数据出机器） */
  ANYDOC_OCR: z
    .string()
    .default("off")
    .transform((v) => v === "on" || v === "true"),
  FIRECRAWL_API_KEY: z.string().default(""),
  // ---- gbrain 模型透传变量（原生命名；与中立变量映射共存，见 entrypoint.sh / model-config.ts）----
  GBRAIN_CHAT_MODEL: z.string().default(""),
  GBRAIN_EMBEDDING_MODEL: z.string().default(""),
  GBRAIN_EMBEDDING_DIMENSIONS: z.string().default(""),
  GBRAIN_RERANKER_MODEL: z.string().default(""),
  LLAMA_SERVER_BASE_URL: z.string().default(""),
  LLAMA_SERVER_API_KEY: z.string().default(""),
  LLAMA_SERVER_RERANKER_BASE_URL: z.string().default(""),
  LLAMA_SERVER_RERANKER_API_KEY: z.string().default(""),
  CORS_ORIGINS: z.string().default("").refine((v) => {
    for (const entry of v.split(",").map((e) => e.trim()).filter(Boolean)) {
      if (entry === "*") continue;
      if (!/^[a-z][a-z0-9+.-]*:\/\/[^/]+$/i.test(entry)) return false;
    }
    return true;
  }, "CORS_ORIGINS entries must be origins (scheme://host[:port]) or '*'"),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cfg = configSchema.parse(env);
  if (cfg.PARSER_MODE === "docling" && cfg.DOCLING_URL === "") {
    throw new Error("DOCLING_URL is required when PARSER_MODE=docling");
  }
  return cfg;
}

export function brainDir(cfg: Config, kbId: string): string {
  return path.join(cfg.DATA_DIR, "brains", kbId);
}

export function docsDir(cfg: Config, kbId: string): string {
  return path.join(cfg.DATA_DIR, "docs", kbId);
}

export function incomingDir(cfg: Config): string {
  return path.join(cfg.DATA_DIR, "incoming");
}

/** 解析后的跨域来源列表（空数组 = 特性关闭） */
export function corsOrigins(cfg: Config): string[] {
  return cfg.CORS_ORIGINS.split(",").map((e) => e.trim()).filter(Boolean);
}
