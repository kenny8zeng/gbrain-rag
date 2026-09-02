# 测试方案（Testing Strategy）

**版本**: 1.0 | **日期**: 2026-09-01 | **状态**: 待评审

## 1. 目标与收敛判据

测试体系的目的是**证明缺陷被修复且不再复发**。收敛判据：

1. **缺陷回归台账全部 ✓**（见 §5）——每个历史缺陷有且至少一项回归测试
2. **全量测试绿**（69+ 项，单实例串行）
3. **测试环境零残留**：套件结束后生产/测试栈无测试数据（自清理，非事后手工）
4. **SC 全覆盖**：spec 全部 Success Criteria 有测试归属（§7 映射表）

## 2. 测试金字塔与门禁

| 层 | 内容 | 环境 | 时长 | 门禁 |
|---|---|---|---|---|
| L0 单元 | 纯逻辑、mock CLI/DB（无真实 IO） | 无 | <1s | 每次提交 |
| L1 契约 | 单实例 HTTP 形状/鉴权/错误码 | 测试隔离实例 | ~10s | 推送前 |
| L2 集成 | 全链路（导入/检索/MCP/生命周期） | 测试隔离实例（串行） | ~60s | 推送前 |
| L3 验收/性能 | scale-check（400 样本 P95）、quickstart 场景 | 生产镜像 | 分钟级 | 发布前手动 |

执行规则：
- L1/L2 必须运行在**测试隔离实例**（§3），禁止指向生产/共享实例
- 禁止并行测试实例（共享 Postgres 任务表会产生假失败）；`bun run test` 已串行，文档明示
- 单测失败即停（不跑集成）；集成失败视为未收敛，先查台账对应缺陷

## 3. 环境隔离（根治污染）

**问题**：集成测试曾直接跑在共享 compose 栈上——每次回归残留几十个 kb/keys/jobs，靠事后手工 cleanup 脚本；并行实例互相干扰产生假红假绿。

**方案**：
- `deploy/compose.test.yaml`：独立 project `gbrain-rag-test`；端口 `3100`；postgres 独立 database `gbrain_test`（同 pgvector 容器多库）；`DATA_DIR=/data/rag-test`；独立 volume（ragdata-test/pgdata-test）
- 启动：`docker compose -p gbrain-rag-test -f deploy/compose.test.yaml up -d --build`
- 跑测：`TEST_BASE_URL=http://localhost:3100 ADMIN_TOKEN=<test-token> bun run test`
- 清理：`docker compose -p gbrain-rag-test down -v`（连数据卷一起销毁）
- 套件内自清理：每个集成 suite 用随机前缀命名资源，`afterAll` 经管理面 API 归档+purge 自建 kb（顺带覆盖 D4/D5 路径）

## 4. 缺陷台账（收敛凭证）

| # | 缺陷 | 修复 | 回归测试 | 状态 |
|---|---|---|---|---|
| D1 | worker 饿死（docling 504 阻塞队列） | 1b422b2 | tests/unit/worker.test.ts（并发/重试/回收） | ✓ |
| D2 | 嵌套 slug 删除 404 | 57a6591 | tests/integration/us2（删除→检索无） | ✓ |
| D3 | 列表接口 500（tab 文本解析） | 57a6591 | us4 列表形状/删除计数 | ✓ |
| D4 | 归档态判定失效（archived 键名 → 无 410） | 57a6591 | us4 归档→410 | ✓ |
| D5 | purge FK 阻塞（内部 client source 占位/归档过滤） | af073f5 | us4 purge 409/force | ✓ |
| D6 | multipart schema 运行时 422（z.string vs File） | e19b641 | us2 multipart 用例 | ✓ |
| D7 | multipart slug 时间戳前缀污染 | e19b641 | us2 multipart slug 断言 | ✓ |
| D8 | Error 子类 .name 检查失效（404/409→500） | 003 实施期 | 契约 409/404/410 | ✓ |
| D9 | OpenAPIHono 三态 body 校验误伤合法请求 | 003 实施期 | us2 三态 + 契约 | ✓ |
| D10 | 归档库访问语义（401/410/403 优先级） | 演示观察 | us4 归档检索语义 | ✓ |
| D11 | 归档被只读引用阻塞（应仅写引用阻塞） | 2026-09-01 | us4 D4（只读不阻塞） | ✓ |
| D12 | purge 被租户 key 引用阻塞且无 force 联动 | 2026-09-01 | us4 D5（409/force 吊销） | ✓ |
| D13 | 内部 client 重启累积泄漏（多 client 并存阻塞 purge） | 2026-09-01 | us4 D5 + fallback 单测 | ✓ |

台账新增/修复缺陷时追加行；全 ✓ 才允许宣称收敛。

## 5. 首批补齐（P1 = 台账 ✗ 项）

- **tests/integration/us4-kb-lifecycle.test.ts**（新）：
  1. 建库 → 导入 1 篇 → 归档（DELETE）→ GET 详情 410 → 租户检索 403（未授权优先）/410（授权后归档）
  2. purge → 列表消失 → GET 404 → 内部 client 引用自动迁移（purge 成功即证）
  3. 列表接口：GET documents 返回 pages 数组，删除文档后计数减一
- 用例内自清理：afterAll 归档 purge 自建 kb

## 6. 测试文件结构（目标态）

```text
tests/
├── unit/          # L0：config/cors/credentials/docling/gbrain-cli/pipeline/worker/retrieval-fallback
├── contract/      # L1：api/cors/openapi/openapi-drift/docs-ui
├── integration/   # L2：us1-授权链 / us2+us4-导入检索删除 / us3-MCP隔离 / us4-KB生命周期
└── fixtures/      # sample.md（multipart fixture）
scripts/scale-check.ts   # L3 性能
```

## 7. SC ↔ 测试映射（治理表）

| SC | 归属测试 |
|---|---|
| 001 SC-001~007 | quickstart 对照 + us2/us3/契约（详见各 feature spec） |
| 002 SC-001~004 | tests/unit/cors + tests/contract/cors |
| 003 SC-001~004 | openapi/drift/docs-ui 契约 |
| T049 SC-1~4 | scale-check（P95）+ us3 隔离 + us4 检索 + fallback 单测 |

## 8. 已知剩余缺口（低优先，记录不阻塞）

429 并发限流（MCP/代理）、SSE 事件形态、413 超限、health 形状、审计日志格式、jobs 过滤参数、surface/concurrency 凭证变更。

## 9. 维护规则

- 修 bug → 先加/补回归测试（台账行变 ✓）→ 再修代码
- 新能力 → spec SC 同步更新映射表
- 每次发布前跑：L0+L1+L2 全量 + L3 手动
