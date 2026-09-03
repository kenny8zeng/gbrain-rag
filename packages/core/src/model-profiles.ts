import type { Config } from "./config";

/**
 * 供应商档案（model-profiles）：把引擎知识代码化——recipe 名、key env 变量、
 * 能力认证清单（allowlist）、模型维度、端点规则。用户配置面收敛为
 * provider 选择；档案负责预检与装配指令生成，避免用户研究引擎源码。
 *
 * 实证来源：gbrain v0.47.6.0 引擎 recipe 源码（dashscope / dashscope-rerank /
 * openrouter / llama-server 别名通道）+ 生产实测（dashscope 端点 200 验证）。
 */

export interface RerankFacts {
  /** 引擎 rerank recipe id（≠ provider id，如 dashscope-rerank）；缺省同 provider id */
  recipeId?: string;
  /** 直连模型白名单（engine recipe touchpoints.reranker.models） */
  allowlist: string[];
  /** 默认模型（provider:model） */
  defaultModel: string;
  /**
   * 国内端点覆盖：`gbrain config set provider_base_urls.<recipe> <url>` 的键值。
   * undefined = recipe 默认端点即正确（如 openrouter 默认 intl 端点）。
   */
  baseUrlConfigKey?: string;
  baseUrlDefault?: string;
}

export interface EmbeddingFacts {
  /** 可直连（provider 前缀 + 白名单内模型）的模型清单 */
  directAllowlist: string[];
  /** 直连模型维度表（model id → dims） */
  dims: Record<string, number>;
  /** 白名单外模型可经别名通道（llama-server: + LLAMA_SERVER_BASE_URL）透传 */
  aliasBaseUrl: string;
  /** 别名通道推荐模型与维度（供应商 embedding 端点默认输出） */
  aliasDefaultModel?: string;
  aliasDefaultDim?: number;
}

export interface ProviderFacts {
  id: string;
  label: string;
  /** 供应商一把 key 的 env 变量名 */
  apiKeyEnv: string;
  /** chat 是否宽放行（true = 任意模型可经 provider: 前缀直连） */
  chatOpen: boolean;
  embedding?: EmbeddingFacts;
  rerank?: RerankFacts;
}

/** 引擎实测档案（v0.47.6.0 recipe 源码 + 端点实测） */
export const PROVIDER_FACTS: Record<string, ProviderFacts> = {
  dashscope: {
    id: "dashscope",
    label: "阿里云百炼 DashScope（国内）",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    chatOpen: false,
    embedding: {
      // dashscope recipe embedding allowlist 仅 text-embedding-v3/v2（gateway 强制）
      directAllowlist: ["text-embedding-v3", "text-embedding-v2"],
      dims: { "text-embedding-v3": 1024, "text-embedding-v2": 1024 },
      // 白名单外模型（qwen3.7-text-embedding 等）走别名通道（OpenAI 兼容无白名单）
      aliasBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      aliasDefaultModel: "qwen3.7-text-embedding",
      aliasDefaultDim: 1024,
    },
    rerank: {
      recipeId: "dashscope-rerank",
      // dashscope-rerank recipe allowlist（/reranks 复数路径，实测 200）
      allowlist: ["qwen3-rerank"],
      defaultModel: "dashscope-rerank:qwen3-rerank",
      // 国内端点覆盖（recipe 默认 intl；国内 key 仅认国内端点，实测 401 vs 200）
      baseUrlConfigKey: "provider_base_urls.dashscope-rerank",
      baseUrlDefault: "https://dashscope.aliyuncs.com/compatible-api/v1",
    },
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter（聚合网关）",
    apiKeyEnv: "OPENROUTER_API_KEY",
    chatOpen: true,
    embedding: {
      // openrouter recipe embedding allowlist（仅 text-embedding-3-small 实证在册）
      directAllowlist: ["openai/text-embedding-3-small"],
      dims: { "openai/text-embedding-3-small": 1536 },
      aliasBaseUrl: "https://openrouter.ai/api/v1",
    },
    rerank: {
      allowlist: ["cohere/rerank-v3.5", "cohere/rerank-4-fast", "cohere/rerank-4-pro", "nvidia/llama-nemotron-rerank-vl-1b-v2:free"],
      defaultModel: "openrouter:cohere/rerank-v3.5",
      // openrouter 默认端点正确，无需 base_url 覆盖
    },
  },
};

export type Capability = "chat" | "embedding" | "rerank";

export interface ModelChoiceCheck {
  ok: boolean;
  /** 推荐装配方式：direct（provider:model 直连）| alias（别名通道）| none */
  route?: "direct" | "alias" | "none";
  /** direct 时的完整 provider:model 串 */
  providerModel?: string;
  /** alias 通道所需 env（EMBEDDING_BASE_URL=aliasBaseUrl） */
  envRequired?: string[];
  /** 维度（档案已知；未知则提示用户提供） */
  dim?: number | null;
  warnings?: string[];
  error?: string;
}

/** 白名单/维度预检（纯函数，可单测）——引擎 gateway 白名单强制的本地镜像 */
export function checkModelChoice(facts: ProviderFacts, cap: Capability, model: string): ModelChoiceCheck {
  const f = cap === "embedding" ? facts.embedding : cap === "rerank" ? facts.rerank : null;
  if (cap === "chat") {
    return facts.chatOpen
      ? { ok: true, route: "direct", providerModel: `${facts.id}:${model}` }
      : { ok: false, error: `${facts.label} 无 chat 直连通道（chatOpen=false）；请用 deepseek:/openrouter: 等 chat 供应商` };
  }
  if (!f) return { ok: false, error: `${facts.label} 不支持 ${cap}` };

  if (cap === "rerank") {
    const rk = f as RerankFacts;
    if (rk.allowlist.includes(model)) {
      return {
        ok: true,
        route: "direct",
        providerModel: `${rk.recipeId ?? facts.id}:${model}`,
        envRequired: [facts.apiKeyEnv],
        warnings: rk.baseUrlConfigKey ? [`需 config set ${rk.baseUrlConfigKey} ${rk.baseUrlDefault}（国内端点）`] : undefined,
      };
    }
    return {
      ok: false,
      error: `模型 "${model}" 不在 ${facts.label} rerank 认证清单（${rk.allowlist.join(" | ")}）；换模型或换供应商`,
    };
  }

  const em = f as EmbeddingFacts;
  if (em.directAllowlist.includes(model)) {
    return {
      ok: true,
      route: "direct",
      providerModel: `${facts.id}:${model}`,
      dim: em.dims[model] ?? null,
      envRequired: [facts.apiKeyEnv],
    };
  }
  // 白名单外 → 别名通道（llama-server: 无白名单透传）
  return {
    ok: true,
    route: "alias",
    providerModel: `llama-server:${model}`,
    dim: em.aliasDefaultDim ?? null,
    envRequired: [facts.apiKeyEnv, `EMBEDDING_BASE_URL=${em.aliasBaseUrl}`],
    warnings: [`"${model}" 不在 ${facts.id} embedding 认证清单，已路由到别名通道（llama-server: + OpenAI 兼容端点）`],
  };
}

/** 装配指令（config set 类——env 类由调用方汇总 envRequired） */
export interface ConfigSetAction {
  key: string;
  value: string;
}

/**
 * 生成配置装配指令：rerank 启用开关 + 模型 + 国内端点覆盖。
 * env 类（key/端点/模型变量）不在此列——返回 envRequired 由用户/上层设置。
 */
export function planModelAssembly(facts: ProviderFacts, opts: {
  chatModel?: string;
  embeddingModel?: string;
  embeddingDims?: number;
  rerankModel?: string;
}): { actions: ConfigSetAction[]; envRequired: string[]; checks: Array<ModelChoiceCheck & { capability: Capability }> } {
  const actions: ConfigSetAction[] = [];
  const envRequired = new Set<string>([facts.apiKeyEnv]);
  const checks: Array<ModelChoiceCheck & { capability: Capability }> = [];

  if (opts.chatModel) {
    const c = checkModelChoice(facts, "chat", opts.chatModel);
    if (c.ok) envRequired.add(`GBRAIN_CHAT_MODEL=${c.providerModel}`);
    checks.push({ ...c, capability: "chat" });
  }

  if (opts.embeddingModel) {
    const c = checkModelChoice(facts, "embedding", opts.embeddingModel);
    if (c.ok) {
      envRequired.add(`GBRAIN_EMBEDDING_MODEL=${c.providerModel}`);
      envRequired.add(`GBRAIN_EMBEDDING_DIMENSIONS=${String(opts.embeddingDims ?? c.dim ?? "")}`.replace(/= $/, "=待探测"));
      for (const e of c.envRequired ?? []) envRequired.add(e);
    }
    checks.push({ ...c, capability: "embedding" });
  }

  if (opts.rerankModel ?? facts.rerank) {
    const rm = opts.rerankModel ?? facts.rerank?.allowlist[0];
    const c = rm ? checkModelChoice(facts, "rerank", rm) : null;
    if (c?.ok) {
      actions.push({ key: "search.reranker.model", value: c.providerModel! });
      actions.push({ key: "search.reranker.enabled", value: "true" });
      if (facts.rerank?.baseUrlConfigKey && facts.rerank.baseUrlDefault) {
        actions.push({ key: facts.rerank.baseUrlConfigKey, value: facts.rerank.baseUrlDefault });
      }
    } else if (c) {
      checks.push({ ...c, capability: "rerank" });
    }
  }

  return { actions, envRequired: [...envRequired], checks };
}

/** 当前配置状态聚合（env 面 + DB config 面）——供 GET /v1/admin/models */
export function currentModelState(cfg: Config, dbConfig: { rerankModel?: string; rerankEnabled?: string; rerankBaseUrl?: string }): {
  env: { apiKeys: Record<string, boolean>; embedding: string; chat: string; embeddingDims: string };
  config: { rerankModel: string | null; rerankEnabled: boolean; rerankBaseUrl: string | null };
  complete: boolean;
} {
  const apiKeys: Record<string, boolean> = {};
  for (const f of Object.values(PROVIDER_FACTS)) apiKeys[f.apiKeyEnv] = Boolean(process.env[f.apiKeyEnv] ?? (cfg as unknown as Record<string, string>)[f.apiKeyEnv]);
  const envState = {
    apiKeys,
    embedding: cfg.GBRAIN_EMBEDDING_MODEL || (cfg.EMBEDDING_MODEL ? `llama-server:${cfg.EMBEDDING_MODEL}` : ""),
    chat: cfg.GBRAIN_CHAT_MODEL,
    embeddingDims: cfg.GBRAIN_EMBEDDING_DIMENSIONS || cfg.EMBEDDING_DIMENSIONS,
  };
  const config = {
    rerankModel: dbConfig.rerankModel ?? null,
    rerankEnabled: dbConfig.rerankEnabled === "true",
    rerankBaseUrl: dbConfig.rerankBaseUrl ?? null,
  };
  return {
    env: envState,
    config,
    complete: Boolean(envState.embedding && config.rerankEnabled && config.rerankModel && envState.chat),
  };
}
