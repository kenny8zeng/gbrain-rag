import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Services } from "../../app";
import type { Env } from "../../middleware/auth";
import { libHandler } from "../handler";
import { runGbrain } from "@core/gbrain-cli";
import { capabilityEnabled, capabilityGaps, readEndpointModelEnv } from "@core/model-router";
import { probeAll, ProbeError, type ProbeErrorCode } from "@core/endpoint-probe";
import { modelConfigState } from "@core/model-config";

/** admin Bearer 中间件类型 */
type Admin = (c: Context<Env>, next: () => Promise<void>) => Promise<Response | void>;

const CapabilityInput = z.object({
  baseUrl: z.string().url().describe("OpenAI 兼容端点地址"),
  model: z.string().min(1).refine((m) => !m.includes(":"), "模型为纯名称（禁止含 ':' 前缀标记）"),
  apiKey: z.string().min(1),
});
const ModelsApplyBody = z.object({
  chat: CapabilityInput.optional(),
  embedding: CapabilityInput.extend({ dims: z.number().int().positive().optional() }).optional(),
  rerank: CapabilityInput.optional(),
  apply: z.boolean().default(true).describe("true=探测通过后执行 config set 装配；false=仅探测"),
});

const CapabilityView = z.object({
  state: z.enum(["ready", "unconfigured", "gap", "probe_failed"]),
  missing: z.array(z.string()).optional(),
  error: z.enum(["ENDPOINT_UNREACHABLE", "KEY_REJECTED", "MODEL_NOT_FOUND", "CAPABILITY_UNSUPPORTED", "PROBE_TIMEOUT"]).nullable().optional(),
  detail: z.string().nullable().optional(),
  dim: z.number().nullable().optional(),
  rerank_path: z.enum(["rerank", "reranks"]).nullable().optional(),
});
const ModelsApplyView = z.object({
  capabilities: z.object({ chat: CapabilityView, embedding: CapabilityView, rerank: CapabilityView }),
  config_sets_applied: z.array(z.object({ key: z.string(), value: z.string() })),
  hint: z.string(),
});
const ModelsView = z.object({
  capabilities: z.object({ chat: CapabilityView, embedding: CapabilityView, rerank: CapabilityView }),
  engine: z.object({
    chat_model: z.string(),
    embedding_model: z.string(),
    embedding_dimensions: z.string(),
    reranker_model: z.string().nullable(),
    reranker_enabled: z.boolean(),
  }),
  complete: z.boolean(),
});

const applyRoute = createRoute({
  method: "post",
  path: "/v1/admin/models",
  tags: ["admin"],
  summary: "模型配置：探测 + 装配（端点三要素）",
  security: [{ adminToken: [] }],
  request: { body: { required: true, content: { "application/json": { schema: ModelsApplyBody } } } },
  responses: {
    200: { description: "探测报告 + 装配结果", content: { "application/json": { schema: ModelsApplyView } } },
    422: { description: "探测失败（错误码 + 人话）" },
  },
});
const viewRoute = createRoute({
  method: "get",
  path: "/v1/admin/models",
  tags: ["admin"],
  summary: "模型配置状态",
  security: [{ adminToken: [] }],
  responses: { 200: { description: "配置状态", content: { "application/json": { schema: ModelsView } } } },
});

function viewOf(input: { baseUrl: string; model: string; apiKey: string }, label: string, probe: { ok: boolean; error?: ProbeErrorCode; dim?: number; path?: "rerank" | "reranks" } | undefined, extra: { missing?: string[]; detail?: string } = {}) {
  const enabled = capabilityEnabled(input);
  const gaps = enabled ? undefined : capabilityGaps(input, label);
  return {
    state: (!enabled ? (gaps && gaps.length < 3 ? "gap" : "unconfigured") : probe ? (probe.ok ? "ready" : "probe_failed") : "ready") as "ready" | "unconfigured" | "gap" | "probe_failed",
    missing: gaps,
    error: probe && !probe.ok ? ((probe.error as ProbeErrorCode | undefined) ?? null) : null,
    detail: extra.detail ?? null,
    dim: probe?.dim ?? null,
    rerank_path: probe?.path ?? null,
  };
}

export function registerModelAdminRoutes(app: OpenAPIHono<Env>, svc: Services, admin: Admin): void {
  app.openapi(applyRoute, libHandler<typeof applyRoute>(async (c: Context<Env>) => {
    const parsed = ModelsApplyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_PARAMS", message: "body 需含 chat/embedding/rerank 的端点三要素（base_url/model/api_key）" } }, 422);
    }
    const body = parsed.data;

    const probe = await probeAll({
      chat: body.chat ? { baseUrl: body.chat.baseUrl, model: body.chat.model, apiKey: body.chat.apiKey } : undefined,
      embedding: body.embedding ? { baseUrl: body.embedding.baseUrl, model: body.embedding.model, apiKey: body.embedding.apiKey } : undefined,
      rerank: body.rerank ? { baseUrl: body.rerank.baseUrl, model: body.rerank.model, apiKey: body.rerank.apiKey } : undefined,
    });

    const capabilities = {
      chat: viewOf(body.chat ?? { baseUrl: "", model: "", apiKey: "" }, "CHAT", probe.chat.ok ? probe.chat : probe.chat.error ? probe.chat : undefined),
      embedding: viewOf(body.embedding ?? { baseUrl: "", model: "", apiKey: "" }, "EMBEDDING", probe.embedding),
      rerank: viewOf(body.rerank ?? { baseUrl: "", model: "", apiKey: "" }, "RERANK", probe.rerank),
    };

    // 探测失败 → 422（人话 + 错误码）
    const failed = (Object.entries(probe) as Array<[keyof typeof probe, { ok: boolean; error?: ProbeErrorCode }]>).find(([, p]) => !p.ok && p.error);
    if (failed) {
      const [cap, p] = failed;
      const msg =
        p.error === "ENDPOINT_UNREACHABLE" ? "端点不可达：检查地址" :
        p.error === "KEY_REJECTED" ? "凭证被拒绝（401/403）：检查 API key" :
        p.error === "MODEL_NOT_FOUND" ? "模型在该端点不可用：检查型号" :
        "该端点不支持此能力";
      return c.json(
        { error: { code: p.error, message: `${cap}: ${msg}` }, capabilities },
        422,
      );
    }

    const applied: Array<{ key: string; value: string }> = [];
    if (body.apply) {
      // rerank /reranks 槽 → config set 装配（幂等）
      if (body.rerank && probe.rerank.path === "reranks") {
        const sets = [
          { key: "search.reranker.model", value: `dashscope-rerank:${body.rerank.model}` },
          { key: "search.reranker.enabled", value: "true" },
          { key: "provider_base_urls.dashscope-rerank", value: body.rerank.baseUrl },
        ];
        for (const s of sets) {
          await runGbrain(svc.cfg, { args: ["config", "set", s.key, s.value], timeoutMs: 30_000 });
          applied.push(s);
        }
      }
      // env 类派生已由 entrypoint 完成（容器重启后生效）；apply 场景提示重启以注入 key/端点 env
    }

    return c.json({
      capabilities,
      config_sets_applied: applied,
      hint: "端点/模型/key 的 env 派生由服务启动时自动注入；apply 仅执行引擎 schema 级装配。若本次探测值与当前 env 不同，请同步 env 后重启。",
    } satisfies z.infer<typeof ModelsApplyView>);
  }));

  app.openapi(viewRoute, libHandler<typeof viewRoute>(async (c: Context<Env>) => {
    const u = readEndpointModelEnv({ ...process.env } as Record<string, string>);
    const state = modelConfigState(svc.cfg);
    let rerankerModel: string | null = null;
    let rerankerEnabled = false;
    try {
      const m = await runGbrain(svc.cfg, { args: ["config", "get", "search.reranker.model"], timeoutMs: 30_000 }).then((r) => r.stdout.trim()).catch(() => "");
      const e = await runGbrain(svc.cfg, { args: ["config", "get", "search.reranker.enabled"], timeoutMs: 30_000 }).then((r) => r.stdout.trim()).catch(() => "");
      rerankerModel = m || null;
      rerankerEnabled = e === "true";
    } catch {
      // config get 不可用时保持默认
    }
    return c.json({
      capabilities: {
        chat: viewOf(u.chat, "CHAT", state.chat ? { ok: true } : undefined),
        embedding: viewOf(u.embedding, "EMBEDDING", state.embedding ? { ok: true } : undefined),
        rerank: viewOf(u.rerank, "RERANK", state.rerank ? { ok: true } : undefined),
      },
      engine: {
        chat_model: svc.cfg.GBRAIN_CHAT_MODEL,
        embedding_model: svc.cfg.GBRAIN_EMBEDDING_MODEL,
        embedding_dimensions: svc.cfg.GBRAIN_EMBEDDING_DIMENSIONS,
        reranker_model: rerankerModel,
        reranker_enabled: rerankerEnabled,
      },
      complete: state.chat && state.embedding && state.rerank,
    } satisfies z.infer<typeof ModelsView>);
  }));
}
