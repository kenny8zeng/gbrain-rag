import { z } from "zod";

/** 统一错误 envelope（响应仅声明形状，运行时多余键不校验） */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// ---------- KB ----------

export const KbCreateBody = z.object({ name: z.string().min(1).max(200) });

export const KbView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  pageCount: z.number().optional(),
  federated: z.boolean().optional(),
  lastSyncAt: z.string().nullable().optional(),
  created_at: z.string().optional(),
});

// ---------- Keys ----------

export const KeyIssueBody = z.object({
  label: z.string().min(1).max(100),
  write_kb: z.string().optional(),
  read_kbs: z.array(z.string()).default([]),
  surface: z.string().optional(),
  concurrency: z.number().int().positive().optional(),
});

export const KeyIssued = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  write_kb: z.string().nullable(),
  read_kbs: z.array(z.string()),
  surface: z.string(),
  created_at: z.string(),
});

export const KeyPatchBody = z.object({
  write_kb: z.string().optional(),
  read_kbs: z.array(z.string()).optional(),
  concurrency: z.number().int().positive().optional(),
});

export const KeyView = z.object({
  id: z.string(),
  key_prefix: z.string(),
  label: z.string(),
  write_kb: z.string().nullable(),
  read_kbs: z.array(z.string()),
  surface: z.string(),
  concurrency: z.number(),
  created_at: z.string(),
  revoked_at: z.string().nullable(),
});

// ---------- Jobs ----------

export const JobView = z.object({
  id: z.string(),
  kb_id: z.string(),
  type: z.string(),
  status: z.string(),
  attempts: z.number(),
  error: z.string().nullable(),
  outcome: z.string().nullable(),
  doc_slug: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

// ---------- Documents ----------

export const SubmitAccepted = z.object({
  job_id: z.string(),
  kb_id: z.string(),
  status: z.string(),
});

export const UrlImportBody = z.object({ url: z.url(), title: z.string().optional() });

// ---------- Retrieval ----------

export const RetrievalBody = z.object({
  query: z.string().min(1).max(2000),
  mode: z.enum(["hybrid", "keyword"]).default("hybrid"),
  top_k: z.number().int().positive().max(100).optional(),
});

export const RetrievalHit = z.object({
  slug: z.string(),
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
  source_id: z.string().nullable(),
});

export const RetrievalResponse = z.object({
  results: z.array(RetrievalHit),
  mode: z.string(),
  degraded: z.array(z.string()),
});

// ---------- System ----------

export const Health = z.object({
  status: z.string(),
  gbrain_serve: z.boolean(),
  db: z.boolean(),
  docling: z.boolean(),
});

/** 鉴权方案引用（docs 内的 security 字段形状） */
export const SecurityAdmin = { adminToken: [] as string[] };
export const SecurityTenant = { apiKey: [] as string[] };
