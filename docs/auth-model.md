# 服务认证模型（管理面 / 租户面）

系统说明：两平面鉴权机制、凭证生命周期、授权判定、上游隔离与安全属性。
配套：[使用介绍 §2 接口平面](usage.md)（速查）、[examples.md](examples.md)（curl 示例）。

## 1. 两平面总览

| 维度 | 管理面（Admin） | 租户面（Tenant） | 公开面 |
|---|---|---|---|
| 凭证 | `ADMIN_TOKEN`（部署时环境变量） | API key（`gbrag_<32hex>`，签发产生） | 无 |
| 传输 | `Authorization: Bearer <token>` | `X-API-Key: <key>` | — |
| 覆盖 | KB 生命周期、凭证签发/变更/吊销、任务、模型配置、梦境周期（`/v1/admin/dream`）、引擎运维代理（`/v1/admin/gbrain/*`） | 导入、页面管理、检索、任务状态、MCP | `/health`、`/docs`、`/openapi.json` |
| 信任边界 | **全权**（含破坏性运维） | 签发时钉定的分区组合 | 只读元数据 |
| 隔离实现 | 单 token 比对 | 哈希查表 → 上游 OAuth client 硬隔离 | — |

**心智**：管理面 = 部署者的钥匙（一把全权）；租户面 = 发给每个 Agent/应用的钥匙（每把钉死权限，吊销即失效）。两平面互不通用（Bearer 不能当 X-API-Key，反之亦然）。

## 2. 管理面认证

- 中间件逐请求比对 `Authorization` 头与 `cfg.ADMIN_TOKEN`（环境变量注入，部署时设定）
- 失败统一 401 `{"error":{"code":"UNAUTHORIZED","message":"admin token required"}}`（不区分缺头/错值，不泄露正确性）
- `ADMIN_TOKEN` 即全权：无二次确认层（破坏性命令的确认语义在引擎 CLI 侧）；**运维要求**：高强度随机（≥32 hex）、仅部署者持有、定期轮换（轮换 = 改 env + 重启）

## 3. 租户面认证与授权

### 3.1 凭证形态与存储

- 签发：`POST /v1/keys` → 返回 `gbrag_<32hex>`（CSPRNG 128bit）——**明文仅此一次**，此后任何接口不再返回
- 存储：入库仅 **SHA-256 哈希**（`rag_keys.key_hash`）+ 展示前缀 `key_prefix`（前 12 字符，列表用）；库被窃不泄露可用 key
- 校验：请求 key → SHA-256 → 查表 → 命中且未吊销即通过（401 语义见 §5）

### 3.2 凭证字段（签发时钉定，可 rescope）

| 字段 | 语义 |
|---|---|
| `write_kb` | **写分区**（0 或 1 个）：导入/删页面仅允许在此 |
| `read_kbs` | **读授权列表**：列表/检索允许 写分区 ∪ 此列表 |
| `surface` | 上游 OAuth client 工具面（默认 `starter`：内容管理+检索；可调 `full`） |
| `concurrency` | 并发闸门（默认 1）——超限 429 |
| `label` | 展示名（唯一，重复 409 `LABEL_TAKEN`） |

### 3.3 授权判定（路由级，中间件后）

- `canWriteKb(row, kb)`：`row.writeKb === kb`——**写操作仅写分区**
- `canReadKb(row, kb)`：`writeKb === kb || readKbs.includes(kb)`——读 = 写 ∪ 读
- 越权一律 **403**（不泄露资源存在性——与"资源不存在 404"刻意区分仅在权限合法时可见）
- 跨库检索自动合并读授权内分区（Agent 无需指定分区）

### 3.4 上游 OAuth client（真正执行隔离的层）

租户凭证不是直接访问引擎的凭证——服务用它**换取一个钉定分区/读列表/工具面的上游 OAuth client**（`auth register-client` / `rescope-client`），引擎侧由 client 的 `--source`（写分区）、`--federated-read`（读列表）、`--bound-slug-prefixes`（slug 栅栏）、`--surface` 硬性保证隔离：

- **slug 栅栏**：写操作 slug 必须落在 `kb-xxx/docs/` 前缀——请求参数无法越权（us3 集成实证）
- 后续请求经 `Upstream` 用 client 凭证 `client_credentials` 换 Bearer（TTL 缓存 + 过期/401 自动刷新）后注入转发
- MCP 网关（`/mcp`）同一条 X-API-Key：鉴权 → 换对应 client token → 透传 Streamable HTTP

### 3.5 生命周期与即时性

| 操作 | 生效 |
|---|---|
| 签发 | 立即（client 注册完成后） |
| `PATCH /v1/keys/:id`（rescope：改读写分区/surface/concurrency） | **即时生效**（rescope 上游 client，无缓存窗口） |
| `DELETE /v1/keys/:id`（吊销） | **即时 401**（client 吊销 + 本地 revoked_at） |
| KB 归档/清除 | 联动吊销引用该 KB 的全部凭证（purge 前置预检，FK 阻塞保护——D12） |

## 4. 内部检索凭证（服务自用，非用户面）

服务自身需跨分区检索（T049 serve 通道）：维护单一**内部只读 client**（`rag-internal-*`，`--scopes read` + federated-read 覆盖全部活跃 `kb-*` 源）：
- 懒注册（首次检索/建库时），**进程内存缓存** token
- 重启/库清除时先吊销遗留内部 client 再重注册（防累积泄漏阻塞 purge——D13）
- 该凭证不可被外部使用（仅服务进程持有）；不影响租户隔离（租户越权仍被上游 client 拒绝）

## 5. 错误语义与安全属性

| 场景 | 响应 | 说明 |
|---|---|---|
| 管理面缺/错 Bearer | 401 `UNAUTHORIZED` | 不区分缺头与错值 |
| 租户面缺 `X-API-Key` | 401（`missing X-API-Key header`） | |
| key 无效 **或已吊销** | 401（`invalid api key`） | **同响应**——吊销与不存在不可区分，不泄露 key 是否曾有效 |
| 凭证有效但越权 | 403 `FORBIDDEN` | 无存在性信息（不泄露目标 KB 是否存在） |
| 并发超限 | 429 `RATE_LIMITED` | per-key 闸门 |
| 访问已归档 KB | 410 `ARCHIVED` | 归档 = 逻辑删除（72h 保留） |

**安全设计要点**：
- key 明文仅签发一次 + 哈希存储 + 吊销/不存在同响应 → 泄库/撞库/枚举均不可行
- 服务层不存引擎密码类长期凭证：OAuth token 内存 TTL 缓存，进程重启即失
- `ADMIN_TOKEN` 与租户 key 物理隔离（不同头、不同表、不同权限面）

## 6. 运维速查

```bash
# 签发（明文仅此一次——立即保存）
curl -X POST $B/v1/keys -H "Authorization: Bearer $ADMIN" \
  -d '{"label":"agent-a","write_kb":"kb-xxxx","read_kbs":["kb-yyyy"]}'
# 变更授权（即时生效）
curl -X PATCH $B/v1/keys/<id> -H "Authorization: Bearer $ADMIN" -d '{"read_kbs":["kb-zzzz"]}'
# 吊销（即时 401）
curl -X DELETE $B/v1/keys/<id> -H "Authorization: Bearer $ADMIN"
# 轮换 ADMIN_TOKEN：改部署 env → 重启（无热切换）
```

**测试覆盖**：凭证生命周期全链路见 [testing-strategy.md](testing-strategy.md)（us1 场景 1-5：签发→越权 403→rescope 即时→吊销 401）；MCP 隔离矩阵（跨源命中/栅栏/吊销）；哈希存储/并发闸门单测。
