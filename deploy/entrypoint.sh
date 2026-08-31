#!/usr/bin/env bash
# 幂等初始化 gbrain brain（Postgres 引擎），随后启动 gbrain-rag server
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${ADMIN_TOKEN:?ADMIN_TOKEN is required}"

mkdir -p "${DATA_DIR:-/data/rag}"

echo "[entrypoint] gbrain init --url (idempotent)"
if ! gbrain init --url "$DATABASE_URL"; then
  # 已初始化的 brain 重复 init 可能非零退出：仅告警，由后续 serve/status 决定健康
  echo "[entrypoint] gbrain init returned non-zero (may already be initialized); continuing"
fi

echo "[entrypoint] starting gbrain-rag server"
exec bun apps/server/src/index.ts
