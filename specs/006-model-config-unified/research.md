# Research: 探测协议与引擎槽位实证（006）

**来源**：gbrain v0.47.6.0 引擎源码 + 生产/本地实测（2026-09-03）。无 NEEDS CLARIFICATION——全部已实证。

## 1. OpenAI 兼容探测端点形态

- **chat**：`GET {base}/models`（OpenAI 兼容标准）——返回模型清单；`POST {base}/chat/completions` 验证
- **embedding**：`POST {base}/embeddings` `{model, input:"ping"}`——200 返回向量（**响应维度 = 该端点默认输出**，因引擎不发 dimensions 参数）；模型不存在 → 400/404
- **rerank 路径探测**：先试 `POST {base}/rerank` 后试 `POST {base}/reranks`（同体最小请求 `{model, query, documents:[…]}`）：
  - `/reranks`（复数）→ dashscope-rerank 槽（实测 dashscope `compatible-api/v1/reranks` 200；`/rerank` 单数 404）
  - `/rerank`（单数）→ llama-server-reranker 槽（llama.cpp 风格）
- 凭证错误：401/403 捕获（dashscope 国内 key 打 intl 端点 401——探测用用户给的端点，无此歧义）

**Decision**: 探测 = 每能力最多 2 次小请求（模型存在性 + 需要时的 rerank 形态/embedding 维度），超时 10s，结果缓存（进程内 + 服务表），配置/启动时执行。

## 2. 引擎槽位选择（确定性映射，非试探）

- chat → **openrouter 槽**：`OPENROUTER_BASE_URL` env 覆盖端点（build-gateway-config 实证）；chat 无白名单；`openrouter:` 前缀模型任意
- embedding → **llama-server 槽**：`LLAMA_SERVER_BASE_URL` env；无白名单（生产实证 1024d 全链路）；模型 `llama-server:<纯名>`
- rerank 按探测路径选 dashscope-rerank 槽（config set `provider_base_urls.dashscope-rerank` + `search.reranker.model dashscope-rerank:<纯名>` + `search.reranker.enabled true`）或 llama-server-reranker 槽（`LLAMA_SERVER_RERANKER_BASE_URL/API_KEY` + `llama-server-reranker:<纯名>`）

**Alternatives considered**: litellm 槽（通用但需 litellm recipe 细节）、llama-server 槽同时跑 chat+embedding（单端点限制，两能力不同端点时不成立）→ openrouter+llama-server 双槽覆盖 chat/embedding 任意双端点。

## 3. 配置面删除清单（用户拍板：干净清除）

| 删除 | 替代 |
|---|---|
| `CHAT/EMBEDDING/RERANK_PROVIDER` 中间面（v1，未发布） | 端点三要素 |
| entrypoint `map_env/map_model` bash 映射 | 单点 TS 派生（model-router-cli） |
| `model-profiles.ts` 档案 + 白名单预检 | endpoint-probe 真实探测（更准，不过时） |
| 引擎透传变量（`GBRAIN_CHAT_MODEL`/`DEEPSEEK_API_KEY`/`OPENAI_API_KEY`/`DASHSCOPE_API_KEY`…）作为配置入口 | 内部产物（派生注入），文档移除 |
| `GBRAIN_RERANKER_CONFIG_REQUIRED` 标记 | 派生结构返回 |

**保留**：`EMBEDDING_BASE_URL/MODEL/API_KEY/DIMENSIONS`、`RERANK_BASE_URL/API_KEY/MODEL`（语义=端点三要素，字段名沿用）→ **新增** `CHAT_BASE_URL/CHAT_MODEL/CHAT_API_KEY`。

## 4. 生产迁移（Zeabur，发布时一次性）

现有 env（中立面 + 手配 config set）→ 端点三要素：`EMBEDDING_*` 原值保留；`RERANK_*` 三行显式化；新增 `CHAT_*` 三行（值取现 deepseek）；删除 PROVIDER 类与引擎透传类 env。config set（DB）保留不变（服务仍自动装配幂等）。
