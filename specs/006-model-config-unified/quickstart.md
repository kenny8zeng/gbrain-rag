# Quickstart: 006 端点三要素配置验证指南

## 前置

- 本地栈：`docker compose -f deploy/compose.yaml up -d --build`（deploy/.env 已切端点三要素）
- 测试凭证（本地验证用）：dashscope key + deepseek key（deploy/.env 内）

## 验证场景（按 spec 用户故事）

### S1 三要素配置 → 全能力就绪（P1）

```bash
# deploy/.env 应为三行×3 能力（见 contracts/contracts.md §1）
docker compose -f deploy/compose.yaml up -d --build
curl -s localhost:3000/health | jq .models
# 期望：{"embedding":true,"rerank":true,"chat":true}
docker compose exec gbrain-rag gbrain models doctor 2>/dev/null | grep -E "rerank|embedding_config|chat"
# 期望：dashscope-rerank:qwen3-rerank / llama-server:qwen3.7-text-embedding 等 ok
```

**通过标准**：三能力 ready + doctor 全 ok + 一次检索非降级（见 S4）。

### S2 配置时探测反馈（P2）

```bash
# 端点不可达 → 422 ENDPOINT_UNREACHABLE
curl -s -X POST localhost:3000/v1/admin/models -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"embedding":{"base_url":"http://127.0.0.1:9/v1","model":"x","api_key":"k"},"apply":false}' | jq .error
# 型号无效 → 422 MODEL_NOT_FOUND（真实端点探测）
# 凭证无效 → 422 KEY_REJECTED
# 能力不支持（对纯 chat 端点配 embedding）→ 422 CAPABILITY_UNSUPPORTED
```

**通过标准**：四类错误均配置时返回人话 + 错误码；无"配置成功运行才失败"。

### S3 维度自动探测（P2/FR-006）

```bash
# 不填 EMBEDDING_DIMENSIONS 起服务 → 启动日志出现 probe 维度 = 端点默认
docker compose logs gbrain-rag | grep -E "probe|dim"
# 期望：探测得 1024（dashscope qwen3.7 默认）并写入派生
```

### S4 端到端检索（全故事）

```bash
export ADMIN=$(grep ADMIN_TOKEN deploy/.env | cut -d= -f2)   # 或 local-dev-token-0123456789
KB=$(curl -s -X POST localhost:3000/v1/kb -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"name":"q006"}' | jq -r .id)
KEY=$(curl -s -X POST localhost:3000/v1/keys -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d "{\"label\":\"k006\",\"write_kb\":\"$KB\",\"read_kbs\":[]}" | jq -r .key)
curl -s -X POST localhost:3000/v1/kb/$KB/documents -H "Authorization: Bearer $ADMIN" -H "X-API-Key: $KEY" -H 'Content-Type: text/markdown' --data-binary '# 006 验证' 
sleep 20
curl -s -X POST localhost:3000/v1/kb/$KB/retrieval -H "Authorization: Bearer $ADMIN" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"query":"006","mode":"hybrid"}' | jq .degraded
# 期望：[]（空 = 无降级；embedding+rerank 全链路）
# 清理：吊销 key + 归档 KB
```

### S5 干净清除验证（用户约束）

```bash
# 旧变量不再被识别：设 CHAT_PROVIDER=xxx 起服务 → 启动告警"未知配置变量/已废除"
# 文档仅含端点三要素（grep 配置文档无 GBRAIN_/PROVIDER/白名单/llama-server 用户指引）
docker compose exec gbrain-rag bash -c 'tr "\0" "\n" < /proc/1/environ | grep -cE "PROVIDER"'
# 期望：0（无任何 PROVIDER 残留注入）
```

**通过标准**：旧配置变量零残留（env 注入、schema、文档、测试）。

## 回归

```bash
bun run test   # 全量（单元+契约+门控集成）；旧 model-profiles 测试删除后基线更新
```
