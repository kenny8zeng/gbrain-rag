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

## 4. 数据持久化与备份

- `postgres` 数据卷：引擎页面/索引/凭证——**主数据**
- `DATA_DIR`（/data/rag）：每个 KB 的 git 目录 + 导入原始文档档案
- 备份建议：
  - 定期 `pg_dump`（或 gbrain `gbrain export` 导出 Markdown 全量）
  - 卷快照（DATA_DIR 含 git 历史，可经 `git push` 异地备份）
- 删除知识库为两阶段：`DELETE /v1/kb/:id` 归档（72h 保留）→ `POST /v1/kb/:id/purge?force=true` 永久清除

## 5. 健康检查与监控

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

## 6. 升级

```bash
cd deploy
git pull          # 拉取新版本
docker compose up -d --build
```

- SQL 迁移（rag_keys/rag_jobs 演进）启动期自动执行（`_rag_migrations` 记录，幂等）
- gbrain 引擎版本在 Dockerfile 固定（`garrytan/gbrain` tag），升级即改该处重建
- 破坏性配置变更（如 embedding provider 切换）需 `gbrain embed --stale` 重索引（引擎侧）

## 7. 安全注意

> **URL 导入不做地址校验**（设计取舍，spec FR-013）：服务必须部署在受信隔离网络；如需公网暴露，先收紧 URL 导入策略。
> 管理面 `ADMIN_TOKEN` 与租户密钥（`gbrag_...`）均为高权限凭证：密钥明文仅在签发响应出现一次，泄漏需立即 `DELETE /v1/keys/:id` 吊销。
> 托管 OCR / 外部 docling 可能使文档离开本机——默认关闭/按配置启用。

## 8. 故障排查

| 现象 | 排查 |
|---|---|
| `/health` degraded + gbrain_serve=false | 容器日志 `[gbrain-serve]`；`DATABASE_URL` 连通性 |
| 文件导入 failed | 任务 `error` 含解析器分类与回退链（`parser_log`）；docling 不可达时确认 anydoc 回退是否生效 |
| URL/图片导入 422 PARSER_UNAVAILABLE | 未配置 `DOCLING_URL`（当前 anydoc 唯一模式） |
| MCP 客户端 401 | 密钥吊销或无效；`X-API-Key` 头正确性 |
| 429 集中出现 | MCP 逐密钥并发上限或代理 maxConcurrency（管理面） |
| 升级后既有页面检索异常 | 引擎版本/索引变更——检查 `gbrain doctor`、必要时 `gbrain embed --stale` |
