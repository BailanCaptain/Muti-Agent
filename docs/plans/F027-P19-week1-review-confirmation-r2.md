---
id: F027-P19-week1-review-r2
title: F027 Phase 2 Week 1 r2 修复确认请求 — 范-r1 反馈 8 条全 close
reviewer: 范德彪
requester: 黄仁勋
created: 2026-05-15
status: open
round: r2（同 P13 r2 模式：全条 Red→Green 修复 + 派 reviewer 二审）
parent: F027-P19-week1-review-request-r1
---

# F027 P19 Week 1 r2 修复确认请求

**Branch / Worktree:** `feat/F027-unified-memory-architecture` @ `.worktrees/F027`
**HEAD:** `97af0c7 fix(F027-P19): r2 范-r1 反馈修复 — 2 P1 + 4 P2 + 2 P3 全 close`
**Parent r1:** `docs/plans/F027-P19-week1-review-request-r1.md`

## r1 → r2 修复清单（8 条全 close）

| # | Severity | r1 Finding | r2 修复 | 修复位 | 测试 |
|---|---|---|---|---|---|
| **P1-1** | 必须改 | `scheduler-config.ts:145` Iron Laws 3 fail-safe 没真锁；loader 看到 root `wiki.config.yaml` 直接读真文件 | 加 `gate2Approved` 开关默认 false；root 路径 + gate=false → throw `Iron Laws 3 violation`；configPath 注入路径不受 gate 约束（测试 / 开发 inline） | `scheduler-config.ts:117-141` (LoadSchedulerConfigOptions + loadSchedulerConfig) | `scheduler-config.test.ts` 3 个新 case：gate=false throw / gate=true 正常 / configPath skip gate |
| **P1-2** | 必须改 | DEFAULT 7 个 vs feature.md AC-P2-1 锁定 9 个 | 加 `ScheduledJobKind = 'cron' \| 'startup' \| 'watcher'`；DEFAULT 补 `startup-reconciler` (kind=startup) + `docs-watcher` (kind=watcher) 达 9；`validateJobCron` non-cron 跳过 croner 校验 | `scheduler-config.ts:36-43` (kind type) + `:69-167` (DEFAULT 9 entries) + `:240-248` (validate skip) | `scheduler-config.test.ts` 3 个新 case：9 jobs 锁定 + kind 分布 7/1/1 + YAML kind 校验 |
| **P2-1** | 应该改 | `windowMinutes` 30/60 违反 plan §4 `min(cron_period, 5min)` | DEFAULT 全 cron kind windowMinutes=5；non-cron=0；长任务运行长度由 timeoutSeconds 表达 | `scheduler-config.ts:88, 96, 104, ...` (全 cron entries) | `scheduler-config.test.ts` "范-r1 P2-1: cron windowMinutes=5 / non-cron=0" |
| **P2-2** | 应该改 | guard throw 走 `'guard_error'` reason 不在 v2b F2 锁定 4 种 enum 内 | 拆出独立 `onGuardError(jobName, error)` 回调；guard throw 不再走 `onSkip`（防 reason enum 污染）；行为：log + onGuardError + skip 本次（fail-safe） | `nightly-job-scheduler.ts:51-55` (option) + `:88-91` (field) + `:115-130` (handler 改) | `nightly-job-scheduler.test.ts` "范-r1 P2-2: guard threw → onGuardError fires + 不走 onSkip" |
| **P2-3** | 应该改 ★ | handler 没接 `scheduledFor` 参数 — 集成后 RoomCompilerTick missed_window 检查会失真 | `JobSpec.handler` 改 `(ctx: JobContext) => void`；ctx 含 `scheduledFor / windowStart / windowEnd`；scheduler 用 croner `self.currentRun()` 取触发时刻；`JobSpec.windowMinutes` 默认 5 | `nightly-job-scheduler.ts:11-31` (JobContext + JobSpec) + `:148-152` (cron callback ctx 构造) | `nightly-job-scheduler.test.ts` 2 个新 case：handler 接 ctx + windowMinutes 默认 5 |
| **P2-4** | 应该改 | `assertNoConfigFile` 只查 root basename | 文档化 root-only 合同（P19.3b 真文件就在 worktree 根；recursive 扫描会被 node_modules 拖累 + 误报多） | `scheduler-config.ts:179-194` (函数 doc 注释扩) | （已有 pre/post 双断言测试覆盖；语义文档化不需新测） |
| **P3-1** | 可讨论 | RoomCompilerTick `leaderTerm` 静态值 — long-lived tick 在 reacquire 后 trace 写旧 term | `leaderTerm?: string \| null \| (() => string \| null)`；内部统一存 `leaderTermFn`（静态值包成常量 getter）；trace 写入实时调 | `room-compiler-tick.ts:60-68` (option doc) + `:77-78` (field) + `:91-100` (constructor) + `:240` (trace 取值) | `room-compiler-tick.test.ts` "范-r1 P3-1: leaderTerm getter 反映 reacquire 后新 term"（3 次 tick term 1→2→null） |
| **P3-2** | 可讨论 | reason enum 测试 `>= 4` 应 exactly 4 | `assert.equal(JOB_TRACE_REASON_VALUES.length, 4)` + `deepEqual` sorted | `job-trace.test.ts:80-86` | （改的就是测试本身） |

## Test Result（Red→Green）

```
pnpm --filter @multi-agent/api typecheck → exit 0 ✅
npx tsx --test packages/api/src/services/scheduler/*.test.ts → 66/66 pass ✅
pnpm test:api → 2257 tests / 2248 pass / 8 skip / 1 todo / 0 fail ✅
  baseline (Day 5) 2247 → +10 new r2 tests / 0 regression
```

## 范-r1 仍未处理的 (Known Risks)

r1 §"Known Risks" 6 个，#3-#5 已通过 P1-1 / P1-2 / P2-1 顺势 close（你的判定 = 我的修复路径）。剩 3 条：
- **#1 manual_release reason** — 你 r1 判 "接受" 现状。代码未改。`scheduler-leader.ts:114, 136`
- **#2 leaderTerm static vs getter** — 已 P3-1 改。**close**
- **#6 集成层缺位** — 你 r1 判 "Week 1 可以不完整 wire runtime, 但合同需要留够"。本轮 P2-3 把 handler ctx 合同补上了；scheduler-runtime 集成 wiring 仍推 Week 4 整合。**问**：合同够了你这条算 close 了吗，还是仍想 Week 1 内补一个集成测试 fixture？

## r2 Verdict 期望

按 P13 r1→r3 chain 模式，r2 应给 **GO（实质）** / **CONDITIONAL（仍有 followup）** / **NO-GO（核心未 close）**。

如果 r2 仍 CONDITIONAL，请列具体 finding（同 r1 P1/P2/P3 分级 + 文件:行号）我继续 r3。

## 给范的入口指令

```
cd C:\Users\-\Desktop\Multi-Agent\.worktrees\F027

# 看修复 commit
git show --stat 97af0c7

# 看本 confirmation 请求（你正在读）
cat docs/plans/F027-P19-week1-review-confirmation-r2.md

# 复跑测试（如 sandbox 没拦）
pnpm exec tsx --test packages/api/src/services/scheduler/*.test.ts  # 66/66 应过
pnpm test:api 2>&1 | tail -10

# 重点核 4 个文件的 r2 修复点
# 1. scheduler-config.ts: gate2Approved 开关 + 9 jobs + kind 字段
# 2. nightly-job-scheduler.ts: onGuardError 拆出 + handler 接 JobContext
# 3. room-compiler-tick.ts: leaderTerm getter
# 4. job-trace.test.ts: reason enum exactly 4
```

逐项过 8 条修复 + 给 r2 verdict（GO/CONDITIONAL/NO-GO）。
