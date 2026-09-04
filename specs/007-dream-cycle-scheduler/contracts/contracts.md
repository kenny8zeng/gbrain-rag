# Contracts: 007 梦境周期调度

## 1. 环境变量

```env
# 梦境周期（默认全关 = 现状零变化）
DREAM_ENABLED=false            # true=启用定时梦境
DREAM_INTERVAL_HOURS=24        # 触发间隔（小时）
DREAM_TIER=light               # light=仅关系/时间线提取(无LLM合成) | full=全部维护阶段(含LLM反思合成)
```

## 2. 管理面 API

### `POST /v1/admin/dream` —— 手工触发一次梦境周期

- Auth：`Authorization: Bearer $ADMIN_TOKEN`
- Body：`{ "tier": "light" | "full" }` 可选（缺省用 env 档位）
- 响应：
  - `202`：`{ "status": "started", "tier": "...", "started_at": "..." }`（异步执行）
  - `409`：`{ "error": { "code": "DREAM_RUNNING", "message": "dream cycle already running (started at ...)" } }`（运行中拒绝）
- 非管理面：401/403（同既有管理面语义）

### `GET /v1/admin/dream` —— 梦境状态

- Auth：管理面
- 响应 `200`：
```json
{
  "enabled": true,
  "tier": "light",
  "interval_hours": 24,
  "running": false,
  "started_at": null,
  "next_due": "2026-09-05T02:00:00Z",
  "last_run": { "at": "2026-09-04T02:00:00Z", "ok": true, "tier": "light", "summary": "extract: links=12 timeline=0" }
}
```

## 3. 行为契约

| 场景 | 结果 |
|---|---|
| 未配置（默认） | 无定时、手工 API 触发被拒？——**决策**：手工触发在 `DREAM_ENABLED=false` 时仍可用（管理员显式触发一次，不受开关限制）但档位用请求值/light；状态显示 enabled=false 说明定时关 |
| 定时到点 + running | 跳过本轮，`nextDue += interval`（日志 `dream_rejected skip`） |
| 手工 + running | 409 `DREAM_RUNNING` |
| 运行超 4h | 强杀进程并解锁（日志 dream_error timeout），防永久锁 |
| 服务重启 | 锁清空（孤儿自愈）；nextDue 重置 = 启动 + interval |
| 执行失败 | `last_run.ok=false` + `last_error`；不影响服务其他功能 |

## 4. 事件日志（结构化）

```json
{"evt":"dream_started","tier":"light","trigger":"scheduled|manual"}
{"evt":"dream_done","tier":"light","ms":12345,"ok":true,"summary":"..."}
{"evt":"dream_error","tier":"full","error":"...","timeout":false}
{"evt":"dream_rejected","reason":"running","trigger":"scheduled|manual"}
```
