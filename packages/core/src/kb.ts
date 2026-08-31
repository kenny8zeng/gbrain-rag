import { mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config";
import { brainDir, docsDir } from "./config";
import { runGbrain, runGbrainJson } from "./gbrain-cli";
import type { DB } from "./db";

export interface KbSummary {
  id: string;
  name: string;
  status: "active" | "archived";
  pageCount?: number;
  federated?: boolean;
  lastSyncAt?: string | null;
}

export class KbNotFoundError extends Error {
  constructor(readonly kbId: string) {
    super(`knowledge base "${kbId}" not found`);
  }
}

export class KbArchivedError extends Error {
  constructor(readonly kbId: string) {
    super(`knowledge base "${kbId}" is archived`);
  }
}

export class KbInUseError extends Error {
  constructor(readonly kbId: string, readonly credentialIds: string[]) {
    super(`knowledge base "${kbId}" is referenced by ${credentialIds.length} credential(s)`);
  }
}

const KB_ID_RE = /^kb-[0-9a-f]{8}$/;

export function isKbId(id: string): boolean {
  return KB_ID_RE.test(id);
}

function newKbId(): string {
  return `kb-${randomId8()}`;
}

function randomId8(): string {
  return [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface SourceRow {
  id: string;
  name: string;
  page_count?: number;
  federated?: boolean;
  last_sync_at?: string | null;
}

interface SourcesListResponse {
  sources: SourceRow[];
}

interface SourcesListOpts {
  includeAll?: boolean;
  /** 测试注入口 */
  now?: () => number;
}

/** 30s 缓存的 sources 列表（热路径上的存在性/归档检查用） */
let cache: { at: number; data: SourceRow[] } | null = null;
const CACHE_MS = 30_000;

export function invalidateSourceCache(): void {
  cache = null;
}

async function listAllSources(cfg: Config): Promise<SourceRow[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const j = await runGbrainJson<SourcesListResponse>(cfg, { args: ["sources", "list"], timeoutMs: 30_000 });
  cache = { at: Date.now(), data: j.sources ?? [] };
  return cache.data;
}

async function listArchivedIds(cfg: Config): Promise<Set<string>> {
  const j = await runGbrainJson<{ sources?: { id: string }[] }>(cfg, {
    args: ["sources", "archived"],
    timeoutMs: 30_000,
  });
  return new Set((j.sources ?? []).map((s) => s.id));
}

export async function listKbs(cfg: Config): Promise<KbSummary[]> {
  const [all, archived] = await Promise.all([listAllSources(cfg), listArchivedIds(cfg)]);
  return all
    .filter((s) => isKbId(s.id))
    .map((s) => ({
      id: s.id,
      name: s.name,
      status: archived.has(s.id) ? ("archived" as const) : ("active" as const),
      pageCount: s.page_count,
      federated: s.federated,
      lastSyncAt: s.last_sync_at ?? null,
    }));
}

/** 热路径校验：存在且 active；不存在 → KbNotFoundError，归档 → KbArchivedError */
export async function ensureKbActive(cfg: Config, kbId: string): Promise<void> {
  if (!isKbId(kbId)) throw new KbNotFoundError(kbId);
  const all = await listAllSources(cfg);
  if (!all.some((s) => s.id === kbId)) throw new KbNotFoundError(kbId);
  const archived = await listArchivedIds(cfg);
  if (archived.has(kbId)) throw new KbArchivedError(kbId);
}

function git(args: string[], cwd: string): void {
  Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
}

export async function createKb(cfg: Config, db: DB, name: string): Promise<KbSummary> {
  let id = newKbId();
  while (existsSync(brainDir(cfg, id))) id = newKbId();

  const dir = brainDir(cfg, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".gitkeep"), "");
  git(["init", "-b", "main"], dir);
  git(["add", "-A"], dir);
  git(["-c", "user.name=gbrain-rag", "-c", "user.email=gbrain-rag@local", "commit", "-m", `init ${id}`, "--allow-empty"], dir);

  invalidateSourceCache();
  await runGbrain(cfg, { args: ["sources", "add", id, "--path", dir], timeoutMs: 60_000 });
  invalidateSourceCache();

  return { id, name, status: "active", pageCount: 0, lastSyncAt: null };
}

/** 引用该库的有效凭证 id 列表（用于归档前置检查） */
export async function referencingCredentials(db: DB, kbId: string): Promise<string[]> {
  const rows = await db`
    SELECT id FROM rag_keys
    WHERE revoked_at IS NULL
      AND (write_kb = ${kbId} OR read_kbs @> ${JSON.stringify([kbId])}::jsonb)
  `;
  return rows.map((r: { id: string }) => r.id);
}

export async function archiveKb(cfg: Config, db: DB, kbId: string, opts: { force: boolean }): Promise<void> {
  await ensureKbActive(cfg, kbId);
  const refs = await referencingCredentials(db, kbId);
  if (refs.length > 0 && !opts.force) throw new KbInUseError(kbId, refs);
  await runGbrain(cfg, { args: ["sources", "archive", kbId], timeoutMs: 60_000 });
  invalidateSourceCache();
}

export async function purgeKb(cfg: Config, kbId: string): Promise<void> {
  await runGbrain(cfg, {
    args: ["sources", "purge", kbId, "--confirm-destructive"],
    timeoutMs: 120_000,
  });
  rmSync(brainDir(cfg, kbId), { recursive: true, force: true });
  rmSync(docsDir(cfg, kbId), { recursive: true, force: true });
  invalidateSourceCache();
}
