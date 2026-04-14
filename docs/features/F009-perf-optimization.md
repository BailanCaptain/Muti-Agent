---
id: F009
title: 全链路性能优化 — SQLite 治理 + 增量快照 + 前端减压
status: completed
owner: 黄仁勋
created: 2026-04-14
---

# F009 — 全链路性能优化

**Created**: 2026-04-14

## Why

系统在多 agent 并发场景下体感卡顿严重（估计 P90 快照延迟 300-500ms）。经三方独立审计和讨论（见 `docs/discussions/2026-04-14-perf-storage-strategy.md`），确认卡顿链路覆盖后端查询、快照构建、WebSocket 推送、前端渲染四个层面。核心方案：保留 SQLite，优化查询模式 + 增量协议 + 前端减压。

### 讨论来源

- 讨论纪要：`docs/discussions/2026-04-14-perf-storage-strategy.md`
- ADR：`docs/discussions/ADR-001-reject-redis-as-primary-store.md`
- Lessons：`docs/lessons/lessons-learned.md` LL-016

## 数据安全约束（铁律）

**小孙明确要求：整个优化过程中不能删除或改变原始数据。**
- 所有 schema 变更只做"加法"（加索引、加列、加表）
- 不删表、不删列、不清数据、不改存储引擎导致数据丢失
- Migration 前必须确认不影响现有数据

## Acceptance Criteria

### Phase 0：观测 + 基准线（半天）
- [x] AC-01: 在 `emitThreadSnapshot`、`getActiveGroup`、`listMessages` 加耗时埋点
- [x] AC-02: 跑 3 agent 并发场景，记录各段 P90 耗时作为基准线
- [x] AC-03: 定义目标：端到端快照延迟 < 200ms

### Phase 1：低风险高收益（1-2 天）
- [x] AC-04: 给 messages(thread_id)、threads(session_group_id)、agent_events(invocation_id, thread_id)、session_memories(session_group_id)、tasks(session_group_id)、authorization_rules(provider, thread_id) 加索引
- [x] AC-05: SQLite PRAGMA 补全：busy_timeout=5000、synchronous=NORMAL、cache_size=-64000、journal_size_limit=67108864
- [x] AC-06: `listSessionGroups` N+1 治理 — 改为 JOIN 查询或 batch 查询
- [ ] AC-07: `agent_events` 降采样/批量写入
- [x] AC-08: Phase 1 完成后复测，记录改善百分比

### Phase 2：架构级（2-3 天）
- [x] AC-09: `emitThreadSnapshot` 改为 Tail Tracking 增量协议（只推新增消息 + 状态字段）
- [x] AC-10: 前端 `mergeTimeline` 改为增量更新，跳过不必要的 sort
- [x] AC-11: 前端渲染节流（60fps 截断）
- [x] AC-12: 用户发消息链路加 Optimistic UI + `client_message_id` 对账
- [x] AC-13: `status-panel` 事件滑窗（只保留最近 5 条）
- [x] AC-14: Phase 2 完成后复测，记录累计改善百分比

### Phase 3：待复测后决定
- [ ] AC-15: 骨架缓存（LocalStorage/IndexedDB 界面秒开）
- [ ] AC-16: Redis 缓存层（如仍有存储瓶颈）

## 基准线数据（Phase 0 — 2026-04-14）

3 agent 并发场景，22 个 session groups，采样 20-95 次。

| 指标 | P50 | P90 | P99 | max |
|------|-----|-----|-----|-----|
| **emitThreadSnapshot** | 2998.9ms | 3061.4ms | 3061.4ms | 3061.4ms |
| emitThreadSnapshot.flush | 0.3ms | 0.4ms | 0.4ms | 0.4ms |
| emitThreadSnapshot.getActiveGroup | 2998.3ms | 3060.9ms | 3060.9ms | 3060.9ms |
| **getActiveGroup** | 2926.5ms | 3439.5ms | 3756.2ms | 3756.2ms |
| getActiveGroup.listGroups | 2907.0ms | 3414.2ms | 3730.0ms | 3730.0ms |
| getActiveGroup.threads | 0.4ms | 0.7ms | 0.7ms | 0.7ms |
| getActiveGroup.providers | 0.0ms | 0.1ms | 0.2ms | 0.2ms |
| getActiveGroup.timeline | 19.2ms | 26.6ms | 32.5ms | 32.5ms |
| **listSessionGroups** | 2834.2ms | 3059.2ms | 3729.9ms | 3729.9ms |
| listSessionGroups.query | 0.3ms | 0.6ms | 1.2ms | 1.2ms |
| listSessionGroups.enrich (N+1) | 2833.8ms | 3058.9ms | 3729.6ms | 3729.6ms |
| **listMessages** | 6.1ms | 8.0ms | 9.2ms | 9.2ms |

**根因**: `listSessionGroups.enrich` 占 99.99% 时间 — 每个 group 循环调 `listThreadsByGroup` + `getLastMessagePreview`（22 groups × 3 threads = 89 次查询）。`getActiveGroup` 调 `listSessionGroups` 加载全部 22 个 group 只为 `.find()` 一个。

**目标**: 端到端快照延迟 P90 < 200ms

## 复测数据（Phase 1+2 — 2026-04-14）

Phase 1（索引+PRAGMA+N+1 治理+getActiveGroup 重构）+ Phase 2（增量快照+rAF 节流+Optimistic UI+滑窗）全部落地后采集。

| 指标 | Before P50 | After P50 | 提升倍数 |
|------|-----------|----------|---------|
| **emitThreadSnapshot** | 2998.9ms | 1.3ms (FULL) / 1.3ms (DELTA) | **2307x** |
| **getActiveGroup** | 2926.5ms | 1.0ms | **2926x** |
| getActiveGroup.group+threads | — | 0.1ms | 新分段 |
| getActiveGroup.messages | — | 0.6ms | 新分段 |
| getActiveGroup.providers | — | 0.0ms | 新分段 |
| getActiveGroup.timeline | 19.2ms | 0.2ms | **96x** |
| **listSessionGroups** | 2834.2ms | 9.2ms | **308x** |
| listSessionGroups.query | 0.3ms | 8.7ms | JOIN 查询（含 enrich） |
| listSessionGroups.assemble | — | 0.8ms | JS 内存分组 |
| **listMessages** | 6.1ms | 0.1ms | **61x** |
| emitThreadSnapshot.delta | — | 1.3ms | 增量模式新增 |

**结论**: 端到端快照延迟 P90 = 1.7ms（getActiveGroup P90），**远超 200ms 目标**。Delta 模式 7 次增量推送全在 1.4ms 以内。Phase 3（骨架缓存/Redis）当前无需启动。

## 验证命令

```bash
# Phase 0: 观测基准
npm run dev  # 启动系统
# 3 agent 并发交互 5 分钟，收集 console.time 输出

# Phase 1/2: 回归
npm run typecheck
npm run test
```

## 技术方案概要

### 后端
1. **索引治理**：所有高频 WHERE/ORDER BY 列加 CREATE INDEX IF NOT EXISTS
2. **PRAGMA 补全**：busy_timeout、synchronous、cache_size、journal_size_limit
3. **N+1 消灭**：listSessionGroups 改 JOIN，memory-service 批量查询
4. **增量协议**：Tail Tracking — 后端维护 lastSentMessageId，只推增量
5. **事件降噪**：agent_events 批量写入 + 广播限流

### 前端
6. **增量 merge**：mergeTimeline 检测已排序状态，跳过不必要的 sort
7. **渲染节流**：requestAnimationFrame 级别的更新合并
8. **Optimistic UI**：用户消息即时展示 + client_message_id 对账
9. **状态滑窗**：status-panel 只维护最近 5 条事件

## Timeline

| 日期 | 事件 | 说明 |
|------|------|------|
| 2026-04-14 | Phase 0 基线采集 | emitThreadSnapshot P50=2999ms |
| 2026-04-14 | Phase 1 核心优化 | 索引+PRAGMA+N+1 JOIN+getActiveGroup 重构 |
| 2026-04-14 | Phase 2 增量协议 | FULL/DELTA 快照+rAF 节流+Optimistic UI+滑窗 |
| 2026-04-14 | Review 修复 | delta 排序+preview 清空+7 个测试 |
| 2026-04-14 | Squash merge to dev | `96956ec` — 10 commits → 1 squash commit |
