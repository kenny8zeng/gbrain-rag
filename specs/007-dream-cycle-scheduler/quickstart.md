# Quickstart: 007 梦境周期调度验证指南

## 前置

- 本地栈：`docker compose -f deploy/compose.yaml up -d --build`（本地 dev 实例；知识库现图空）
- 测试 KB：任一有真实内容的库（如恢复的压测库 `kb-c80df620`——先 `gbrain sources restore kb-c80df620`）

## 验证场景

### S1 默认关闭零行为（FR-001）

```bash
# deploy/.env 不含 DREAM_* → 起服务
docker compose up -d
curl -s localhost:3000/v1/admin/dream -H "Authorization: Bearer $ADMIN" | jq .
# 期望：{"enabled":false, ...}
```

**通过**：enabled=false；无 dream_* 日志事件。

### S2 手工触发 light 档建图（US2/SC-002）

```bash
curl -s -X POST localhost:3000/v1/admin/dream -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"tier":"light"}' | jq .
# 期望：202 {"status":"started",...}
# 轮询状态至 running=false
curl -s localhost:3000/v1/admin/dream -H "Authorization: Bearer $ADMIN" | jq '.last_run'
# 期望：ok=true, summary 含 extract links 计数
# 图边实证（容器内）
docker compose exec gbrain-rag gbrain link-sources   # 期望：出现 mentions 边（非空）
```

**通过**：202 接受 → 完成 → `link-sources` 从空变非空（SC-002）。

### S3 运行中拒绝（US3/SC-003）

```bash
# 触发一次后立即再触发（间隔 < 执行时长——可用 full 档或大库拉长执行）
curl -s -X POST localhost:3000/v1/admin/dream -H "Authorization: Bearer $ADMIN" -d '{"tier":"full"}' | jq -c .status
curl -s -X POST localhost:3000/v1/admin/dream -H "Authorization: Bearer $ADMIN" -d '{"tier":"light"}' | jq .
# 第二次期望：409 {"error":{"code":"DREAM_RUNNING",...}}
```

**通过**：第二次 409；日志无叠跑（同一时刻仅一个 dream 进程）。

### S4 定时触发（US1/SC-001）

```bash
# .env 设 DREAM_ENABLED=true DREAM_INTERVAL_HOURS=1 DREAM_TIER=light → 重启
# 观察日志（~1h 后或临时调小间隔验证逻辑：interval=1 需等 1h——用单测覆盖时序，此处验证配置生效即可）
curl -s localhost:3000/v1/admin/dream -H "Authorization: Bearer $ADMIN" | jq '{enabled, tier, next_due}'
```

**通过**：enabled=true、next_due 合理；单测覆盖"到点触发/运行中跳过"时序。

### S5 权限（FR-004）

```bash
curl -s -X POST localhost:3000/v1/admin/dream -H "X-API-Key: $TENANT_KEY" | jq .error.code
# 期望：401/403（非管理面拒绝）
```

## 回归

```bash
bun run test   # 全量（新增 dream 单测 + 契约门控）
```
