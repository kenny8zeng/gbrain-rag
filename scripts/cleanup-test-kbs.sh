#!/usr/bin/env bash
# 全序清理：先吊销引用 client（FK RESTRICT）→ 内部 client 转出 → purge 全部 kb-*
set -euo pipefail

gbrain auth clients --json > /tmp/clients.json

# 1) 吊销全部测试 client（rag-<12hex>，保留 rag-internal-*）
bun -e '
import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync("/tmp/clients.json", "utf8"));
const testClients = (j.clients ?? []).filter((c) => /^rag-[0-9a-f]{12}$/.test(c.client_name));
console.log("test clients to revoke:", testClients.length);
for (const c of testClients) console.log(c.client_id);
'
for id in $(bun -e '
import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync("/tmp/clients.json", "utf8"));
for (const c of (j.clients ?? [])) if (/^rag-[0-9a-f]{12}$/.test(c.client_name)) console.log(c.client_id);
'); do
  gbrain auth revoke-client "$id" >/dev/null 2>&1 || echo "revoke failed: $id"
done
echo "test clients revoked"

# 2) 内部 client 转出到 default 来源（其 --source 引用 kb-* 会阻塞 purge）
INTERNAL_ID=$(bun -e '
import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync("/tmp/clients.json", "utf8"));
const c = (j.clients ?? []).find((c) => c.client_name.startsWith("rag-internal-"));
if (c) console.log(c.client_id);
')
if [ -n "$INTERNAL_ID" ]; then
  gbrain auth rescope-client "$INTERNAL_ID" --source default --federated-read >/dev/null 2>&1 || echo "internal rescope failed"
  echo "internal client moved to default"
fi

# 3) purge 全部 kb-*
count=$(gbrain sources list --json | grep -o '"id": "kb-[0-9a-f]*"' | wc -l)
echo "kb sources to purge: $count"
for id in $(gbrain sources list --json | grep -o '"id": "kb-[0-9a-f]*"' | sed 's/"id": "//;s/"//'); do
  echo y | gbrain sources purge "$id" --confirm-destructive >/dev/null 2>&1 || echo "purge failed: $id"
done
echo "remaining kb sources: $(gbrain sources list --json | grep -o '"id": "kb-[0-9a-f]*"' | wc -l)"
