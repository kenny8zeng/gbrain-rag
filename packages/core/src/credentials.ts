import type { Config } from "./config";
import type { DB } from "./db";
import { runGbrain } from "./gbrain-cli";
import { generateKey, sha256hex } from "./hash";
import { ensureKbActive, invalidateSourceCache } from "./kb";

export interface KeyRow {
  id: string;
  keyHash: string;
  keyPrefix: string;
  label: string;
  writeKb: string | null;
  readKbs: string[];
  surface: string;
  clientId: string | null;
  clientSecret: string | null;
  concurrency: number;
  createdAt: string;
  revokedAt: string | null;
}

export class LabelTakenError extends Error {
  constructor(readonly label: string) {
    super(`credential label "${label}" already exists`);
  }
}

export interface IssueInput {
  label: string;
  writeKb?: string | null;
  readKbs: string[];
  surface?: string;
  concurrency?: number;
}

function parseRegistered(output: string): { clientId: string; clientSecret: string } {
  const id = /Client ID:\s+(\S+)/.exec(output)?.[1];
  const secret = /Client Secret:\s+(\S+)/.exec(output)?.[1];
  if (!id || !secret) {
    throw new Error(`register-client output did not contain client id/secret:\n${output.slice(0, 400)}`);
  }
  return { clientId: id, clientSecret: secret };
}

/** 纯函数（可测）：装配 register-client argv */
export function buildRegisterArgs(opts: {
  clientName: string;
  writeKb: string | null;
  readKbs: string[];
}): string[] {
  const scopeSource = opts.writeKb ?? opts.readKbs[0];
  const args = [
    "auth",
    "register-client",
    opts.clientName,
    "--grant-types",
    "client_credentials",
    "--source",
    scopeSource,
    "--federated-read",
    opts.readKbs.join(","),
  ];
  if (!opts.writeKb) args.push("--scopes", "read");
  else args.push("--bound-slug-prefixes", `${opts.writeKb}/*`);
  return args;
}

/** 纯函数（可测）：装配 rescope-client argv（仅传入要变更的轴） */
export function buildRescopeArgs(clientId: string, patch: { writeKb?: string; readKbs?: string[] }): string[] {
  const args = ["auth", "rescope-client", clientId];
  if (patch.writeKb !== undefined) args.push("--source", patch.writeKb);
  if (patch.readKbs !== undefined) args.push("--federated-read", patch.readKbs.join(","));
  return args;
}

function parseJsonbArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  }
  return [];
}

function rowToKeyRow(r: Record<string, unknown>): KeyRow {
  return {
    id: r.id as string,
    keyHash: r.key_hash as string,
    keyPrefix: r.key_prefix as string,
    label: r.label as string,
    writeKb: (r.write_kb as string | null) ?? null,
    readKbs: parseJsonbArray(r.read_kbs),
    surface: r.surface as string,
    clientId: (r.client_id as string | null) ?? null,
    clientSecret: (r.client_secret as string | null) ?? null,
    concurrency: r.concurrency as number,
    createdAt: r.created_at as string,
    revokedAt: (r.revoked_at as string | null) ?? null,
  };
}

export async function issueKey(
  cfg: Config,
  db: DB,
  input: IssueInput,
): Promise<{ row: KeyRow; plaintext: string }> {
  const dup = await db`SELECT 1 FROM rag_keys WHERE label = ${input.label} LIMIT 1`;
  if (dup.length > 0) throw new LabelTakenError(input.label);

  for (const kb of input.readKbs) await ensureKbActive(cfg, kb);
  if (input.writeKb) await ensureKbActive(cfg, input.writeKb);

  const readKbs = input.readKbs.length > 0 ? input.readKbs : input.writeKb ? [input.writeKb] : [];
  const clientName = `rag-${randomHex(6)}`;
  const output = await runGbrain(cfg, {
    args: buildRegisterArgs({ clientName, writeKb: input.writeKb ?? null, readKbs }),
    timeoutMs: 60_000,
  }).then((r) => r.stdout);

  const { clientId, clientSecret } = parseRegistered(output);

  // register-client 不支持 --surface 时经 rescope 钉定（rescope 支持 --surface）
  if (input.surface && input.surface !== "starter") {
    await runGbrain(cfg, { args: ["auth", "rescope-client", clientId, "--surface", input.surface], timeoutMs: 60_000 });
  }

  const gen = generateKey();
  const rows = await db`
    INSERT INTO rag_keys (key_hash, key_prefix, label, write_kb, read_kbs, surface, client_id, client_secret, concurrency)
    VALUES (${gen.hash}, ${gen.prefix}, ${input.label}, ${input.writeKb ?? null},
            ${JSON.stringify(readKbs)}::jsonb, ${input.surface ?? "starter"}, ${clientId}, ${clientSecret},
            ${input.concurrency ?? cfg.MCP_DEFAULT_CONCURRENCY})
    RETURNING *
  `;
  invalidateSourceCache();
  return { row: rowToKeyRow(rows[0]!), plaintext: gen.key };
}

export async function rescopeKey(
  cfg: Config,
  db: DB,
  id: string,
  patch: { writeKb?: string; readKbs?: string[]; concurrency?: number },
): Promise<KeyRow | null> {
  const rows = await db`SELECT * FROM rag_keys WHERE id = ${id} AND revoked_at IS NULL LIMIT 1`;
  if (rows.length === 0) return null;
  const row = rowToKeyRow(rows[0]!);

  for (const kb of patch.readKbs ?? []) await ensureKbActive(cfg, kb);
  if (patch.writeKb) await ensureKbActive(cfg, patch.writeKb);

  const nextWrite = patch.writeKb ?? row.writeKb;
  const nextRead = patch.readKbs ?? row.readKbs;
  if (patch.writeKb !== undefined || patch.readKbs !== undefined) {
    await runGbrain(cfg, { args: buildRescopeArgs(row.clientId!, patch), timeoutMs: 60_000 });
    if (nextWrite && !(nextWrite === row.writeKb)) {
      await runGbrain(cfg, {
        args: ["auth", "rescope-client", row.clientId!, "--bound-slug-prefixes", `${nextWrite}/*`],
        timeoutMs: 60_000,
      });
    }
    await db`UPDATE rag_keys SET write_kb = ${nextWrite}, read_kbs = ${JSON.stringify(nextRead)}::jsonb WHERE id = ${id}`;
  }
  if (patch.concurrency !== undefined) {
    await db`UPDATE rag_keys SET concurrency = ${patch.concurrency} WHERE id = ${id}`;
  }

  invalidateSourceCache();
  const updated = await db`SELECT * FROM rag_keys WHERE id = ${id} LIMIT 1`;
  return rowToKeyRow(updated[0]!);
}

export async function revokeKey(cfg: Config, db: DB, id: string): Promise<boolean> {
  const rows = await db`SELECT * FROM rag_keys WHERE id = ${id} AND revoked_at IS NULL LIMIT 1`;
  if (rows.length === 0) return false;
  const row = rowToKeyRow(rows[0]!);
  if (row.clientId) {
    await runGbrain(cfg, { args: ["auth", "revoke-client", row.clientId], timeoutMs: 60_000 });
  }
  await db`UPDATE rag_keys SET revoked_at = now() WHERE id = ${id}`;
  return true;
}

export async function lookupKeyByHash(db: DB, hash: string): Promise<KeyRow | null> {
  const rows = await db`SELECT * FROM rag_keys WHERE key_hash = ${hash} LIMIT 1`;
  return rows.length > 0 ? rowToKeyRow(rows[0]!) : null;
}

export async function listKeys(db: DB): Promise<Array<Pick<KeyRow, "id" | "keyPrefix" | "label" | "writeKb" | "readKbs" | "surface" | "concurrency" | "createdAt" | "revokedAt">>> {
  const rows = await db`SELECT id, key_prefix, label, write_kb, read_kbs, surface, concurrency, created_at, revoked_at FROM rag_keys ORDER BY created_at DESC`;
  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    keyPrefix: r.key_prefix as string,
    label: r.label as string,
    writeKb: (r.write_kb as string | null) ?? null,
    readKbs: r.read_kbs as string[],
    surface: r.surface as string,
    concurrency: r.concurrency as number,
    createdAt: r.created_at as string,
    revokedAt: (r.revoked_at as string | null) ?? null,
  }));
}

export function verifyKey(row: KeyRow, apiKey: string): boolean {
  return row.keyHash === sha256hex(apiKey) && row.revokedAt === null;
}

function randomHex(n: number): string {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
