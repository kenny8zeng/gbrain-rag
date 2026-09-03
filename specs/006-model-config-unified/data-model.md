# Data Model: 模型配置（006 端点三要素）

## 实体

### 能力（Capability）
- 枚举：`chat`（对话）、`embedding`（向量化）、`rerank`（重排）
- 各自独立三要素配置与状态；无能力特例字段

### 端点三要素（每能力一份）

| 字段（env 名） | 类型 | 必填 | 校验/约束 |
|---|---|---|---|
| `CHAT_BASE_URL` / `EMBEDDING_BASE_URL` / `RERANK_BASE_URL` | URL（http/https） | 该能力启用即必填 | 配置时探测可达；指向 OpenAI 兼容 API |
| `CHAT_MODEL` / `EMBEDDING_MODEL` / `RERANK_MODEL` | string | 同上 | 纯模型名（无前缀）；配置时探测存在于端点 |
| `CHAT_API_KEY` / `EMBEDDING_API_KEY` / `RERANK_API_KEY` | string | 同上 | 配置时最小请求验证（401/403 捕获） |
| `EMBEDDING_DIMENSIONS` | int | 否 | 缺省=探测默认输出维度；用户显式值必须与探测一致或经确认 |

**规则**：三要素齐 = 能力启用；任缺 = 未配置（状态显示缺口清单）；维度为唯一可选项（探测兜底）。

### 派生产物（服务内部，用户不可见）

| 引擎变量 | 来源 |
|---|---|
| `OPENROUTER_BASE_URL` / `OPENROUTER_API_KEY` | CHAT_*（chat 槽） |
| `LLAMA_SERVER_BASE_URL` / `LLAMA_SERVER_API_KEY` | EMBEDDING_*（embedding 槽） |
| `LLAMA_SERVER_RERANKER_BASE_URL/API_KEY` 或 config set | RERANK_*（按探测路径形态选槽） |
| `DASHSCOPE_API_KEY`（值复制） | rerank `/reranks` 槽 key env |
| config set：`search.reranker.enabled/model`、`provider_base_urls.dashscope-rerank` | rerank 装配（启动自愈，幂等） |

### 探测结果（缓存）

| 字段 | 说明 |
|---|---|
| `endpoint_reachable` / `capability_supported` / `model_exists` / `key_valid` | 布尔，配置时求得 |
| `rerank_path` | `"rerank"` 单数 / `"reranks"` 复数 / null（不支持） |
| `embedding_dim` | 探测默认输出维度（int） |

## 状态机（能力级）

`unconfigured`（要素缺）→ `probe_pending` → `ready` | `probe_failed{原因}` | `gap{缺什么}`
- 配置变更 → 重探测（进程内缓存失效）
- 运行期失败（模型下架等）→ 降级提示（含可切换建议），状态不自动回退

## 校验（从 FR 映射）

- FR-001/002：schema 强制（三要素同构、模型纯名无前缀校验）
- FR-004：探测报告（不可达/型号无效/凭证拒/能力不支持）即时返回
- FR-006：维度无法探测 → 明确询问（API 422 + 提示），不静默
- FR-007：缺口清单（差哪一行）
- FR-010 替换：单一面；旧面发布时一次性迁移（运维动作，无运行时兼容层）
