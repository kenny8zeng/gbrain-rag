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
  result_summary: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

// ---------- Documents ----------

export const SubmitAccepted = z.object({
  job_id: z.string(),
  kb_id: z.string(),
  status: z.string(),
});

export const BulkAccepted = z.object({
  job_id: z.string(),
  kb_id: z.string(),
  files: z.number(),
  entities: z.number(),
  status: z.string(),
});

export const BulkDryRunView = z.object({
  kb_id: z.string(),
  files: z.array(z.object({ file: z.string(), slug: z.string() })),
  entities: z.number(),
  skipped: z.array(z.object({ file: z.string(), reason: z.string() })),
});

export const UrlImportBody = z.object({ url: z.url(), title: z.string().optional() });

// ---------- Retrieval ----------

export const GraphExpansionBody = z.object({
  /** 展开跳数（2 = 文档→概念→相邻文档；默认 2） */
  depth: z.number().int().min(1).max(3).default(2),
  /** 用向量前 N 条做种子（缺省 = 全部返回结果） */
  seed_k: z.number().int().min(1).max(20).optional(),
  /** 图谱发现结果上限 */
  max_results: z.number().int().min(1).max(50).default(10),
});

export const RetrievalBody = z.object({
  query: z.string().min(1).max(2000),
  mode: z.enum(["hybrid", "keyword"]).default("hybrid"),
  top_k: z.number().int().positive().max(100).optional(),
  /**
   * 图谱增强检索（可选）。缺省 = 纯向量/关键词（行为与历史完全一致）；
   * 给出则在同一次调用里追加"经概念关联到的相邻文档"。
   */
  graph: GraphExpansionBody.optional(),
});

export const RetrievalHit = z.object({
  slug: z.string(),
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
  source_id: z.string().nullable(),
});

export const GraphHit = z.object({
  slug: z.string(),
  via_concepts: z.array(z.string()),
  seed_slugs: z.array(z.string()),
  shared_concepts: z.number().int(),
  /** 特异性加权分（排序依据） */
  weight: z.number(),
});

export const RetrievalResponse = z.object({
  results: z.array(RetrievalHit),
  mode: z.string(),
  degraded: z.array(z.string()),
  /** 图谱增强检索发现的相关文档；未请求图谱时缺省 */
  graph_results: z.array(GraphHit).optional(),
});

// ---------- System ----------

export const Health = z.object({
  status: z.string(),
  gbrain_serve: z.boolean(),
  db: z.boolean(),
  docling: z.boolean(),
  parser_mode: z.enum(["docling", "anydoc"]),
  parser_primary: z.enum(["docling", "anydoc"]),
  parser_preference: z.enum(["docling", "anydoc"]),
  models: z.object({ embedding: z.boolean(), rerank: z.boolean(), chat: z.boolean() }),
});

/** 鉴权方案引用（docs 内的 security 字段形状） */
export const SecurityAdmin = { adminToken: [] as string[] };
export const SecurityTenant = { apiKey: [] as string[] };
