---
id: F027-P19-week4-review-r2
title: F027 Phase 2 Week 4 r2 修复确认请求 — 范-r1 6 条 finding 全 close
reviewer: 范德彪
requester: 黄仁勋
created: 2026-05-18
status: open
round: r2（同 Week 1/2/3 r2 模式：全条 Red→Green 修复 + 派 reviewer 二审）
parent: F027-P19-week4-review-request-r1
---

# F027 P19 Week 4 r2 修复确认请求

**Branch / Worktree:** `feat/F027-unified-memory-architecture` @ `.worktrees/F027`
**HEAD:** `00ab415` Week 4 r2 fix commit
**Parent r1:** `docs/plans/F027-P19-week4-review-request-r1.md`（你 r1 NO-GO）

## r1 → r2 修复清单（2 P1 + 2 P2 + 2 P3 全 close）

| # | Severity | r1 Finding（你的原话精简） | r2 修复 | 修复位 |
|---|---|---|---|---|
| **P1-1** | blocking | `scheduler-runtime.ts:303-311` 无条件 start event-driven jobs，follower runtime 也跑 → 双 runtime 重复 watcher ingest / alert | SchedulerRuntime 改为**自己构造并持有** SchedulerLeader，装 `onDemote`/`onAcquireAsFollower` hook。`start()` 时只 leader 起 event-driven jobs；follower→leader 提升 → 起；demote → 停。`startEventDrivenJobs`/`stopEventDrivenJobs` 幂等。 | `scheduler-runtime.ts` constructor `:159-178` + `start()` `:200-206` + `onLeaderTakeover` `:323-343` + `onLeaderDemote` `:350-371` |
| **P1-2** | blocking | `scheduler-runtime.ts:414-428` timeout 用 race，不取消 job → ghost job 后台跑，下一轮可能并发 | (a) per-job **reentrancy guard** `runningJobs: Set`：真 job promise（与 wrapper 解耦）未 settle 时下一轮触发落 `skipped_reentry` 跳过 → 绝不并发同名 job；ghost 期间仍占标记。(b) timeout 时 `controller.abort()` → `run(ctx, signal)` 传 AbortSignal，合作型 job 可早退。 | `scheduler-runtime.ts` `runCronJob` `:213-281`（reentry guard + abort）+ `run` 签名加 `signal` `:68-72` |
| **P2-1** | 应该改 | leader 自身 `lease_lost`/`recovered_from_crash` trace 不在 SchedulerRuntime（runtime 收已构造 leader，没装 hook） | P1-1 改 runtime 自己构造 leader 后顺势接管：`onLeaderTakeover` 落 `recovered_from_crash` trace、`onLeaderDemote` 落 `lease_lost` trace（jobName=`scheduler-leader`，含 leaderTerm）。 | `scheduler-runtime.ts:323-371` |
| **P2-2** | 应该改 | `archive-yearly-sessions.ts:99-121` `writeYearlyPack` 失败后仍 mv 源文件 → partial year（源已移走但无 pack 索引） | pack 写失败 → 该 year 全 session **不 mv**，落 `failed`（error 标 `yearly pack write failed`）。`continue` 跳过本年归档循环。 | `archive-yearly-sessions.ts:106-130` |
| **P3-1** | hypothesis | `chained-alert-notifier.ts:77-101` dedup check 在 `await pushAlert` 前、mark 在后 → 并发同 draftPath notify 双 push | 加 `inFlight: Set<string>`：同 draftPath push 进行中（await 未回）→ 并发 notify 视作 `deduped`。`add` 在 push 前、`delete` 在 `finally`。 | `chained-alert-notifier.ts:67-69`（field）+ `:93-117`（notify） |
| **P3-2** | P3 | `wiki-compiler-debounce.ts:63-95` `stop()` 不清 `pendingAfterRun`，`fire()` 补跑不查 `stopped` → stop 后仍补跑一轮 | `stop()` 清 `pendingAfterRun`；`fire()` 本轮完成后、补跑前检查 `stopped` → stopped 则清 pending 直接 return。 | `wiki-compiler-debounce.ts:70-78`（stop）+ `:100-104`（fire） |

## 关键设计决策

### P1-1/P2-1 SchedulerRuntime 接管 leader（API 变更）
`SchedulerRuntimeOptions` 从 `leader: SchedulerLeader` 改为 `leaderAlias + leaseRepo`（+ 可选 ttl/heartbeat/poll）。runtime 内部构造 leader 才能装生命周期 hook——这是 P1-1（leadership 转换时起停 event-driven）与 P2-1（leader trace）的共同根因。`leaseRepo` 仍 caller 注入，本层不碰 DB。

event-driven jobs 只在 leader 上跑：起来即 leader → `start()` 直接起；起来是 follower → 不起，等 `onAcquireAsFollower`（follower→leader）触发再起。这正是 AC-P2-2(b) crash 接管语义——旧 leader crash，备机 poll 提升后才接手 watcher/notifier。

### P1-2 ghost job 不可强杀 + reentrancy guard 兜底
JS 无法强杀运行中的 promise。两层处理：
1. **reentrancy guard**：真 job promise 与 wrapper 解耦（`jobPromise` 单独 track），timeout 后 wrapper resolve 但 `runningJobs` 标记到真 promise settle 才解除 → ghost 期间下一轮触发被挡，落 `skipped_reentry`。**这保证并发安全**（范 r1 的核心 blocking 点）。
2. **AbortSignal**：timeout → `abort()`，合作型 job（周期检查 `signal.aborted`）可早退；不合作的仍 ghost 到自然结束，但被 (1) 兜住不会并发。

注：非 timeout 的长 job 由 croner `protect:true`（NightlyJobScheduler Week 1 已设）在调度层静默跳过、不进 handler → 无 `skipped_reentry` trace；`skipped_reentry` 只在 timeout-ghost 路径出现。测试 `reentrancy guard — 长 job 全程不并发` 验 `maxActive===1`，`timeout 后 ghost job 仍占 reentry guard` 验 ghost 路径的 `skipped_reentry`。

### P2-2 partial year fail-safe
pack 是 year 的索引；源 session mv 走后若无 pack，归档区那年的 session 无从检索。选 fail-closed：pack 写失败 → 该 year 一个都不 mv，全落 `failed` 待人工。`sessionsArchived` 仍记 toArchive 总数（识别口径），`archivedFiles` 只记真 mv 成功的。

## Test Result（Red→Green）

```
pnpm --filter @multi-agent/api typecheck → exit 0 ✅
biome lint（4 个改动 src）→ 0 warning ✅
npx tsx --test（4 个 affected test 文件）→ 全过：
  scheduler-runtime.test.ts      17 pass（+6 new：P1-1/P1-2×3/P2-1×2）
  archive-yearly-sessions.test.ts 10 pass（+1 new：P2-2）
  chained-alert-notifier.test.ts 11 pass（+1 new：P3-1）
  wiki-compiler-debounce.test.ts 10 pass（+1 new：P3-2）
pnpm test:api → 2419 tests / 2410 pass / 8 skip / 1 todo / 0 fail ✅
  baseline (Week 4 r1) 2401 → +9 new r2 tests / 0 regression
```

## r2 新增测试（锁死修复）

- `范-r2 P1-1: follower runtime → event-driven jobs 不起`
- `范-r2 P1-2: reentrancy guard — 长 job 全程不并发`（maxActive===1）
- `范-r2 P1-2: timeout 后 ghost job 仍占 reentry guard`（ghost 路径 skipped_reentry）
- `范-r2 P1-2: timeout → AbortSignal，合作型 job 收到 abort`
- `范-r2 P2-1: follower→leader 提升 → recovered_from_crash + event-driven 起`
- `范-r2 P2-1: leader demote → lease_lost trace + event-driven 停`
- `范-r2 P2-2: writeYearlyPack 失败 → 该年 session 不归档`
- `范-r2 P3-1: 并发同 draftPath notify → 只推 1 次`
- `范-r2 P3-2: recompile 进行中 stop() → 完成后不补跑`

## r2 Verdict 期望

按 Week 1/2/3 r2 模式，r2 应给 **GO（实质）** / **CONDITIONAL（仍有 followup）** / **NO-GO（核心未 close）**。Week 4 GO 后进 P19.17 evidence pack 收尾。

## 给范的入口指令

```
cd C:\Users\-\Desktop\Multi-Agent\.worktrees\F027
git log --oneline -3
cat docs/plans/F027-P19-week4-review-confirmation-r2.md
pnpm exec tsx --test packages/api/src/services/scheduler/scheduler-runtime.test.ts
pnpm exec tsx --test packages/api/src/services/scheduler/archive-yearly-sessions.test.ts
pnpm exec tsx --test packages/api/src/services/scheduler/chained-alert-notifier.test.ts
pnpm exec tsx --test packages/api/src/services/scheduler/wiki-compiler-debounce.test.ts
pnpm test:api 2>&1 | tail -10
```

逐项过 6 条修复 + 给 r2 verdict（GO/CONDITIONAL/NO-GO）。
