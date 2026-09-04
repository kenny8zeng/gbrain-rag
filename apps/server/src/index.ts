import { loadConfig } from "@core/config";
import { connect, migrate } from "@core/db";
import { Upstream } from "@core/gbrain-upstream";
import { McpGateway } from "@core/mcp-gateway";
import { loadAdminProxy } from "@core/admin-proxy";
import { lookupKeyByHash } from "@core/credentials";
import { processIngestJob } from "@core/ingest/pipeline";
import { retrieveWithFallback } from "@core/retrieval";
import { InternalRetrieval } from "@core/retrieval-serve";
import { modelConfigState, validateModelConfig } from "@core/model-config";
import { deriveSlotEnv, readEndpointModelEnv } from "@core/model-router";
import { runGbrain } from "@core/gbrain-cli";
import { DreamRunner } from "@core/dream";
import { createApp, type Services } from "./app";
import { startSupervisor } from "./supervisor";
import { startWorker } from "./worker";

const cfg = loadConfig();

const db = connect(cfg.DATABASE_URL);

async function main(): Promise<void> {
  const applied = await migrate(db, cfg.MIGRATIONS_DIR);
  console.log(JSON.stringify({ evt: "migrate", applied }));

  // 模型配置预检与状态（A/B/C：只警告不自动改；维度属引擎 schema 级）
  for (const w of validateModelConfig(cfg)) {
    console.log(JSON.stringify({ evt: "model_config_warning", kind: w.kind, message: w.message }));
  }
  const modelState = modelConfigState(cfg);
  const dream = new DreamRunner(cfg);
  if (dream.status().enabled) {
    // 梦境周期定时唤醒（tick 粒度 60s；到点判定在 runner 内按 nextDue 精确执行）
    setInterval(() => void dream.maybeScheduled(), 60_000).unref?.();
    const st = dream.status();
    console.log(JSON.stringify({ evt: "dream_scheduler", enabled: true, tier: st.tier, interval_hours: st.intervalHours, next_due: st.nextDue }));
  }
  console.log(JSON.stringify({ evt: "model_config", embedding: modelState.embedding, rerank: modelState.rerank, chat: modelState.chat }));

  // 统一配置面启动自愈：用户声明了 rerank 能力（RERANK_PROVIDER + RERANK_MODEL）时，
  // 自动补齐引擎 schema 级前置（enabled/model/国内端点）——幂等，重复 set 同值无害。
  // 此前这些前置漏设会零报错静默失效（doctor reranker_config (none)），此处根治。
  // 端点三要素自愈：rerank 走 /reranks 槽（dashscope-rerank recipe）时自动补齐引擎
  // schema 级前置（model/enabled/base_url）——幂等。标记由 entrypoint CLI 派生注入。
  if (process.env.GBRAIN_RERANKER_CONFIG_REQUIRED === "1") {
    try {
      const envAll = process.env as Record<string, string>;
      const u = readEndpointModelEnv(envAll);
      const plan = deriveSlotEnv(envAll);
      if (plan.rerankConfigRequired && plan.rerankModel && plan.rerankBaseUrl) {
        await runGbrain(cfg, { args: ["config", "set", "search.reranker.model", plan.rerankModel], timeoutMs: 30_000 });
        await runGbrain(cfg, { args: ["config", "set", "search.reranker.enabled", "true"], timeoutMs: 30_000 });
        await runGbrain(cfg, { args: ["config", "set", "provider_base_urls.dashscope-rerank", plan.rerankBaseUrl], timeoutMs: 30_000 });
        console.log(JSON.stringify({ evt: "model_self_heal", rerank: plan.rerankModel, base_url: plan.rerankBaseUrl }));
      }
    } catch (e) {
      console.log(JSON.stringify({ evt: "model_self_heal", error: (e as Error).message.slice(0, 200) }));
    }
  }

  const supervisor = startSupervisor(cfg);
  // 等 serve 就绪（不阻塞启动，/health 会如实降级）
  await new Promise((r) => setTimeout(r, 500));

  const upstream = new Upstream(`http://127.0.0.1:${cfg.GBRAIN_SERVE_PORT}`);

  // B：启动诊断——models doctor 探活（非阻塞，失败仅日志；端点类别/凭证/模型判定交给引擎工具）
  void (async () => {
    await new Promise((r) => setTimeout(r, 3_000)); // 让 supervisor 先就绪
    try {
      const proc = Bun.spawn([cfg.GBRAIN_BIN, "models", "doctor"], {
        env: { ...process.env } as Record<string, string>,
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
        signal: AbortSignal.timeout(20_000),
      });
      const out = await new Response(proc.stdout as ReadableStream).text();
      const summary = out.trim().split("\n").filter((l) => /[✔✗]|reachable|fail/i.test(l)).slice(-3).join(" | ");
      console.log(JSON.stringify({ evt: "models_doctor", summary: summary.slice(0, 400) }));
    } catch (e) {
      console.log(JSON.stringify({ evt: "models_doctor", error: (e as Error).message.slice(0, 200) }));
    }
  })();
  const gateway = new McpGateway({
    baseUrl: `http://127.0.0.1:${cfg.GBRAIN_SERVE_PORT}`,
    upstream,
    lookup: (hash) => lookupKeyByHash(db, hash),
    audit: (o) => console.log(JSON.stringify(o)),
  });
  const adminProxy = loadAdminProxy(cfg.ADMIN_SPEC_DIR);
  const internalRetrieval = new InternalRetrieval(cfg, upstream);

  const submitJob: Services["submitJob"] = async ({ kbId, type, sourceRef, title }) => {
    const rows = await db`
      INSERT INTO rag_jobs (kb_id, type, source_ref, title)
      VALUES (${kbId}, ${type}, ${sourceRef}, ${title ?? null})
      RETURNING id, status
    `;
    return rows[0] as unknown as { id: string; status: string };
  };

  const services: Services = {
    cfg,
    db,
    upstream,
    gateway,
    adminProxy,
    lookupKey: (hash) => lookupKeyByHash(db, hash),
    serveReady: () => supervisor.ready(),
    modelState,
    dream,
    doclingOk: doclingProbe(cfg.DOCLING_URL),
    submitJob,
    retrieve: (kbId, input) =>
      retrieveWithFallback(cfg, (k, i) => internalRetrieval.retrieve(k, i), kbId, input),
    onKbCreated: (kbId) => internalRetrieval.onKbCreated(kbId),
    onKbPurged: () => internalRetrieval.onKbPurged(),
  };

  const app = createApp(services);

  const worker = startWorker(cfg, db, (job) => processIngestJob(cfg, job));

  const server = Bun.serve({ port: cfg.PORT, fetch: app.fetch });
  console.log(JSON.stringify({ evt: "listening", port: cfg.PORT }));

  const shutdown = async () => {
    console.log(JSON.stringify({ evt: "shutdown" }));
    server.stop(true);
    await worker.stop();
    await supervisor.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

/** docling 探活，5s 缓存 */
function doclingProbe(baseUrl: string): () => Promise<boolean> {
  let last = { at: 0, ok: false };
  return async () => {
    if (Date.now() - last.at < 5_000) return last.ok;
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3_000) });
      last = { at: Date.now(), ok: res.ok };
    } catch {
      last = { at: Date.now(), ok: false };
    }
    return last.ok;
  };
}

await main();
