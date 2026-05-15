---
id: F027-P19-week4-review-r1
title: F027 Phase 2 Week 4（P19.13~P19.16）r1 review 请求
reviewer: 范德彪
requester: 黄仁勋
created: 2026-05-15
status: open
round: r1（Per Week 节奏；同 Week 1/2/3 r1→r3 chain 模式）
parent: F027-P19-week3-review-confirmation-r2
---

# F027 Phase 2 Week 4 r1 Review Request — Archive / Alert / Debounce / 集成层

**Feature:** F027 — `docs/features/F027-unified-memory-architecture.md`
**Plan:** `docs/plans/F027-phase2-implementation-plan.md`（v2b frozen）
**真相源:** V16.5 chap 2 line 219（派生视图）/ chap 16（yearly archive）/ chap 17 line 829/853/1657/1814（chained_suspect）
**Branch / Worktree:** `feat/F027-unified-memory-architecture` @ `.worktrees/F027`
**HEAD:** `6130eb1` Week 4 Day 21-22 整合 commit
**Parent (Week 3):** `docs/plans/F027-P19-week3-review-confirmation-r2.md`（你 r2 GO）

## What Changed

Week 4（4 个 P 阶段）— 最后 3 个 job（其中 2 个 event-driven）+ scheduler-runtime 集成层。

| Day | Commit | P 阶段 | 文件 | 测试 | AC 覆盖 |
|---|---|---|---|---|---|
| 16 | `3965fe4` | P19.13 | `archive-yearly-sessions.ts/.test.ts` | 9 | AC-P2-15（yearly pack + mv archive + 100k + Jan-1）|
| 17 | `2b5f6ed` | P19.14 | `chained-alert-notifier.ts/.test.ts` | 10 | AC-P2-16（chained_suspect 事件 → R-201 + dedup）|
| 18 | `16be7d0` | P19.15 | `wiki-compiler-debounce.ts/.test.ts` | 9 | AC-P2-17（wiki_events 后 5s debounce 重编派生视图）|
| 21-22 | `6130eb1` | P19.16 | `scheduler-runtime.ts/.test.ts` | 11 | AC-P2-1（11 jobs 接进 scheduler+leader+trace）|

**总规模**：4 src 文件 + 4 test 文件 / +39 new tests。
**Diff**：+约 1700 LOC（含测试）/ 0 删除既有功能。
**0 schema 改 / 0 enum 扩 / 0 wiki.config.yaml 创建**。

至此 **11 jobs 全部落地**（9 scheduled + 2 event-driven），Phase 2 代码本体完成。

## Why

Plan §3 Week 4：
- P19.13~15 是剩余 3 个 job。P19.14/15 是 11 jobs 里仅有的 2 个 **event-driven**（非 cron）—— ChainedAlertNotifier 由 5 层 sanitize 命中触发；WikiCompilerDebounce 由 wiki_events 写触发。
- P19.16 是 **Week 1/2/3 r1→r3 都明确延后的集成层**。Week 3 r1 Review Focus #5 我问过"集成层最迟 Week 4 补，认可吗"，你 r2 GO 即默认认。本轮交付。

V16.5 真相源对齐：
- chap 16 — agent-sessions 往年归档成 yearly pack + mv `wiki/archive/agent-sessions/`
- chap 17:829/853/1657/1814 — chained_suspect 命中实时推 room（默认 R-201）
- chap 2:219 — 派生视图（index.md / sources.md / log.md）程序编，写 wiki_events 后重生成

## Original Requirements

**小孙原话** (2026-05-15)：
> "不要停下来 直接做完 然后一直按照之前的流程走就行了 你发request 然后德彪加载code-review 然后你receive"

无 Open 决策，按 plan v2b 严格落地。

## Self-Check Evidence

**quality-gate**: ✅ PASS (2026-05-15)
- typecheck `pnpm --filter @multi-agent/api typecheck` → exit 0 ✅
- biome lint scheduler-runtime.ts → 0 warning（修过一处 `noConfusingVoidType`）
- 全套 `pnpm test:api` → 2401 pass / 8 skip / 1 todo / 0 fail（+39 new Week 4）
- 4 个 commit 全过 husky pre-commit gate
  - SessionTitler AC-06/07/10/14d 仍 ~50% 概率 flake → retry 模式（已 verify 不是 P19 引入；Week 1/2/3 已 flag）

```
archive-yearly-sessions.test.ts   9 (AC-P2-15)
chained-alert-notifier.test.ts   10 (AC-P2-16)
wiki-compiler-debounce.test.ts    9 (AC-P2-17)
scheduler-runtime.test.ts        11 (AC-P2-1)
```

**回归基线**：Week 3 收官 2364 → Week 4 收官 2401（0 P19 回归）。

**acceptance-guardian**: ⏭️ 跳过（同 Week 1/2/3，scheduler 业务层属测试基础设施类）

## Known Risks（5 个想听你判）

1. **SchedulerRuntime 不门禁 watcher / event-driven job 的 leader** — cron job + startup job 都过 `leader.shouldSkipJob()` 门禁；但 `eventDrivenJobs`（DocsWatcher / ChainedAlertNotifier / WikiCompilerDebounce）我只做 lifecycle start/stop，**不**按 leader 门禁。后果：双 runtime 都跑 DocsWatcher → 同一份 docs 双重 ingest。我的理由：event-driven job 的副作用门禁是各 job 自己的 concern（且 ingest 幂等性由 F027 Phase 1 dedup 兜）。**问**：这个边界划对了吗？还是 SchedulerRuntime 该统一门禁所有 11 个 job？看 `scheduler-runtime.ts:175-181` + 文件头注释「不做」第 2 条。

2. **timeout 的 job 仍在后台跑** — `withTimeout` 用 `Promise.race` 语义：超时 → trace 记 `timeout`，但被超时的 job promise **不会被中断**，继续在后台跑到自然结束。croner `protect:true` 防的是下一次触发重入，不防这个"幽灵任务"。**问**：MonthlySnapshot 30min 长跑若卡 31min，幽灵任务 + 下一轮触发会不会资源叠加？还是可接受（trace 已诚实记 timeout，运维介入）？看 `scheduler-runtime.ts:344-358`。

3. **skipped / guard-error trace 的 scheduledFor 用 `clock()` 近似** — NightlyJobScheduler 的 `onSkip(jobName, reason)` / `onGuardError` 回调**不传 JobContext**，所以这两条路径的 trace 我用 `clock()` 当 scheduledFor（job 根本没进 handler，没有真 planned slot）。cron job 正常跑的路径才有 `computePlannedSlot` 推导的精确槽位。**问**：skip trace 的时间窗近似可接受，还是该改 NightlyJobScheduler 让 onSkip 也带 ctx？后者要动 Week 1 已 review 的代码。看 `scheduler-runtime.ts:283-322`。

4. **leader 自身 demote/acquire 的 trace 不在 SchedulerRuntime 里** — `lease_lost`（status）/ `recovered_from_crash` 两种 trace 由构造 `SchedulerLeader` 的 caller 经 `onDemote` / `onAcquireAsFollower` hook 落，不是 SchedulerRuntime 落（runtime 收到的是已构造好的 leader）。SchedulerRuntime 只落 cron/startup 路径的 trace + guard-skip 的 `skipped_not_leader`。**问**：这个职责切分清晰吗？还是 SchedulerRuntime 该接管 leader 的全部 trace（需要 runtime 来构造 leader）？看 `scheduler-runtime.ts` 文件头「不做」第 1 条。

5. **WikiCompilerDebounce reentrancy 补跑只补 1 次** — recompile 进行中来 N 个 event → `pendingAfterRun` 只是 bool flag → 本轮完后补跑 **1 次**（收敛 N→1）。这是有意收敛（防每 event 全量重编）。但极端场景：补跑那一轮又卡很久，期间又来 event → 再补 1 次 …… 理论上稳定收敛。**问**：bool flag 收敛策略 OK，还是该用 counter / 时间戳让"补跑期间的 event 不丢"更显式？看 `wiki-compiler-debounce.ts:85-104`。

## Review Focus（按 4 个 AC 验证）

### 1. AC-P2-1 SchedulerRuntime 集成层（最高优先级 — 集成层首次交付）— `scheduler-runtime.ts`

- 11 jobs 三分类接入：cron（注册进 NightlyJobScheduler）/ startup（起来跑一次）/ event-driven（lifecycle）
- 每个 cron job 触发 → `job_trace` 落盘，时间窗字段（scheduledFor/windowStart/windowEnd）完整
- guard hook 接 `leader.shouldSkipJob()` → 非 leader 落 `skipped_not_leader` + reason ∈ {role_not_leader/lease_lost/lease_expired}
- per-job timeout 强制（`withTimeout`）→ trace `timeout`
- job throw → trace `failed`；job 自报 `outcome.status` → trace 记之（missed_window 等）
- failed/timeout/recovered_from_crash/lease_lost → 推 R-201（`pushAlert` + `alertedRoom` 字段）
- start/stop idempotent
- 测试 `scheduler-runtime.test.ts` 11 case 全过

### 2. AC-P2-15 ArchiveYearlySessions — `archive-yearly-sessions.ts`

- 往年 session → yearly pack + mv `wiki/archive/agent-sessions/<room>/<alias>/<year>/<base>`
- 当年 active session 不动；`shanghaiYear` 算 currentYear
- Jan-1 边界（mock clock 2026-12-31T19:00 UTC = 2027-01-01 CST）
- archiveSessionFile throw → 落 failed 不打断
- 100k session fixture → 线性时间 < 30s

### 3. AC-P2-16 ChainedAlertNotifier — `chained-alert-notifier.ts`

- chained_suspect 事件 → 构造 alert → pushAlert R-201（默认 room）
- dedup 窗口：同 draftPath 窗口内重复 → 只推 1 次
- push 失败 → 不记 dedup（下次仍可推）
- 纯逻辑，不发 room message（caller 串 room API）

### 4. AC-P2-17 WikiCompilerDebounce — `wiki-compiler-debounce.ts`

- onWikiEvent() 重置 5s debounce；idle → recompile 派生视图
- burst 收敛成 1 次
- reentrancy guard：recompile 进行中来 event → 本轮后补跑（Known Risks #5 要听你判）
- recompile throw → 不打断后续；stop() 清 pending timer

## Out of Scope

- **P19.17 Phase 2 evidence pack**（19/19 AC × 3 件套 + 异构双 judge）— Week 4 下一步，本轮不含
- **真 fs scan / yearly pack 写盘 / room API / 派生视图 recompile**（全 caller 注入）
- **wiki.config.yaml 真文件**（仍阻塞 feature.md Gate 2）
- **leader 的 lease_lost / recovered_from_crash trace**（caller 经 leader hook 落 — Known Risks #4）

## Review 节奏

按 Week 1/2/3 r1→r3 chain 模式：本轮 r1 = Week 4 全 4 commit 一次性提交；r2-rN 视反馈。Week 4 GO 后进 P19.17 evidence pack 收尾。

## 给范德彪的入口指令

```
cd C:\Users\-\Desktop\Multi-Agent\.worktrees\F027

# 看 Week 4 commit chain
git log --oneline -8

# 看本 review request
cat docs/plans/F027-P19-week4-review-request-r1.md

# 跑全套验回归（应 0 P19 fail；SessionTitler flake retry）
pnpm test:api 2>&1 | tail -10

# 单跑 4 个 Week 4 test 文件（应 39/39 全过）
pnpm exec tsx --test packages/api/src/services/scheduler/archive-yearly-sessions.test.ts
pnpm exec tsx --test packages/api/src/services/scheduler/chained-alert-notifier.test.ts
pnpm exec tsx --test packages/api/src/services/scheduler/wiki-compiler-debounce.test.ts
pnpm exec tsx --test packages/api/src/services/scheduler/scheduler-runtime.test.ts
```

逐项过 4 个 Review Focus + 5 个 Known Risks 判定（GO / CONDITIONAL / NO-GO）。
