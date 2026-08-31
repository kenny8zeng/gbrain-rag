import { z } from "zod";
import path from "node:path";

export const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  ADMIN_TOKEN: z.string().min(16, "ADMIN_TOKEN must be at least 16 characters"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DOCLING_URL: z.string().url("DOCLING_URL must be a valid URL"),
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
  JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  JOB_STALE_MS: z.coerce.number().int().positive().default(1_800_000),
  JOB_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(104_857_600),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return configSchema.parse(env);
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
