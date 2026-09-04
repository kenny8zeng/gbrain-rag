# Data Model: 梦境周期调度（007）

## 实体

### 梦境配置（环境变量，部署期设定）

| env | 类型 | 默认 | 语义 |
|---|---|---|---|
| `DREAM_ENABLED` | bool | `false` | 总开关（默认关 = 零行为变化） |
| `DREAM_INTERVAL_HOURS` | int >0 | `24` | 定时触发间隔（小时） |
| `DREAM_TIER` | enum `light`\|`full` | `light` | 成本档：light=仅关系/时间线提取（无 LLM 合成）；full=全部维护阶段（含 LLM 反思合成） |

校验：`DREAM_ENABLED=false` 时其余忽略；`DREAM_INTERVAL_HOURS` 非正 → 配置错误（启动警告并视为关）。

### 梦境运行状态（进程内存，单实例）

| 字段 | 类型 | 说明 |
|---|---|---|
| `running` | bool | 互斥锁：是否执行中 |
| `startedAt` | ISO | 本次开始（超时判定用） |
| `nextDue` | ISO | 下次定时点（每次运行/启动时推进） |
| `lastRun` | `{ at, ok, tier, summary } \| null` | 上次结果（CycleReport 摘要：阶段计数/错误） |
| `lastError` | string \| null | 上次失败原因（供状态查询） |

状态迁移：`idle --trigger--> running --done/fail--> idle(+lastRun)`；`running --timeout(>DREAM_TIMEOUT_MS)--> idle(强杀)`；进程重启 → idle（内存清空，孤儿自愈）。

### 运行锁规则

- 触发条件：`idle` 且（定时到点 或 手工请求）
- `running` 中触发 → 拒绝：定时跳过本轮（顺延 interval）；手工返回 409（错误码 `DREAM_RUNNING`）
- 超时上限：`DREAM_TIMEOUT_MS` 固定 4h（防挂死永久锁）
- 执行：异步后台 runGbrain（不阻塞 HTTP/worker/检索）

## 校验映射（FR）

- FR-001/002：env 开关/间隔/档位（config schema）
- FR-003：supervisor 定时检查（`nextDue` 驱动，非外部 cron）
- FR-004：`POST /v1/admin/dream`（admin Bearer，异步 202 + 状态）；非管理面 401/403
- FR-005：`GET /v1/admin/dream` → `{enabled, tier, interval_hours, running, started_at, next_due, last_run}`
- FR-006/007：锁 + 跳过 + 超时 + 重启清
- FR-008：事件日志 `dream_started/dream_done/dream_error/dream_rejected`
- FR-011：文档同步（deployment env 表 / usage 路由+错误码 / auth-model 覆盖 / README 双语 / CHANGELOG [Unreleased]）
