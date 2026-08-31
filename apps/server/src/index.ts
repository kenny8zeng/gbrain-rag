import { loadConfig } from "@core/config";
import { connect, migrate } from "@core/db";
import { Upstream } from "@core/gbrain-upstream";
import { McpGateway } from "@core/mcp-gateway";
import { loadAdminProxy } from "@core/admin-proxy";
import { lookupKeyByHash } from "@core/credentials";
import { processIngestJob } from "@core/ingest/pipeline";
import { createApp, type Services } from "./app";
import { startSupervisor } from "./supervisor";
import { startWorker } from "./worker";

const cfg = loadConfig();

const db = connect(cfg.DATABASE_URL);

async function main(): Promise<void> {
  const applied = await migrate(db, cfg.MIGRATIONS_DIR);
  console.log(JSON.stringify({ evt: "migrate", applied }));

  const supervisor = startSupervisor(cfg);
  // 等 serve 就绪（不阻塞启动，/health 会如实降级）
  await new Promise((r) => setTimeout(r, 500));

  const upstream = new Upstream(`http://127.0.0.1:${cfg.GBRAIN_SERVE_PORT}`);
  const gateway = new McpGateway({
    baseUrl: `http://127.0.0.1:${cfg.GBRAIN_SERVE_PORT}`,
    upstream,
    lookup: (hash) => lookupKeyByHash(db, hash),
    audit: (o) => console.log(JSON.stringify(o)),
  });
  const adminProxy = loadAdminProxy(cfg.ADMIN_SPEC_DIR);

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
    doclingOk: doclingProbe(cfg.DOCLING_URL),
    submitJob,
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
