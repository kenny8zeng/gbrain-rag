#!/usr/bin/env bash
# 幂等初始化 gbrain brain（Postgres 引擎），随后启动 gbrain-rag server
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${ADMIN_TOKEN:?ADMIN_TOKEN is required}"

mkdir -p "${DATA_DIR:-/data/rag}"

# ---- 端点三要素派生（唯一模型配置入口：CHAT/EMBEDDING/RERANK_BASE_URL+MODEL+API_KEY）----
# 服务把端点映射到引擎槽位；rerank 路径形态经真实探测。无三要素配置时无输出。
if [ -f /app/packages/core/src/model-router-cli.ts ]; then
  eval "$(bun /app/packages/core/src/model-router-cli.ts)"
fi

echo "[entrypoint] gbrain init --url (idempotent)"
if ! gbrain init --url "$DATABASE_URL"; then
  # 已初始化的 brain 重复 init 可能非零退出：仅告警，由后续 serve/status 决定健康
  echo "[entrypoint] gbrain init returned non-zero (may already be initialized); continuing"
fi

echo "[entrypoint] starting gbrain-rag server"
exec bun apps/server/src/index.ts
