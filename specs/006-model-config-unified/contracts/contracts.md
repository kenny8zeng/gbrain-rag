# Contracts: 006 端点三要素模型配置

## 1. 环境变量契约（用户唯一配置入口）

```env
# 每能力三行；端点 = OpenAI 兼容服务地址；模型 = 纯名；key = 端点钥匙
CHAT_BASE_URL=https://api.deepseek.com/v1
CHAT_MODEL=deepseek-v4-flash
CHAT_API_KEY=sk-...

EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_MODEL=qwen3.7-text-embedding
EMBEDDING_API_KEY=sk-...
# EMBEDDING_DIMENSIONS=1024     # 可选：缺省 = 服务探测端点默认输出

RERANK_BASE_URL=https://dashscope.aliyuncs.com/compatible-api/v1
RERANK_MODEL=qwen3-rerank
RERANK_API_KEY=sk-...
```

约束：
- 模型名禁止含 `:`（前缀标记已废除）；schema 校验拒绝并提示
- 端点未启用能力 = 三行全空；能力半配置（缺行）= 未配置 + 缺口清单
- 无任何其他模型相关变量（PROVIDER/GBRAIN_*/LLAMA_SERVER_*/供应商 key 名——全部废除/内部化）

## 2. 探测协议（服务内部，配置/启动时执行）

| 能力 | 请求 | 判定 |
|---|---|---|
| chat | `GET {base}/models`（可选 `POST /chat/completions` 最小体） | 200 + 模型在列（列不存在时用真实 4xx 报错）；401/403 → key 无效 |
| embedding | `POST {base}/embeddings` `{model, input:"ping"}` | 200 → 取向量长度 = 默认维度；4xx → 型号无效/不支持 |
| rerank | 试 `POST {base}/rerank` → 404 再试 `POST {base}/reranks`（体 `{model, query, documents:["a"]}`） | 200 即识别路径形态；全 4xx → 端点不支持 rerank |

- 每探测超时 10s；结果缓存（进程内存 + 可选持久化），配置变更失效
- 探测失败分类错误码：`ENDPOINT_UNREACHABLE` / `KEY_REJECTED` / `MODEL_NOT_FOUND` / `CAPABILITY_UNSUPPORTED`

## 3. `/v1/admin/models` API（v2）

`GET /v1/admin/models`
```json
{
  "capabilities": {
    "chat":      { "state": "ready", "endpoint": "…", "model": "…" },
    "embedding": { "state": "gap", "missing": ["CHAT_API_KEY"] },
    "rerank":    { "state": "probe_failed", "reason": "MODEL_NOT_FOUND", "detail": "…" }
  },
  "probe": { "embedding_dim": 1024, "rerank_path": "reranks" }
}
```

`POST /v1/admin/models`（body 同 env 三要素，`apply:false` 仅预检）
- 200：探测报告 + 装配动作（config set 清单）+ env 缺口（无）
- 422：探测失败（错误码 + 人话 + 可选项）
- 装配 = 引擎 config set 幂等执行（自愈同路径）；env 类派生已由 entrypoint 完成——API 场景不再要求 env 派生

## 4. 删除契约（干净清除）

| 废除项 | 处理 |
|---|---|
| `*_PROVIDER` 五变量 | schema 删除（拒绝识别） |
| `GBRAIN_CHAT_MODEL` 等引擎变量入口 | 保留引擎侧读取（内部），配置契约删除；文档删除 |
| `DEEPSEEK_API_KEY`/`OPENAI_API_KEY`/`DASHSCOPE_API_KEY`（供应商 key 入口） | 删除；key 一律经 `*_API_KEY`（内部按槽复制） |
| entrypoint bash 映射 | 删除（TS 派生唯一） |
| model-profiles 白名单 | 删除（探测替代） |
