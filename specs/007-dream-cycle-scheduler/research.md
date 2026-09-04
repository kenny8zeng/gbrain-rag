# Research: dream 命令面与调度实证（007）

**来源**：容器内 gbrain v0.47.6.0 命令面实证（2026-09-04）。无 NEEDS CLARIFICATION。

## 1. `gbrain dream` 命令

- 8 阶段：`lint → backlinks → sync → synthesize → extract → patterns → embed → orphans`
- cron-friendly：跑完即退；`--dry-run`（注意 triage 仍耗 LLM）、`--json`（CycleReport agent 可读）、`--phase <name>`（单跑指定阶段，可重复）
- synthesize（阶段 4）耗 LLM：两段式——廉价打分 triage（模型 `models.dream.triage`，阈值 `dream.triage.threshold` 默认 0.5）门控昂贵子代理合成（`dream.synthesize.max_turns` 默认 16）
- **Decision**: 成本档映射——`light` = `dream --phase extract`（关系/时间线提取，无 synthesize）；`full` = `dream`（全阶段含 LLM synthesize）。`--json` 捕获 CycleReport 供状态/日志。
- **Alternatives**: 直接 `extract links`（更细但非周期全貌）；`--phase` 逐阶段编排（过度）。`--phase extract` 即轻量全周期中的建图部分，符合 spec"轻量=关系提取"。

## 2. extract 阶段细节

- `extract links --by-mention --source db`：页面相互提及 → 图边（`link_source='mentions'`）——本地 reconcile，无 LLM
- `--ner`：命名实体识别（需模型）；`extract timeline [--infer-dates]`
- 当前库图空（link-sources=[] 实证）——light 档首次运行将建 mentions 边（SC-002 0→>0 达成）

## 3. 无现成调度/API（实证）

- dream/cycle 配置键未设置；serve 无内建周期调度；容器无 cron 调 dream；服务无 dream 相关 API/路由
- **Decision**: 服务内定时器（supervisor 生命周期）触发 runGbrain；`POST /v1/admin/dream`（手工）+ `GET`（状态）走 OpenAPI 管理面

## 4. 并发与锁设计

- 引擎 dream 无内置锁（cron 语义：外部保证不叠跑）
- **Decision**: 单实例进程内锁：`{ running: bool, startedAt, lastRun: {...}, nextDue }`；运行中触发（定时到点/手工）→ 拒绝；超时上限 `DREAM_TIMEOUT_MS`（默认 4h，超时强杀并解锁防永久挂起）；重启清锁（孤儿自愈——SC-005）
- **Alternatives**: DB 锁（多副本——v1 外）；文件锁（重启残留需清理逻辑——进程内存更简）

## 5. 定时语义

- **Decision**: `DREAM_INTERVAL_HOURS`（默认 24）——supervisor 启动时记 nextDue = start + interval；到点 `maybeStart()`（running 则跳过本轮，下轮顺延 interval）
- **Alternatives**: cron 表达式（需解析器依赖——超范围）；固定时刻（每日 HH:MM——可后续加，v1 间隔制）
