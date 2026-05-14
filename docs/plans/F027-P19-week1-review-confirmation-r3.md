---
id: F027-P19-week1-review-r3
title: F027 Phase 2 Week 1 r3 修复确认请求 — 范-r2 P2-3 scheduledFor 改 planned slot
reviewer: 范德彪
requester: 黄仁勋
created: 2026-05-15
status: open
round: r3（同 P13 r3 模式：单条 P2-3 实质 fix + 派 reviewer 三审）
parent: F027-P19-week1-review-confirmation-r2
---

# F027 P19 Week 1 r3 修复确认请求

**Branch / Worktree:** `feat/F027-unified-memory-architecture` @ `.worktrees/F027`
**HEAD:** `2dd0684 fix(F027-P19): r3 范-r2 反馈修复 — P2-3 scheduledFor 改 planned slot`
**Parent r2 confirmation:** `docs/plans/F027-P19-week1-review-confirmation-r2.md`
**r1 → r2:** 8/8 close
**r2 → r3:** 1/1 close（P2-3）

## r2 → r3 修复（单条 close）

| # | r2 finding（你的原话） | r3 修复 | 修复位 |
|---|---|---|---|
| **P2-3** | `nightly-job-scheduler.ts:157` `self.currentRun()` 在 croner 10.0.1 中是当前/上次 run start time；本地用阻塞 event loop 复核，`currentRun` 与 callback 实际开始时间一致，不是被延迟的 cron 计划时间。`windowEnd = scheduledFor + 5min` 会从延迟后的时间开始算，`missed_window` 基本检测不到调度延迟。修复建议：scheduler wrapper 内维护下次计划槽位，callback 用 planned run time 构造 JobContext + 加延迟触发 fixture 锁住语义；如果做不到就把字段改名为 `triggeredAt`，不要让 RoomCompilerTick 依赖它做 missed-window | **走第一条路（保 `scheduledFor` 语义 + 真返 planned slot）**：抽出 `computePlannedSlot(job, now)` helper，用 `self.previousRuns(1, now+1000ms)` 取 cron 计划槽位（reference 加 1s 因 croner 内部 strips milliseconds + 严格 < reference）；callback 改用 helper 替代 `currentRun()` | `nightly-job-scheduler.ts:11-44` (computePlannedSlot 实现) + `:163-165` (callback 用 helper) |

## 关键设计决策（你 r2 给的两条路 — 我选了第一条）

**A. 保 `scheduledFor` 语义 + 真用 planned slot**（**采用**）
- 优点：JobContext 字段名诚实；RoomCompilerTick missed_window 真能感知 event loop 阻塞
- 实现：`previousRuns(1, now+1000ms)` 取 now 之前最近的 cron 槽位
- 测试：3 个 fixture 锁语义（含"4:00:00 cron + entry 4:00:30 → planned 仍 4:00:00 + delayMs=30s"）
- 限制：本类不支持每秒 cron（生产无意义；测试避免）

**B. 改名 `triggeredAt` + RoomCompilerTick 不依赖做 missed-window**（**未采用**）
- 优点：实现简单
- 缺点：RoomCompilerTick AC-P2-6 文字"missed window 走 skip policy 落 trace"无法实现；Phase 2 整套 trace status='missed_window' 形同虚设

我判：A 是真 fix，B 是回避问题。如果你认为 A 还有别的坑（比如 cron 5min 周期跨过午夜的边界、或 DST 边界 previousRuns 行为），告诉我，再加 fixture。

## Test Result（Red→Green）

```
pnpm --filter @multi-agent/api typecheck → exit 0 ✅
npx tsx --test packages/api/src/services/scheduler/nightly-job-scheduler.test.ts → 17/17 pass ✅
pnpm test:api → 2260 tests / 2251 pass / 8 skip / 1 todo / 0 fail ✅
  baseline (r2) 2257 → +3 new computePlannedSlot tests / 0 regression
```

## 3 个新 fixture 详解

### Fixture 1: cron 计划槽位 vs entry time
```ts
const job = new Cron("0 4 * * *", { timezone: "Asia/Shanghai", paused: true })
const entryTime = new Date("2026-05-14T20:00:30.000Z") // 4:00:30 Asia/Shanghai
const planned = computePlannedSlot(job, entryTime)
// planned 应严格 < entryTime（不是 entry 当下）
// planned 应 = 20:00:00 UTC（cron 槽位）
assert.equal(planned.toISOString(), "2026-05-14T20:00:00.000Z")
```
**意义**：模拟 event loop 阻塞 30s。验证 scheduledFor 仍是 cron pattern 上的精确时刻 4:00:00，不是 entry 4:00:30。

### Fixture 2: entry 正好是 cron 槽位 → planned = entry
```ts
const onSlot = new Date("2026-05-14T20:00:00.000Z")
const planned = computePlannedSlot(job, onSlot)
assert.equal(planned.toISOString(), "2026-05-14T20:00:00.000Z")
```
**意义**：边界 case — entry 就是 slot 当下时，planned = entry 本身（不返前一天的 slot）。验证 reference +1000ms 的设计正确。

### Fixture 3: 5min cron + delay 90s → planned 仍 5min 边界
```ts
const job = new Cron("*/5 * * * *", { timezone: "UTC", paused: true })
const entryTime = new Date("2026-05-15T12:06:30.000Z")
const planned = computePlannedSlot(job, entryTime)
assert.equal(planned.toISOString(), "2026-05-15T12:05:00.000Z")
const delayMs = entryTime.getTime() - planned.getTime()
assert.equal(delayMs, 90_000) // ★ 这就是 missed_window 检测能用的"延迟感知"
```
**意义**：直接演示"missed_window 检测能感知 event loop 阻塞"—— delayMs=90s 就是 RoomCompilerTick 内部判 `now > scheduledFor + windowMinutes` 用的距离。

## 范-r2 仍未处理 (Known Risks)

r2 confirmation §"范-r1 仍未处理"列了 3 条；r2 你只提了 P2-3 一条 finding。本轮 P2-3 close 后，r2 时未提的 3 条状态：

- **#1 manual_release reason** — r1 你判"接受"，r2 r3 无人提及。**视为 close**
- **#2 leaderTerm getter** — r1 P3-1，r2 你确认 close
- **#6 集成层缺位** — r2 你判"CONDITIONAL；本轮把核心合同名 scheduledFor 改对就够，不需要 Week 1 内补集成层"。本轮 P2-3 把 scheduledFor 真做对了。**问**：你 r2 说"补准后再给 GO"——本轮补准了，#6 可以视为 close 吗？

## r3 Verdict 期望

按 P13 r1→r3 chain 同款：r3 应给 **GO** / **CONDITIONAL（仍有微调）** / **NO-GO（核心未 close）**。

## 给范的入口指令

```
cd C:\Users\-\Desktop\Multi-Agent\.worktrees\F027

# 看 r3 修复
git show --stat 2dd0684
git show 2dd0684 -- packages/api/src/services/scheduler/nightly-job-scheduler.ts

# 看本 confirmation 请求（你正在读）
cat docs/plans/F027-P19-week1-review-confirmation-r3.md

# 复跑测试（如 sandbox 没拦）
pnpm exec tsx --test packages/api/src/services/scheduler/nightly-job-scheduler.test.ts  # 17/17 应过
pnpm test:api 2>&1 | tail -10
```

逐项核 P2-3 修复 + 给 r3 verdict（GO/CONDITIONAL/NO-GO）。

如 GO：Week 1 进 merge-gate（per receiving-review skill "Reviewer 放行 → 直接进入 merge-gate"）；待小孙拍是否合 dev（[[feedback_feature_completion_before_merge]] 例外 2，phase 级合 dev 需要 evidence pack 双 judge 双 PASS — 那是 Week 4 P19.17 的事，本轮还不能合）。
