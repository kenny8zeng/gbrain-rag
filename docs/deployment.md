# 部署说明

gbrain-rag 以**单镜像**交付（gbrain 引擎 + Bun 应用 + anydoc 解析器同镜像），外部依赖仅 Postgres 与（可选的）docling 服务。

## 1. 架构与组件

| 组件 | 形态 | 说明 |
|---|---|---|
| gbrain-rag 镜像 | 单容器 | 统一路由 + MCP 网关 + 摄取 worker；`gbrain serve --http` 为受监督子进程（仅容器回环） |
| gbrain 引擎 | 镜像内（v0.47.6.0 源码编译） | 知识库核心：分区/页面/索引/检索 |
| Postgres | 独立容器（pgvector） | 引擎数据 + 服务自有表（rag_keys/rag_jobs） |
| docling | 独立服务（可选） | URL/图片/复杂版面/OCR 能力；不配置则文件类由内置 anydoc 处理 |
| anydoc | 镜像内（进程内 native） | Office/PDF 毫秒级本地转换（默认解析器回退） |

## 2. 快速部署（compose）

```bash
cd deploy
cp .env.example .env          # 修改必填项（见 §3）
docker compose up -d --build
curl http://localhost:3000/health
```

预期健康响应：

```json
{"status":"ok","gbrain_serve":true,"db":true,"docling":true,
 "parser_mode":"docling","parser_primary":"docling","parser_preference":"docling"}
```

从镜像直接部署（不本地构建）：

```bash
# 替换 image 为发布镜像（deploy/compose.yaml 的 build 节改为 image）
docker compose -f - <<'EOF'
services:
  postgres: { image: pgvector/pgvector:pg16, ... }
  gbrain-rag:
    image: ghcr.io/kenny8zeng/gbrain-rag:latest
    env_file: [.env]
    ports: ["3000:3000"]
EOF
```

## 3. 环境变量

### 必填

| 变量 | 说明 |
|---|---|
| `ADMIN_TOKEN` | 管理面 Bearer（≥16 字符）；租户面密钥经 API 签发 |
| `DATABASE_URL` | Postgres 连接串（引擎与服务共用；首启自动建 schema） |
| `DOCLING_URL` | 外部解析服务地址；**留空 = 内置 anydoc**（文件类本地转换，URL/图片导入不可用） |

### 解析器（可选）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PARSER_MODE` | `auto` | `docling`/`anydoc` 强制单解析器（测试/排障，无回退） |
| `PARSER_PREFERENCE` | `docling` | docling 配置时的首选；另一解析器为失败回退 |
| `ANYDOC_OCR` | `off` | `on` 启用扫描 PDF 托管 OCR（数据出机器） |
| `FIRECRAWL_API_KEY` | 空 | 托管 OCR 凭证（ANYDOC_OCR=on 时需要） |

### 服务（可选）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | 对外端口 |
| `GBRAIN_SERVE_PORT` | 7333 | 内部 MCP 服务端口（回环，勿对外暴露） |
| `DATA_DIR` | /data/rag | 数据卷（KB git 目录/原始文档/暂存） |
| `CORS_ORIGINS` | 空 | 跨域来源列表（逗号分隔；空=关闭；`*`=全放行） |
| `MAX_UPLOAD_BYTES` | 104857600 | 单文件上传上限 |
| `WORKER_CONCURRENCY` | 2 | 摄取并发 |
| `JOB_MAX_ATTEMPTS` | 3 | 任务失败重试次数 |
| `JOB_TIMEOUT_MS` | 600000 | 任务超时（docling 调用另受 110s 下限约束） |

## 4. LLM / Embedding / Rerank 模型配置

gbrain 引擎的模型配置经环境变量透传（容器内 `gbrain init` / CLI / `serve` 统一读取）。**生效时机：首次 init 时写入引擎 schema 配置**；变更模型后需重跑 init（或引擎侧 `config set`）并 `gbrain embed --stale` 重索引（embedding 属 schema 级设置）。

**供应商中立三件套**（推荐）：配置面只认"端点 + 模型 + 维度"，由 entrypoint 自动映射为引擎约定变量（原生 gbrain 变量优先，并存冲突时启动日志警告）：

| 中立变量 | 映射到 | 说明 |
|---|---|---|
| `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` | `LLAMA_SERVER_BASE_URL` / `_API_KEY` | OpenAI 兼容网关（litellm/one-api/llama-server 等皆可） |
| `EMBEDDING_MODEL` | `GBRAIN_EMBEDDING_MODEL` | 无 `provider:` 前缀自动补 `llama-server:`（该端点即网关） |
| `EMBEDDING_DIMENSIONS` | `GBRAIN_EMBEDDING_DIMENSIONS` | 维度是模型资产，必须匹配 |
| `RERANK_BASE_URL` / `RERANK_API_KEY` / `RERANK_MODEL` | `LLAMA_SERVER_RERANKER_*` / `GBRAIN_RERANKER_MODEL` | 同上（rerank 仅兼容实现 rerank 的端点） |

原生变量（`GBRAIN_CHAT_MODEL` 等）继续直接可用；两者并存且值不同 → 原生优先 + 启动警告。模型配置状态与预检警告（冲突/缺维度/维度错配）在启动日志（`evt: model_config` / `model_config_warning`），启动后自动跑一次 `gbrain models doctor` 探活（`evt: models_doctor`）。

> 注：`/health.models` 表达**用户显式配置就绪**状态；引擎可能另有内置默认（如 zeroentropyai 免费 embedding），实际可用性以 `models_doctor` 日志为准。

> 与 Docker Hub 的 `docker-gbrain` 封装不同：本项目镜像不做 provider 自动选择，直接透传以下变量——**显式设置**即生效。
>
> **供应商中立性说明**：embedding/rerank 的接入通道是 **OpenAI 兼容抽象**（gbrain 的 `openai-compatible` provider 族）——`LLAMA_SERVER_BASE_URL`/`LLAMA_SERVER_RERANKER_BASE_URL` 只是 gbrain 沿用的端点别名，**指向任意 OpenAI 兼容网关（litellm、one-api、自建聚合等）同样有效**，`gbrain models doctor` 会探测端点真实类别。示例落在 OpenAI 与 llama-server 两家是因为：embedding 的模型维度/名称是供应商资产（语法需 `provider:model` 前缀）；rerank 无统一标准（OpenAI 不提供 rerank API），仅实现了兼容 rerank 的端点（llama-server、zeroentropyai 等）可接。

### 4.0 模型配置心智模型（先读）

配置语法 `provider:model`（如 `dashscope-rerank:qwen3-rerank`）由**两层独立结构**配对而成：

**第一层——通道（recipe，供应商/接入方式）**：决定连接方式与使用的 key。
- **专用通道**：`openai`、`anthropic`、`deepseek`、`dashscope`、`dashscope-rerank`、`openrouter`、`voyage`、`zeroentropyai` 等——引擎内建，各自声明 key 变量（如 `DASHSCOPE_API_KEY`、`OPENROUTER_API_KEY`）与默认端点。
- **通用兼容通道（别名）**：`llama-server`、`llama-server-reranker`、`litellm`、`ollama`——**无模型认证清单**，可指向任意 OpenAI 兼容端点并透传任意模型名。本项目的中立三件套（`EMBEDDING_*`/`RERANK_*`）即映射到此通道。

**第二层——模型认证清单**：挂在"某通道的某能力"下（chat / embedding / rerank 各自独立）。
- **清单非空 → 强制校验**：模型不在清单内，该通道直接拒绝（错误信息含可用模型列表）。
- **清单为空（别名通道）→ 任意模型透传**。

**实用推论（对应本项目实际配置）**：

| 组合 | 为什么可用/不可用 |
|---|---|
| `dashscope:qwen3.7-text-embedding` ✗ | dashscope 的 embedding 认证清单仅 `text-embedding-v3`/`v2` |
| `llama-server:qwen3.7-text-embedding` ✓（生产现状） | 别名通道无清单，指向 dashscope 兼容端点即可 |
| `dashscope-rerank:qwen3-rerank` ✓ | dashscope-rerank 的 rerank 清单含 `qwen3-rerank` |
| `openrouter:cohere/rerank-v3.5` ✓ | openrouter 的 rerank 清单含 cohere 系 |
| `openrouter:openai/text-embedding-3-small` ✓ | openrouter 的 embedding 清单（窄） |

**换供应商的检查顺序**：① 目标通道是否提供该能力 → ② 模型是否在该能力认证清单（报错会列出）→ ③ 该通道的 key 变量 → ④ embedding 换模型另需核对维度与全量重索引。各通道认证清单以 `gbrain models doctor` 与实际报错为准（引擎内建，随版本演进）。

### 4.1 Chat / 扩展模型（可选，语义检索的 expansion 依赖）

供多查询扩展（hybrid 的 `--expand`）、`think`、autopilot 等 LLM 能力使用。语法 `provider:model`：

| 变量 | 示例 | 说明 |
|---|---|---|
| `GBRAIN_CHAT_MODEL` | `deepseek:deepseek-v4-flash`、`openai:gpt-4o`、`anthropic:claude-...` | 模型 id（provider:model） |
| `DEEPSEEK_API_KEY` | `sk-...` | deepseek 系 key |
| `OPENAI_API_KEY` | `sk-...` | openai 系 key |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | anthropic 系 key |

未配置时：`keyword` 检索不受影响；`hybrid` 的多查询扩展降级、`think`/autopilot 不可用。

### 4.2 Embedding（向量检索必需）——中立变量主路径

```env
# 任意 OpenAI 兼容网关（litellm/one-api/自建聚合/llama-server 皆可）
EMBEDDING_BASE_URL=http://<gateway>:8080/v1
EMBEDDING_MODEL=qwen3-embedding-4b      # 无前缀自动补 llama-server:（该端点即网关）
EMBEDDING_DIMENSIONS=2560               # 维度是模型资产，必须与模型匹配
EMBEDDING_API_KEY=...                   # 网关 key（可选）
```

未配置时引擎以 `--no-embedding` 等效运行（另有内置免费默认，见上注）：向量检索不可用、检索 `degraded: ["embed_unavailable"]`、关键词仍可用；**后补配置后需 `gbrain embed --stale` 回填**。

> 维度注意：2560d 模型超过 pgvector HNSW 索引上限（2000），引擎自动回退精确扫描（功能一致，超大语料更慢）。

### 4.3 Rerank（可选，提升排序）——中立变量主路径

```env
# 仅兼容实现 rerank API 的端点（OpenAI 原生无 rerank；llama-server/zeroentropyai 等网关可用）
RERANK_BASE_URL=http://<gateway>:8080/v1
RERANK_MODEL=qwen3-reranker-0.6b
RERANK_API_KEY=...                      # 可选
```

### 4.4 原生变量（高级/兼容）

中立变量映射的底层即以下 gbrain 原生命名——直连云端供应商（非网关）时使用：

| 用途 | 变量 |
|---|---|
| Chat/扩展 | `GBRAIN_CHAT_MODEL`（provider:model）+ `DEEPSEEK_API_KEY`/`OPENAI_API_KEY`/`ANTHROPIC_API_KEY` |
| Embedding 直连 | `GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large` + `GBRAIN_EMBEDDING_DIMENSIONS=3072` + `OPENAI_API_KEY` |
| Embedding 网关 | `GBRAIN_EMBEDDING_MODEL=llama-server:...` + `LLAMA_SERVER_BASE_URL`/`LLAMA_SERVER_API_KEY` |
| Rerank | `GBRAIN_RERANKER_MODEL` + `LLAMA_SERVER_RERANKER_BASE_URL`/`_API_KEY` |

### 4.5 完整示例

```env
# 网关模式（供应商中立；embedding + rerank 同一网关）+ DeepSeek chat
GBRAIN_CHAT_MODEL=deepseek:deepseek-v4-flash
DEEPSEEK_API_KEY=sk-...
EMBEDDING_BASE_URL=http://<gateway>:8080/v1
EMBEDDING_MODEL=qwen3-embedding-4b
EMBEDDING_DIMENSIONS=2560
RERANK_BASE_URL=http://<gateway>:8080/v1
RERANK_MODEL=qwen3-reranker-0.6b
```

```env
# 云端直连（原生变量；chat 同供应商或独立）
GBRAIN_CHAT_MODEL=deepseek:deepseek-v4-flash
DEEPSEEK_API_KEY=sk-...
GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large
GBRAIN_EMBEDDING_DIMENSIONS=3072
OPENAI_API_KEY=sk-...
```

### 4.6 验证

```bash
# 模型是否被引擎识别（container 内）
docker compose exec gbrain-rag gbrain config show | grep -E 'embedding|rerank|chat'
# 检索是否降级（响应 degraded 字段为空 = 向量可用）
curl -s -X POST .../v1/kb/$KB/retrieval -d '{"query":"测试"}' | jq .degraded
# 引擎健康总检
docker compose exec gbrain-rag gbrain doctor
```

## 5. 数据持久化与备份

- `postgres` 数据卷：引擎页面/索引/凭证——**主数据**
- `DATA_DIR`（/data/rag）：每个 KB 的 git 目录 + 导入原始文档档案
- 备份建议：
  - 定期 `pg_dump`（或 gbrain `gbrain export` 导出 Markdown 全量）
  - 卷快照（DATA_DIR 含 git 历史，可经 `git push` 异地备份）
- 删除知识库为两阶段：`DELETE /v1/kb/:id` 归档（72h 保留）→ `POST /v1/kb/:id/purge?force=true` 永久清除

## 6. 健康检查与监控

`GET /health` 字段：

| 字段 | 含义 |
|---|---|
| `status` | ok / degraded（db 或 serve 不可达即 degraded） |
| `gbrain_serve` | 内部 MCP 服务可达性 |
| `db` | Postgres 可达性 |
| `docling` | 外部解析服务可达性（未配置=false，非故障） |
| `parser_mode` / `parser_primary` | 当前首选解析器 |
| `parser_preference` | 配置的优先级 |

结构化日志（stdout JSON）：`evt` 事件含 `listening`/`migrate`/`supervisor`/`job_error`/`retrieval_fallback`/`internal_client` 等；任务记录含 `parser_log`（解析路径与回退链）。

## 7. 升级

```bash
cd deploy
git pull          # 拉取新版本
docker compose up -d --build
```

- SQL 迁移（rag_keys/rag_jobs 演进）启动期自动执行（`_rag_migrations` 记录，幂等）
- gbrain 引擎版本在 Dockerfile 固定（`garrytan/gbrain` tag），升级即改该处重建
- 破坏性配置变更（如 embedding provider 切换）需 `gbrain embed --stale` 重索引（引擎侧）

## 8. 安全注意

> **URL 导入不做地址校验**（设计取舍，spec FR-013）：服务必须部署在受信隔离网络；如需公网暴露，先收紧 URL 导入策略。
> 管理面 `ADMIN_TOKEN` 与租户密钥（`gbrag_...`）均为高权限凭证：密钥明文仅在签发响应出现一次，泄漏需立即 `DELETE /v1/keys/:id` 吊销。
> 托管 OCR / 外部 docling 可能使文档离开本机——默认关闭/按配置启用。

## 9. 故障排查

| 现象 | 排查 |
|---|---|
| `/health` degraded + gbrain_serve=false | 容器日志 `[gbrain-serve]`；`DATABASE_URL` 连通性 |
| 文件导入 failed | 任务 `error` 含解析器分类与回退链（`parser_log`）；docling 不可达时确认 anydoc 回退是否生效 |
| URL/图片导入 422 PARSER_UNAVAILABLE | 未配置 `DOCLING_URL`（当前 anydoc 唯一模式） |
| MCP 客户端 401 | 密钥吊销或无效；`X-API-Key` 头正确性 |
| 429 集中出现 | MCP 逐密钥并发上限或代理 maxConcurrency（管理面） |
| 升级后既有页面检索异常 | 引擎版本/索引变更——检查 `gbrain doctor`、必要时 `gbrain embed --stale` |
