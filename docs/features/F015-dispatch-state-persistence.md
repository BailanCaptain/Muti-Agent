---
id: F015
title: DispatchOrchestrator 状态持久化 — A2A 调度状态写入 DB + 进程重启恢复
status: spec
owner: TBD
created: 2026-04-14
---

# F015 — DispatchOrchestrator 状态持久化

**Created**: 2026-04-14

## Why

`packages/api/src/orchestrator/dispatch.ts` 中有 6 个 Map 保存着所有正在进行的 A2A 协作链路信息：

- `messageRoots` — 每条消息的"根消息"
- `rootHopCounts` — 协作链走了几跳
- `invocationTriggered` — 哪个 invocation 已触发下一步
- `providerBusy` — 哪个 agent 正在忙
- `dispatchQueue` — 等待派发的任务队列
- 其他辅助 Map

**这些全在内存里。** API 进程崩溃或重启（OOM、手动重启、Windows 更新），所有进行中的协作链路信息全部丢失：

- 正在跑的 agent 卡在 "working" 状态永远不恢复
- A2A 链路断裂，agent 该接力时不知道该接
- 已跑完的 agent 可能被重复触发

这是 B009（dead-after-turn-response-lost）和 B011（stall-kill-mid-retry）的根因之一。虽然 B009 已在 runtime 层加了补偿逻辑（`turnCompleted` 检测），但调度层的状态丢失问题并没有根治。

### 讨论来源

- 全面排查讨论综合报告：A2 架构隐忧
- B009、B011 根因分析

## Acceptance Criteria

### Phase 1：状态分类与 schema 设计（半天）
- [ ] AC-01: 分析 dispatch.ts 中 6 个 Map，分类为"必须持久化"vs"可丢弃重建"
  - 必须持久化：`providerBusy`、`dispatchQueue`、`rootHopCounts`
  - 可丢弃重建：`invocationTriggered`（可从 DB 中 invocations 表重建）
- [ ] AC-02: 设计 drizzle schema（`dispatch_state` 表），字段包括：
  - `key` (TEXT PK) — 状态项标识
  - `type` (TEXT) — 状态类型（provider_busy / queue_item / hop_count）
  - `value` (TEXT) — JSON 序列化的状态值
  - `updated_at` (INTEGER) — 最后更新时间戳
- [ ] AC-03: drizzle-kit 生成迁移文件，确认在现有数据库上无损执行

### Phase 2：写入与恢复（1-1.5 天）
- [ ] AC-04: dispatch.ts 中关键状态变更点加入 DB 写入（批量写，不逐条）
- [ ] AC-05: 写入频率控制：状态变更后 debounce 500ms 批量写入，避免高频 IO
- [ ] AC-06: 进程启动时从 DB 恢复调度状态到内存 Map
- [ ] AC-07: 恢复逻辑处理"半完成"边界：
  - `providerBusy` 为 true 但对应 invocation 已完成 → 清除 busy 标记
  - `dispatchQueue` 中有任务但对应 session 已关闭 → 丢弃任务
  - `rootHopCounts` 超过阈值 → 标记为异常，不自动恢复

### Phase 3：容错与清理（半天）
- [ ] AC-08: 状态表加 TTL 清理：超过 24 小时的 dispatch_state 记录自动清除
- [ ] AC-09: 进程正常关闭时（SIGTERM/SIGINT）flush 内存状态到 DB
- [ ] AC-10: 异常关闭后重启，日志输出恢复报告（恢复了几条、丢弃了几条、异常几条）

### 门禁
- [ ] AC-11: `pnpm typecheck && pnpm test` 全绿
- [ ] AC-12: 手动验证：启动 A2A 协作 → kill API 进程 → 重启 → agent 状态正确恢复
- [ ] AC-13: 手动验证：正常运行时 dispatch_state 表有记录，空闲时记录被 TTL 清理

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 持久化粒度 | A: 全部 6 个 Map / B: 只持久化关键 3 个 | B | invocationTriggered 可从 invocations 表重建，减少写入量 |
| 存储方案 | A: 文件 / B: SQLite（drizzle） | B | F011 已引入 drizzle，复用现有基础设施 |
| 写入策略 | A: 每次变更立即写 / B: debounce 批量写 | B | 高频协作场景下避免 IO 瓶颈 |
| 恢复策略 | A: 全量恢复 / B: 带校验的选择性恢复 | B | 半完成状态不能盲目恢复，需要交叉验证 |

## 验证命令

```bash
# 回归
pnpm typecheck && pnpm test

# 手动验证恢复流程
# 1. 启动 dev server，发起 A2A 协作
# 2. 观察 dispatch_state 表有记录（sqlite3 查询）
# 3. kill API 进程
# 4. 重启 API，观察日志中的恢复报告
# 5. 确认 agent 状态正确恢复（不卡死、不重复触发）
```

## Timeline

| 日期 | 事件 | 说明 |
|------|------|------|
| 2026-04-14 | 三方审计 | A2 架构隐忧：调度状态全在内存 |
| 2026-04-14 | F015 立项 | 调度状态持久化，依赖 F011 的 drizzle 基础设施 |

## Links

- F011: 后端加固 + drizzle 迁移（前置依赖）
- B009: dead-after-turn-response-lost（相关 bug）
- B011: stall-kill-mid-retry（相关 bug）

## Evolution

- **Depends on**: F011（drizzle schema 和迁移体系）
- **Resolves**: B009/B011 的调度层根因
- **Parallel**: F017（跨房间协作感知）
