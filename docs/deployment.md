# 部署说明

gbrain-rag 以**单镜像**交付（gbrain 引擎 + Bun 应用 + anydoc 解析器同镜像），外部依赖仅 Postgres 与（可选的）docling 服务。

> **⚠️ 安全部署前提（必读）**：URL 导入**不做目标地址校验**（设计取舍，spec FR-013）——任何持租户凭证者可将服务指向内网/云元数据地址触发转换。**服务必须部署在受信隔离网络**，ADMIN_TOKEN 用高强度随机值；如需公网暴露（如 Zeabur 域名），先收紧 URL 导入策略或置于网关 ACL 后。

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

### 4.0 配置心智（唯一入口）

**每个模型能力 = 三行：端点地址 + 纯模型名 + 钥匙。** 三种能力格式完全一致，无任何供应商专有概念（前缀/接入通道/认证名单/开关全部由服务自动处理）。

```env
# 对话（hybrid 扩展/think 等）
CHAT_BASE_URL=https://api.deepseek.com/v1     # OpenAI 兼容端点
CHAT_MODEL=deepseek-v4-flash                   # 纯模型名
CHAT_API_KEY=sk-...

# 向量化（语义检索必需）
EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_MODEL=qwen3.7-text-embedding
EMBEDDING_API_KEY=sk-...
# EMBEDDING_DIMENSIONS=1024   # 可选：缺省 = 服务探测端点默认输出维度

# 重排（可选，提升排序）
RERANK_BASE_URL=https://dashscope.aliyuncs.com/compatible-api/v1
RERANK_MODEL=qwen3-rerank
RERANK_API_KEY=sk-...
```

**约束**：
- 仅支持 OpenAI 兼容 API（主流服务均提供：百炼/OpenRouter/DeepSeek/OpenAI/智谱等；原生独有 API 需经兼容网关）
- 模型名禁止含 `:`（前缀标记已废除）
- 三要素齐 = 能力启用；缺行 = 未配置（状态查询列出缺口）
- 未配置时：keyword 检索不受影响；hybrid 向量检索降级（`degraded` 字段），后补配置后需 `gbrain embed --stale` 回填

### 4.1 服务自动完成的事（用户无感）

- **配置时真实探测**（启动/`POST /v1/admin/models`）：端点可达、模型存在、凭证有效、能力支持——错误当场人话返回（`ENDPOINT_UNREACHABLE`/`KEY_REJECTED`/`MODEL_NOT_FOUND`/`CAPABILITY_UNSUPPORTED`）
- **维度自动探测**：向端点发最小嵌入请求取默认输出维度（引擎不发 dimensions 参数，以端点实返为准）
- **重排接口形态自动识别**：`/reranks`（复数）与 `/rerank`（单数）路径各服务不统一——探测识别后自动选接入通道
- 端点/模型/key 经服务映射到引擎通道（chat/embedding 走通用 OpenAI 兼容通道；rerank 按形态装配），**运行期模型不可用时降级提示含可切换建议**

### 4.2 状态与装配

- `GET /v1/admin/models`：每能力状态（ready/unconfigured/gap/probe_failed）+ 引擎侧实际值 + 完整度
- `POST /v1/admin/models`：提交端点三要素 → 探测报告 + 引擎 schema 级装配（config set）——配置时验证、避免运行期失败

> 维度注意：1024+ 维模型超过 pgvector HNSW 索引上限（2000）时引擎自动回退精确扫描（功能一致，超大语料更慢）。切换向量化模型后需 `gbrain embed --stale` 重索引。

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

