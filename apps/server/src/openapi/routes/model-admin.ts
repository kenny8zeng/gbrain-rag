import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Services } from "../../app";
import type { Env } from "../../middleware/auth";
import { libHandler } from "../handler";
import { runGbrain } from "@core/gbrain-cli";
import {
  PROVIDER_FACTS,
  checkModelChoice,
  planModelAssembly,
  currentModelState,
  type ModelChoiceCheck,
} from "@core/model-profiles";

/** admin Bearer 中间件类型（与 admin.ts 共用签名） */
type Admin = (c: Context<Env>, next: () => Promise<void>) => Promise<Response | void>;

const ModelsApplyBody = z.object({
  provider: z.string().min(1).describe("供应商档案 id（dashscope | openrouter）"),
  chat_model: z.string().optional().describe("chat 模型 id（档案内或宽放行通道）"),
  embedding_model: z.string().optional().describe("embedding 模型 id（白名单内直连 / 白名单外自动别名通道）"),
  embedding_dims: z.number().int().positive().optional().describe("embedding 维度（缺省取档案，未知则报错提示）"),
  rerank_model: z.string().optional().describe("rerank 模型 id（缺省取档案默认）"),
  apply: z.boolean().default(true).describe("true=执行 config set 装配；false=仅预检"),
});

const ModelsApplyView = z.object({
  provider: z.string(),
  applied: z.array(z.object({ key: z.string(), value: z.string() })),
  env_required: z.array(z.string()),
  checks: z.array(
    z.object({
      capability: z.enum(["chat", "embedding", "rerank"]),
      ok: z.boolean(),
      route: z.enum(["direct", "alias", "none"]).nullable(),
      provider_model: z.string().nullable(),
      dim: z.number().nullable(),
      warnings: z.array(z.string()).nullable(),
      error: z.string().nullable(),
    }),
  ),
  hint: z.string(),
});

const ModelsView = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      api_key_env: z.string(),
      capabilities: z.array(z.enum(["chat", "embedding", "rerank"])),
      embedding_allowlist: z.array(z.string()).nullable(),
      embedding_alias: z.boolean(),
      rerank_allowlist: z.array(z.string()).nullable(),
    }),
  ),
  state: z.object({
    env: z.object({
      api_keys: z.record(z.string(), z.boolean()),
      embedding: z.string(),
      chat: z.string(),
      embedding_dims: z.string(),
    }),
    config: z.object({
      rerank_model: z.string().nullable(),
      rerank_enabled: z.boolean(),
      rerank_base_url: z.string().nullable(),
    }),
    complete: z.boolean(),
  }),
});

function checkView(c: ModelChoiceCheck, capability: "chat" | "embedding" | "rerank") {
  return {
    capability,
    ok: c.ok,
    route: c.route ?? null,
    provider_model: c.providerModel ?? null,
    dim: c.dim ?? null,
    warnings: c.warnings ?? null,
    error: c.error ?? null,
  };
}

const applyModelsRoute = createRoute({
  method: "post",
  path: "/v1/admin/models",
  tags: ["admin"],
  security: [{ adminToken: [] }],
  request: { body: { required: true, content: { "application/json": { schema: ModelsApplyBody } } } },
  responses: {
    200: { description: "模型装配完成（config set 已应用）", content: { "application/json": { schema: ModelsApplyView } } },
    422: { description: "预检失败（白名单/维度/档案不存在）" },
  },
});

const viewModelsRoute = createRoute({
  method: "get",
  path: "/v1/admin/models",
  tags: ["admin"],
  security: [{ adminToken: [] }],
  responses: {
    200: { description: "模型配置状态（档案清单 + env/DB 聚合）", content: { "application/json": { schema: ModelsView } } },
  },
});

export function registerModelAdminRoutes(app: OpenAPIHono<Env>, svc: Services, admin: Admin): void {
  app.openapi(applyModelsRoute, libHandler<typeof applyModelsRoute>(async (c: Context<Env>) => {
    const parsed = ModelsApplyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_PARAMS", message: "provider is required（dashscope | openrouter）" } }, 422);
    }
    const body = parsed.data;
    const facts = PROVIDER_FACTS[body.provider];
    if (!facts) {
      return c.json(
        { error: { code: "INVALID_PARAMS", message: `unknown provider "${body.provider}"；可用：${Object.keys(PROVIDER_FACTS).join(" | ")}` } },
        422,
      );
    }

    const plan = planModelAssembly(facts, {
      chatModel: body.chat_model,
      embeddingModel: body.embedding_model,
      embeddingDims: body.embedding_dims,
      rerankModel: body.rerank_model,
    });

    const failed = plan.checks.find((x) => !x.ok);
    if (failed) {
      return c.json(
        {
          error: { code: "INVALID_PARAMS", message: `${failed.capability}: ${failed.error ?? "model rejected"}` },
          checks: plan.checks.map((x) => checkView(x, x.capability)),
        },
        422,
      );
    }

    // embedding 维度缺口（档案未知且未提供）→ 引导而非静默
    const emb = plan.checks.find((x) => x.capability === "embedding");
    if (emb && emb.dim === null && !body.embedding_dims) {
      return c.json(
        {
          error: {
            code: "INVALID_PARAMS",
            message: `模型 "${body.embedding_model}" 维度未知——请提供 embedding_dims（或先实测端点输出维度）`,
          },
        },
        422,
      );
    }

    const applied: Array<{ key: string; value: string }> = [];
    if (body.apply) {
      for (const a of plan.actions) {
        await runGbrain(svc.cfg, { args: ["config", "set", a.key, a.value], timeoutMs: 30_000 });
        applied.push(a);
      }
    }

    return c.json({
      provider: facts.id,
      applied,
      env_required: plan.envRequired,
      checks: plan.checks.map((x) => checkView(x, x.capability)),
      hint: "env_required 中的变量需设到服务环境变量后重启生效（API key 属此类）；config set 类已落引擎 DB（重启不丢）。",
    } satisfies z.infer<typeof ModelsApplyView>);
  }));

  app.openapi(viewModelsRoute, libHandler<typeof viewModelsRoute>(async (c: Context<Env>) => {
    let dbConfig: { rerankModel?: string; rerankEnabled?: string; rerankBaseUrl?: string } = {};
    try {
      const [model, enabled, baseUrl] = await Promise.all([
        runGbrain(svc.cfg, { args: ["config", "get", "search.reranker.model"], timeoutMs: 30_000 }).then((r) => r.stdout.trim()).catch(() => ""),
        runGbrain(svc.cfg, { args: ["config", "get", "search.reranker.enabled"], timeoutMs: 30_000 }).then((r) => r.stdout.trim()).catch(() => ""),
        runGbrain(svc.cfg, { args: ["config", "get", "provider_base_urls.dashscope-rerank"], timeoutMs: 30_000 }).then((r) => r.stdout.trim()).catch(() => ""),
      ]);
      dbConfig = { rerankModel: model, rerankEnabled: enabled, rerankBaseUrl: baseUrl };
    } catch {
      // config get 不可用时返回 env 面状态（serve 场景）
    }

    return c.json({
      providers: Object.values(PROVIDER_FACTS).map((f) => ({
        id: f.id,
        label: f.label,
        api_key_env: f.apiKeyEnv,
        capabilities: (["chat", "embedding", "rerank"] as const).filter((cap) => {
          if (cap === "chat") return f.chatOpen;
          if (cap === "embedding") return Boolean(f.embedding);
          return Boolean(f.rerank);
        }),
        embedding_allowlist: f.embedding?.directAllowlist ?? null,
        embedding_alias: Boolean(f.embedding?.aliasBaseUrl),
        rerank_allowlist: f.rerank?.allowlist ?? null,
      })),
      state: (() => {
        const st = currentModelState(svc.cfg, dbConfig);
        return {
          env: { api_keys: st.env.apiKeys, embedding: st.env.embedding, chat: st.env.chat, embedding_dims: st.env.embeddingDims },
          config: { rerank_model: st.config.rerankModel, rerank_enabled: st.config.rerankEnabled, rerank_base_url: st.config.rerankBaseUrl },
          complete: st.complete,
        };
      })(),
    } satisfies z.infer<typeof ModelsView>);
  }));
}

/** 类型透出（供 openapi-drift 等消费） */
export const ModelAdminSchemas = { ModelsApplyBody, ModelsApplyView, ModelsView };
export { checkModelChoice };
