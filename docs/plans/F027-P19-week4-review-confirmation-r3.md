---
id: F027-P19-week4-review-r3
title: F027 Phase 2 Week 4 r3 修复确认请求 — 范-r2 新 P2 + residual 全 close
reviewer: 范德彪
requester: 黄仁勋
created: 2026-05-18
status: open
round: r3（同 Week 1/2 r3 模式：r2 残留 finding Red→Green + 派 reviewer 终审）
parent: F027-P19-week4-review-confirmation-r2
---

# F027 P19 Week 4 r3 修复确认请求

**Branch / Worktree:** `feat/F027-unified-memory-architecture` @ `.worktrees/F027`
**HEAD:** `a4e67ad` Week 4 r3 fix commit
**Parent r2:** `docs/plans/F027-P19-week4-review-confirmation-r2.md`（你 r2 CONDITIONAL — 6 条 r1 finding 全 CLOSED）

## r2 → r3 修复清单

r2 你确认 6 条 r1 finding **全 CLOSED**，verdict CONDITIONAL 因新发现 1 P2 + 1 residual。两条全 close：

| # | Severity | r2 Finding（你的原话精简） | r3 修复 | 修复位 |
|---|---|---|---|---|
| **P2（新）** | 应该改 | leader 生命周期 start/stop hook 未串行：`void this.startEventDrivenJobs()` / `void this.stopEventDrivenJobs()` fire-and-forget，且 `eventDrivenStarted` flag 在 `await reg.start/stop()` 完成前就翻转。快速 demote→reacquire：slow stop 进行中 takeover 起新 jobs → stale stop 末尾跑完把新起的 watcher 拆掉 | 加 `lifecycleChain: Promise<void>` 串行链 + `enqueueLifecycle(op)`：所有 start/stop（含 `start()`/`stop()`/`onLeaderTakeover`/`onLeaderDemote` 4 处）都排进链 → 保证 start 与 stop 绝不交错，最后一个 leadership 转换决定最终态 | `scheduler-runtime.ts:158-159`（field）+ `:385-393`（enqueueLifecycle）+ 4 处调用点 `:213` / `:240` / `:444` / `:471` |
| **residual（新）** | 不 blocking | ChainedAlertNotifier in-flight dedup 未测"主 push 失败 + 并发同 path 被 dedup" → 被 dedup 的那条会丢，直到后续 event 重触发 | 加测试**显式锁定**此行为为有意：in-flight dedup 是 best-effort 防 alert 风暴；主 push 失败时被 dedup 的并发条不内联补发（chained_suspect 是持续条件，后续 event 会重新触发） | `chained-alert-notifier.test.ts` 新 case `范-r2(r3) 已知行为` |

## 关键设计决策

### P2 串行链 — 为什么够
`enqueueLifecycle(op)` 把 op 接到 `lifecycleChain.then(op, op)` 尾部。任意时刻只有一个 start/stop 在跑，下一个必须等当前完整结束（含 `await reg.start/stop()`）。

正确性：链保留 enqueue 顺序 = leadership 转换发生顺序（SchedulerLeader 同步顺序触发 onDemote/onAcquireAsFollower）。所以**最后一个转换 enqueue 的 op 最后跑、决定最终态**——demote 后 reacquire → 链是 [stop, start] → stop 完整跑完（拆 watcher）→ start 完整跑（重起 watcher）→ 最终 jobs 起、role=leader，一致。`eventDrivenStarted` flag 因串行不再有 TOCTOU：start op 跑时上一个 stop op 必已结束（flag 已置 false）。

`start()` / `stop()`（runtime 显式生命周期）也走同一链 + await 链结果 → 测试可见确定态。

### residual — 为什么不补发
被 dedup 的并发条**不内联补发**是有意：
- chained_suspect 由 5 层 sanitize 持续检测，条件不消失就会有后续 event 重新 notify
- 内联补发会让"主失败"放大成重试风暴，与 dedup 防风暴的初衷冲突
- 失败的主条本身已 `skipReason=push_failed`、未记 dedup（窗口外可重推）

测试 `范-r2(r3) 已知行为` 锁死：并发 n1（push 失败）+ n2（被 dedup）→ `pushCalls===1`，n2 不补发。

## Test Result（Red→Green）

```
pnpm --filter @multi-agent/api typecheck → exit 0 ✅
biome lint scheduler-runtime.ts → 0 warning ✅
npx tsx --test：
  scheduler-runtime.test.ts      18 pass（+1：快速 demote→reacquire 串行不交错）
  chained-alert-notifier.test.ts 12 pass（+1：并发 dedup + 主 push 失败行为锁定）
pnpm test:api → 2412 pass / 8 skip / 1 todo / 0 fail ✅
  baseline (Week 4 r2) 2410 → +2 new r3 tests / 0 regression
```

新增测试 `范-r3 P2: 快速 demote→reacquire — event-driven 生命周期串行不交错`：
gate 卡住第一次 slow stop，期间触发 reacquire → 断言 start 未抢跑（`events==["start","stop-begin"]`）→ 放行 → 断言最终 `["start","stop-begin","stop-end","start"]` 全程串行无交错。无修复时 start 会在 `stop-begin` 后立即抢跑（Red）。

## r3 Verdict 期望

按 Week 1/2 r3 模式，r3 应给 **GO**（核心全 close）。Week 4 GO 后进 P19.17 Phase 2 evidence pack 收尾。

## 给范的入口指令

```
cd C:\Users\-\Desktop\Multi-Agent\.worktrees\F027
git log --oneline -3
cat docs/plans/F027-P19-week4-review-confirmation-r3.md
pnpm exec tsx --test packages/api/src/services/scheduler/scheduler-runtime.test.ts
pnpm exec tsx --test packages/api/src/services/scheduler/chained-alert-notifier.test.ts
pnpm test:api 2>&1 | tail -10
```

逐项过 2 条修复 + 给 r3 verdict（GO/CONDITIONAL/NO-GO）。
