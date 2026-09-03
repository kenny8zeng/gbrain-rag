#!/usr/bin/env bash
# 幂等初始化 gbrain brain（Postgres 引擎），随后启动 gbrain-rag server
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${ADMIN_TOKEN:?ADMIN_TOKEN is required}"

mkdir -p "${DATA_DIR:-/data/rag}"

# ---- 供应商中立模型配置映射（原生 gbrain 变量优先，不覆盖）----
# 中立三件套（EMBEDDING_*/RERANK_*）→ 引擎约定的 openai-compatible 端点别名。
# 端点可指向任意 OpenAI 兼容网关（litellm/one-api/llama-server 等）。
map_env() {
  local g="$1" n="$2"
  if [ -z "${!g:-}" ] && [ -n "${!n:-}" ]; then export "$g=${!n}"; fi
}
map_env LLAMA_SERVER_BASE_URL        EMBEDDING_BASE_URL
map_env LLAMA_SERVER_API_KEY         EMBEDDING_API_KEY
map_env GBRAIN_EMBEDDING_DIMENSIONS  EMBEDDING_DIMENSIONS
map_env LLAMA_SERVER_RERANKER_BASE_URL RERANK_BASE_URL
map_env LLAMA_SERVER_RERANKER_API_KEY  RERANK_API_KEY
# 模型名：无 provider 前缀时自动补 llama-server:（该端点即 OpenAI 兼容网关）
map_model() {
  local g="$1" n="$2"
  if [ -z "${!g:-}" ] && [ -n "${!n:-}" ]; then
    case "${!n}" in
      *:*) export "$g=${!n}" ;;
      *)   export "$g=llama-server:${!n}" ;;
    esac
  fi
}
map_model GBRAIN_EMBEDDING_MODEL EMBEDDING_MODEL
map_model GBRAIN_RERANKER_MODEL  RERANK_MODEL



echo "[entrypoint] gbrain init --url (idempotent)"
if ! gbrain init --url "$DATABASE_URL"; then
  # 已初始化的 brain 重复 init 可能非零退出：仅告警，由后续 serve/status 决定健康
  echo "[entrypoint] gbrain init returned non-zero (may already be initialized); continuing"
fi

echo "[entrypoint] starting gbrain-rag server"
exec bun apps/server/src/index.ts
