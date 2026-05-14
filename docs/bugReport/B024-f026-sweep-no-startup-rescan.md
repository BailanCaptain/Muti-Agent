---
id: B024
title: F026 a2a_calls sweep 无启动回扫 + pending 不扫 deadline_at — 过期 call 留在表里成僵尸
status: open
related: F026, F027-P12
created: 2026-05-13
---

# B024 — F026 a2a_calls sweep 启动回扫缺失 + pending 分支不扫 deadline_at

**Created**: 2026-05-13
**Author**: 黄仁勋（Claude）
**触发**: F027 P12 viewfinder anti-drift 实施前，跑 R-201 真实数据测 viewfinder §4 渲染时发现「等谁 / blocker」段会显示 5 天前 deadline 已过的 a2a_calls 当真 blocker。

---

## 1. 报告人 + 触发上下文

F027 P12 准备实施 viewfinder 6 段 renderer，§4「等谁 / blocker」按 V16.5 chap 11 行 1300-1322 设计走 `SELECT ... FROM a2a_calls WHERE status IN ('pending','working')`。跑 R-201 主仓真数据时发现 5/8 创建的 5 条 pending call 5 天后还在表里。

**实证 SQL**（主仓 `data/multi-agent.sqlite`）：

```sql
SELECT call_id, issuer_id, status, deadline_at, created_at
FROM a2a_calls
WHERE status IN ('pending','working')
ORDER BY created_at DESC LIMIT 5;
```

输出：

```
call-eb18b35a-...  user  pending  2026-05-08T09:11:19Z  2026-05-08T08:41:19Z
call-6c64ec30-...  user  pending  2026-05-08T09:05:56Z  2026-05-08T08:35:56Z
call-e511f71e-...  user  pending  2026-05-08T08:57:21Z  2026-05-08T08:27:21Z
call-303483bb-...  user  pending  2026-05-08T08:56:37Z  2026-05-08T08:26:37Z
call-0692c6a0-...  user  pending  2026-05-08T08:56:17Z  2026-05-08T08:26:17Z
```

5 条 call 的 deadline_at 都是 5/8 8-9 点，**今天 5/13 还显示 pending**。

---

## 2. Bug 现象

### 直接症状
- F026 a2a_calls 表残留过期 pending call，`status` 永远不会被更新到 `timeout`/`failed`。
- F027 viewfinder §4「等谁 / blocker」会把这些过期 call 当真 blocker 渲染，用户看到「5 天前在等 user」假信号。

### 受影响场景
- viewfinder 渲染（F027 P12）
- /debug/a2a 调试视图（F026 P5 落地的）
- 任何依赖 `a2a_calls.status` 实时性的下游消费方

---

## 3. 根因（实证）

### 根因 A：F026 timeoutScan 是 in-memory setInterval，无启动回扫

**真相源**：`packages/api/src/server.ts:155-175`

```typescript
const a2aTimeoutScanTimer = setInterval(() => {
  try {
    callRegistry.timeoutScan({ stalePendingMs: A2A_PENDING_STALE_MS })
  } catch (err) {
    app.log.warn({ err }, "F026 P1+P4 timeoutScan failed (non-fatal)")
  }
}, A2A_TIMEOUT_SCAN_INTERVAL_MS)
a2aTimeoutScanTimer.unref?.()
```

`setInterval` 进程内 timer，**服务重启后历史 pending call 不会被回扫**。如果服务在某条 call 的 deadline 之前关掉、deadline 之后才重启，那条 call 永远卡 pending。

### 根因 B：pending 分支只扫 created_at，不扫 deadline_at

**真相源**：`packages/api/src/orchestrator/call-registry.ts:265-320`

```typescript
timeoutScan(opts: { stalePendingMs?: number } = {}): number {
  // ... working 分支按 deadline_at 扫 ...
  if (opts.stalePendingMs && opts.stalePendingMs > 0) {
    // pending 分支：按 created_at + worklist 状态扫
    // 但不会扫 deadline_at
  }
}
```

- working 状态：按 `deadline_at < now()` 扫到就 mark timeout
- **pending 状态：只在 `stalePendingMs > 0` 时按 `created_at + stalePendingMs < now()` 扫**，不看 deadline_at

意味着：pending call 如果 `created_at + stalePendingMs > now() < deadline_at`，永远不会被扫。

---

## 4. 复现步骤

1. 启动服务 → 创建一条 a2a_call（status=pending, deadline_at = now+30min）
2. 30min 内关掉服务
3. 等 deadline_at 过去（now > deadline_at）
4. 重启服务
5. 查 `SELECT status FROM a2a_calls WHERE call_id=?` → 仍然是 `pending`，未被扫到

---

## 5. 修法建议（不在本 bug 实施 — 留待 F026 后续 release 修）

### 修 1：startup 回扫
`server.ts` 启动 hook 跑一次 `timeoutScan({ stalePendingMs: 0, includeAllExpired: true })`，把历史所有过期 call 一次性扫掉。

### 修 2：pending 分支扫 deadline_at
`call-registry.ts:timeoutScan` 加 pending 路径：

```sql
UPDATE a2a_calls SET status='timeout', updated_at=now()
WHERE status='pending' AND deadline_at < now();
```

### 修 3：考虑 cron 持久化
长期方案：把 setInterval 换成持久化 cron（NightlyJobScheduler / F027 P19 章节即将做），重启不丢调度状态。

---

## 6. F027 P12 兜底（本 feature 内做）

不等 F026 修，F027 viewfinder §4 SQL 加防御性过滤：

```sql
WHERE session_group_id = ? 
  AND status IN ('pending', 'working')
  AND deadline_at > datetime('now', '-24 hours')
```

只显示 24h 内的 pending/working call，过期太久的 call 不当 blocker 显示。即便 F026 后续修了 sweep，这层兜底防未来 regress。

兜底实现：`packages/api/src/wiki/viewfinder/viewfinder-renderer.ts` §4 段 SQL。

---

## 7. 严重程度

- **直接严重程度**：低（F026 本身的 a2a 派发流程不受影响，只影响下游 viewfinder / 调试 UI 观察）
- **F027 阻塞性**：中（不修则 P12 viewfinder §4 输出不可信，但有 F027 兜底 SQL 可独立 unblock）
- **优先级**：P3（不阻塞 F027 Phase 1，F026 后续 release 修即可）

---

## 8. 验收

修完后：
- 启动一次服务 → 跑一次 startup timeoutScan → 历史所有过期 pending call 全部 mark timeout
- `SELECT COUNT(*) FROM a2a_calls WHERE status='pending' AND deadline_at < now()` → 0
- 新创建的 pending call deadline 过后被周期 scan 扫到（即便 stalePendingMs 没配也扫）
