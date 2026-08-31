# Research: 001-gbrain-rag-service

Phase 0 输出。spec 中已无 [NEEDS CLARIFICATION]；本文档解决技术选型层面的未知项。所有"实证"均于 2026-08-31 在评估容器 `kenny8zeng/gbrain:gbrain-v0.47.6.0` 上验证。

## D1: gbrain 在镜像内的打包方式

- **Decision**: Dockerfile 多阶段构建，gbrain 从 GitHub 源码拉取并编译：构建层 `git clone --depth 1 --branch v0.47.6.0 https://github.com/garrytan/gbrain.git && bun install && bun run build`（`bun build --compile --outfile bin/gbrain src/cli.ts`，自包含 ELF），产物拷入运行层 `/usr/local/bin/gbrain`。
- **Rationale**: 用户决策（核心包必须源码构建，不依赖他人镜像分层）。已核实：源仓库 `github.com/garrytan/gbrain`（镜像内 `/app/.git/config` origin，公开可达，tag `v0.47.6.0` 存在）；构建脚本为上游 `package.json#scripts.build`（bun compile 自包含运行时）；npm `gbrain@1.3.1` 为同名无关项目（stormcolor GPU 库），不可用。构建层固定 Bun 版本以保证编译可复现。
- **Alternatives considered**: `FROM kenny8zeng/gbrain` 基底 + 安装 Bun（黑盒分层、不可复现、含 536MB 未审计资产，用户否决）；`COPY --from` 官方镜像提取二进制（同样依赖他人产物）；npm 安装（同名包冲突，弃）。
- **实现期待验证**: `bun run build` 之外的资产步骤（`build:admin-embedded` 等）是否为 serve 必需——以编译产物直接跑 `gbrain serve --http` 冒烟判定，缺则补执行对应 script。

## D2: MCP 网关的上游隔离机制

- **Decision**: 每个 Agent 凭证对应一枚上游 OAuth client（`auth register-client --grant-types client_credentials --scopes read --source <写分区> --federated-read <读分区列表> --bound-slug-prefixes <写分区>/*`），网关持 client_id/secret 换取 access token（`POST /token`，client_credentials，TTL 1h）后以 Bearer 代理至 `gbrain serve --http`。
- **Rationale**: 实证结论：(a) federated-read 列表使 search/query **自动跨源合并**（[probe-a,probe-b] 客户端一次检索同时命中两源）；(b) 请求级 `--source-id`/`__all__` 对 remote caller 不能越出 grant（单源对照完全不可见未授权源）；(c) `revoke-client` 级联清除 token。gbrain 的隔离绑定在凭证而非请求上，代理必须按凭证换发，这是唯一可靠的硬隔离通道。
- **Alternatives considered**: 单上游凭证 + 网关翻译工具调用（`gbrain call` 逐次 spawn）——需手工维护 55+ 工具映射、新版本工具面漂移风险、无引擎侧第二道防线；弃。

## D3: CLI 通道的分区钉定

- **Decision**: 管理面/摄取/REST 检索统一持单 admin 凭证；对每个涉及分区的调用以 `GBRAIN_SOURCE` 环境变量（spawn env）钉定，永不接受调用方传入的 source 选择。
- **Rationale**: CLI 原生支持 env 钉定（sources current 解析序：flag > env > dotfile > …），spawn env 天然进程级隔离；与 D2 组合形成双通道闭环。
- **Alternatives considered**: 每次调用传 `--source` flag——语义等价，但 flag 与用户参数拼接更易出错；env 方式把钉定固化在封装层（`gbrain-cli.ts` 唯一入口）。

## D4: Web 框架与校验

- **Decision**: Hono + Zod。
- **Rationale**: Hono 原生支持 Bun、SSE 流式响应、中间件链，满足统一路由 + 双平面鉴权 + SSE 代理需求；Zod 做 REST 契约校验并直接产出 OpenAPI 描述（聚合 Swagger UI）。
- **Alternatives considered**: Elysia（校验一体但团队既有 cli2api 为 Hono 生态）、裸 node:http（手写过多）。

## D5: 自有表的持久化与迁移

- **Decision**: Bun 内置 SQL 客户端（`Bun.SQL`/postgres 驱动）+ 纯 SQL 迁移文件（`deploy/migrations/00XX-*.sql`），启动时按序执行（记录于 `_rag_migrations` 表）。不引入 ORM。
- **Rationale**: 自有表仅 `rag_keys`、`rag_jobs` 两张，读写模式简单；ORM 的 schema 管理价值低于其依赖成本。GBrain schema 由 `gbrain init --url $DATABASE_URL` 幂等自管，互不侵扰。
- **Alternatives considered**: drizzle/prisma——两表规模下纯负担；复用 gbrain 的表存凭证——侵入引擎 schema，升级风险，弃。

## D6: 摄取 worker 的任务认领

- **Decision**: `rag_jobs` 表 + `UPDATE ... WHERE id = (SELECT id FROM rag_jobs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING ...` 原子认领；running 超时（>30min 无心跳）由启动期回收扫描重置为 queued。
- **Rationale**: SKIP LOCKED 是 Postgres 队列的标准解，单进程内多 worker 与未来横向扩 worker 均正确；无需引入外部队列。
- **Alternatives considered**: gbrain Minions jobs 队列——内置 job 类型无法承载自定义 docling 任务（CLI `jobs submit <name>` 仅限注册类型）；内存队列——进程重启丢任务。

## D7: Docling 调用契约

- **Decision**: 统一用同步端点：文件/图片 → `POST /v1/convert/file`（multipart `files` + `to_formats=["md"]` + OCR/picture 选项）；URL → `POST /v1/convert/source`。取 `document.md_content`（ConvertDocumentResponse）。worker 内调用，超时 600s；不用 async/poll 端点、不用 /v1/chunk。
- **Rationale**: openapi.json（v1.30.0）已核实字段（required: `files`；响应 required: `document/status/processing_time`）；worker 本身即异步层，docling 自带并发管理，再叠加其 async 端点徒增状态机。分块由 gbrain 承担（spec 非目标）。
- **Alternatives considered**: `/v1/convert/*/async` + 轮询——多一层任务映射；`/v1/chunk/*`——破坏 gbrain chunker 元数据一致性（spec 已排除）。

## D8: 凭证与密钥管理

- **Decision**: API key 格式 `gbrag_<32hex>`（CSPRNG），仅存 SHA-256 哈希 + 前 8 字符前缀用于列表展示；上游 client secret v1 明文存 `rag_keys`（卷权限 + 文档标注风险，后续加 `DATA_ENCRYPTION_KEY` 列级加密）。
- **Rationale**: 与 gbrain 自身 `gbrain_at_/gbrain_cs_` 前缀风格一致，便于人工辨识；YAGNI——加密在后凭证量上规模后再做。
- **Alternatives considered**: bcrypt/argon2 哈希——API key 是高熵随机串，SHA-256 足够且支持 O(1) 查找；JWT 型自包含凭证——无法即时吊销。

## D9: 摄取入库命令与 slug 约定

- **Decision**: 页面写入用 `gbrain put <slug> --content <markdown>`（CLI 签名已核实 `--content` 为必填；`capture --file` 备用于超大内容）；slug 约定 `<source-id>/docs/<派生名>`，与上游 slug 栅栏一致；入库后调用 `gbrain embed <slug>`。重复导入 = upsert（spec FR-008），任务结果标注 created|updated。
- **Rationale**: put 语义即"整体替换 + 引擎侧 chunk/embed/链接抽取"，正是摄取所需；embed 失败降级为 done_with_warnings（关键词检索仍可用）。
- **Alternatives considered**: `import` 目录整导——适合批量迁移场景，单文档导入的任务粒度对不上。

## D10: cli2api 提炼与 jsonArg 扩展

- **Decision**: 从 `~/workspace/gbrain-services/cli2api` 提炼 `src/{registry,runner,argv}.ts` + `clis/gbrain.yaml` 为 `packages/cli2api`；新增 `x-cli.jsonArg` spec 字段：标注该路由的 CLI JSON 输出 flag，客户端带 `?format=json` 时 runner 追加该 flag、缓冲 stdout、解析为单次 JSON 响应（解析失败 502 附 raw text）。仅对只读状态类路由标注。
- **Rationale**: 解决 spec 评审意见 1（SSE 非结构化输出的程序化消费问题），改动局限在 runner 输出路径，与上游 cli2api 保持可同步。
- **Alternatives considered**: 全路由强制 JSON——长任务（import/embed/reindex）的流式进度价值丢失。

## D11: 进程模型与生命周期

- **Decision**: `apps/server` 启动序：config 校验 → SQL 迁移 → spawn `gbrain serve --http --port $GBRAIN_SERVE_PORT`（回环，崩溃指数退避重启）→ Hono listen → worker loop。容器 `entrypoint.sh` 先执行 `gbrain init --url $DATABASE_URL`（幂等）再 exec server；SIGTERM 转发子进程后退出。
- **Rationale**: serve 子进程端口仅回环监听，MCP 流量只能经网关（鉴权点唯一）；`init --url` 已核实为官方手动 Postgres 接线方式。
- **Alternatives considered**: s6/tini 多进程监督——单子进程场景 Bun 自带监督足够；独立容器跑 serve——镜像拆分违背单镜像决策。

## D12: MCP 工具面与限流

- **Decision**: 上游 client 注册时钉 `--surface`（默认 `starter`，env `MCP_SURFACE` 可调）；MCP 网关对每凭证施加并发上限（env，默认 4），超限 429。
- **Rationale**: starter 集（~20 操作）覆盖"内容管理 + 检索"的 spec 要求且收敛滥用面；`--surface` 为 server 级 ceiling 的 per-client 钉定，已核实 CLI 支持。
- **Alternatives considered**: full 面——审计与攻击面扩大，留 env 开关即可。
