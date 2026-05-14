---
id: F027-P19-week1-review-r1
title: F027 Phase 2 Week 1（P19.1→P19.6 框架层）r1 review 请求
reviewer: 范德彪
requester: 黄仁勋
created: 2026-05-14
status: open
round: r1（按 Week 节奏批 review，see [[f027_phase2_status]] How to apply）
---

# F027 Phase 2 Week 1 框架层 r1 Review Request

**Feature:** F027 — `docs/features/F027-unified-memory-architecture.md`
**Plan:** `docs/plans/F027-phase2-implementation-plan.md`（v2b frozen，你 confirm 过）
**真相源:** `docs/plans/V16.5-final.md` chap 17 + plan §3-§5
**Branch / Worktree:** `feat/F027-unified-memory-architecture` @ `.worktrees/F027`
**HEAD:** `06e6199 feat(F027-P19.6): RoomCompilerTick with reentrancy + missed window`

## What Changed

Phase 2 Week 1 框架层（5 天 / 6 个 P 阶段 / 7 个 AC）— scheduler runtime 起来 + lease + config + trace 契约 + reconciler + 第一个 tick job 全部落地。所有 11 个真 jobs（Week 2-4）依赖这层。

| Day | Commit | P 阶段 | 文件（src + test） | 测试 | AC 覆盖 |
|---|---|---|---|---|---|
| 1 | `539b5e8` | P19.1 | `nightly-job-scheduler.ts/.test.ts` | 10 | AC-P2-1 部分（lifecycle 起停 + croner） |
| 2 | `d757331` | P19.2 | `scheduler-leader.ts/.test.ts` + scheduler `guard` hook | 13 | AC-P2-2 (a)/(b)/(c)/(d) **v2b F1 三段 guard 全覆盖** |
| 3 | `18efcc7` | P19.3a + P19.4 | `scheduler-config.ts/.test.ts` + `job-trace.ts/.test.ts` | 33 | AC-P2-3a (Iron Laws 3 fallback) + AC-P2-4 (8 status / 4 reason / 时间窗 3 字段) |
| 4 | `65bb2ad` | P19.5 + P19.16 | `startup-reconciler.ts/.test.ts` + `p18-judge.ts` generic 化 | 18 | AC-P2-5 (crash injection 清理) + plan §0 D6 (judge 复用) |
| 5 | `06e6199` | P19.6 | `room-compiler-tick.ts/.test.ts` | 11 | AC-P2-6 (5min + reentrancy + missed window + idle 30min) |

**总规模**：6 src 文件 + 6 test 文件 + 1 script (p18-judge.ts) refactor + croner ^10.0.1 dep。
**Diff**：+约 2400 LOC（含测试）/ 0 删除既有功能。
**0 schema 改 / 0 enum 扩 / 0 wiki.config.yaml 创建**（v2a F2 Iron Laws 3 + plan §1 都遵守）。

## Why

Plan §2 DAG：P19.1→P19.6 是后续 11 jobs 的 enabling layer。Week 1 走完，scheduler runtime 自身可起停 + owner election + lease 续 + crash recovery + 单 job (RoomCompilerTick) 端到端跑通。Week 2-4 的每个 job 只需注册到 NightlyJobScheduler + 实现 executor 即可。

## Original Requirements

**小孙原话** (2026-05-14 / 2026-05-15)：
> "P2计划已经review完了 动手吧"
> "go" × N（每天 Day N → Day N+1 推进）
> Review 节奏：Per Week（不每天 / 不一次性）— Week 1 框架层架构风险最高 → 现在 r1。

**v2b 修订点全部落实**（你 v2b confirm GO 后没动 spec，本批严格按 v2b 实现）：
- F1 lease-lost-live：`selfDemote()` 清 lease + 记 `demotedReason` + `runJob` 三段 guard（role / lease 对象 / lease 时间）→ `scheduler-leader.ts` shouldSkipJob() + AC-P2-2(c) 'lease_lost' / (d) 'lease_expired' 双 fixture
- F2 status enum 8 / reason enum 4：`job-trace.ts` `JOB_TRACE_STATUS_VALUES` + `JOB_TRACE_REASON_VALUES` 锁定
- F3 AC-P2-3 拆 a/b：P19.3a `scheduler-config.ts` loader + 默认 schema + DST fixture + Iron Laws 3 fallback；P19.3b 真文件待 Gate 2

## Self-Check Evidence

**quality-gate**: ✅ PASS (2026-05-15)
- typecheck `pnpm --filter @multi-agent/api typecheck` → exit 0 ✅
- 全套 `pnpm test:api` → 2247 tests / 2237 pass / 8 skip / 1 todo / **0 fail or 1 fail (SessionTitler AC-14d 预存 flake)**
- 5 个 commit 全过 husky pre-commit gate（typecheck + check-docs + lint-staged biome + 全套 test）

**+85 new tests**（6 文件）每个孤立跑都 0 fail：
```
nightly-job-scheduler.test.ts   12 (10 Day 1 + 2 Day 2 guard)
scheduler-leader.test.ts        11 (AC-P2-2 a/b/c/d 全覆盖)
scheduler-config.test.ts        13 (含 Iron Laws 3 pre/post 双断言 + 3 DST fixture)
job-trace.test.ts               20 (8 status × 4 reason 全 fixture + atomic write)
startup-reconciler.test.ts       7 (含 AC-P2-5 复合 crash injection)
room-compiler-tick.test.ts      11 (含 reentrancy zombie lock 防御 + idle 30min)
p18-judge.test.ts               +11 (generic 化 + Phase 1 back-compat)
```

**回归基线**：Phase 1 合 dev 时 2149 → Day 5 后 2247 = +98（85 新 P19 + 13 来自 dev 上 F024/F026/B023 后续 commit）。0 P19 内部失败。

**预存 flake 警告**：`SessionTitler · AC-14d: prepends D- when Haiku returns invalid prefix` 在 dev 上有 ~50% 概率 flake — Day 4 baseline (HEAD~1) 跑 4 次 2 次挂 2 次过，**已 verified 不是 P19 引入**。建议另起 B-ID 处理。

**acceptance-guardian**: ⏭️ 跳过（[[feedback_skip_acceptance_guardian_for_test_infra]] — scheduler 框架属测试基础设施类，AC 即测试命令；后续 Week 4 evidence pack 双 judge 兜整体）

## Known Risks（6 个想听你判）

1. **`stop()` 路径 `demotedReason='manual_release'` 时 `shouldSkipJob()` 返 `role_not_leader` 而非 `lease_lost`** — v2b F1 spec 只锁 `'heartbeat_failed' → 'lease_lost'`，没说 `manual_release`。当前实现：role='demoted' + demotedReason='manual_release' → guard 1 返 `role_not_leader`（因为 only 'heartbeat_failed' 触发 lease_lost 分支）。**问**：manual_release 是否应该也算 lease_lost？还是 role_not_leader 对（理由：人工 stop 不算"丢"lease，是"主动放弃"）？
   - 测试位：`scheduler-leader.test.ts` "stop after start releases + sets demotedReason='manual_release'"

2. **`leaderTerm` 在 `RoomCompilerTick` 是构造时静态值** — option `leaderTerm?: string | null`，traced 进每次 tick 的 trace。但实际 leaderTerm 会随 selfDemote/reacquire 变化（每次 reacquire term++）。tick 类是 long-lived，传静态值意味着 trace 里 leaderTerm 永远是构造时那个值。**问**：是否要改 `leaderTerm?: () => string | null` getter？（默认 null 时 caller 不传也能跑，避免 tick 类构造前必须先 acquire lease）
   - 影响：`room-compiler-tick.ts:55-65` + `room-compiler-tick.test.ts` "custom leaderTerm 反映在 trace"

3. **`windowMinutes` 默认值不一致**：
   - `RoomCompilerTick` 默认 5（与 5min cron 周期匹配）
   - `scheduler-config.ts` DEFAULT 给 nightly job 30 / monthly 60
   - plan §4 文字："默认 [scheduledFor, scheduledFor + min(cron_period, 5min)]" — 按这个解释，nightly 4:00 (24h cron) 也该是 5min window
   - **问**：`ScheduledJobConfig.windowMinutes` 是否就该硬约束 ≤ 5（plan §4 字面）？还是允许长 job 配大窗口（生产合理 — 30min vacuum 不该 5min 后就 missed_window）？

4. **Iron Laws 3 fail-safe scope** — `assertNoConfigFile(rootDir)` 只查根目录的 `wiki.config.yaml`。若有人在子目录创建（如 `.runtime/test/wiki.config.yaml`）不报。**问**：严格语义是不是 "any wiki.config.yaml anywhere under root"，要不要 recursive 查？还是按 P19.3b 真文件就该在根的约定，子目录创建是测试垃圾不算违反？

5. **`DEFAULT_SCHEDULER_CONFIG.scheduled` 7 个 vs plan "9 scheduled"** — 当前列 7 个 explicit (room-compiler-tick / nightly-health-check / nightly-vacuum / weekly-draft-digest / drift-detector / monthly-snapshot / archive-yearly-sessions)。plan §1 称 "9 scheduled + 2 event-driven = 11"。差 2 个未列。**问**：那 2 个是什么？（我猜可能 LeaseHeartbeat + FollowerPoll 内化为 scheduler 自己的 timer，不算"scheduled job"，但 plan 文字按 9 算的话 DEFAULT 是 incomplete）。要补全还是改 plan §1 文字？

6. **scheduler-runtime 集成层缺位** — Day 1-5 各组件单独可测：
   - `NightlyJobScheduler` (job 注册 + cron 触发 + guard hook)
   - `SchedulerLeader` (lease + heartbeat + 三段 guard)
   - `loadSchedulerConfig` (config 加载)
   - `StartupReconciler` (crash 清理)
   - `RoomCompilerTick` (单 job 调度壳)

   但**没有任何一个文件把它们串起来**。plan §3 Day 4 commit message 写了 "Wiring Reconciler into NightlyJobScheduler.start() lifecycle → 后续 day"。打算 Week 4 整合阶段做（与 Week 2-4 各 job 一起）。**问**：Week 1 review 这个集成层缺位是否可接受？还是必须现在补一个 `scheduler-runtime.ts` 集成 wiring（即使 Week 2 的 jobs 还没接进来）？

## Review Focus（按 v2b 五大锁点验证）

### 1. v2b F1 三段 guard 完整性（最高优先级）— `scheduler-leader.ts`

- `shouldSkipJob()` 三段顺序对吗？(1) role check 先于 (2) lease 对象 check 先于 (3) wall clock check
- `selfDemote('heartbeat_failed')` 是否真的：清 lease（this.lease=null）+ 记 demotedReason + 启 follower poll + 触发 onDemote 回调？
- AC-P2-2 (c) lease-lost-live fixture：B 强抢后 A heartbeat 跑 → demote → shouldSkipJob 返 `lease_lost`（不是 lease_expired，区分点 demotedReason 非空）— `scheduler-leader.test.ts:140-200`
- AC-P2-2 (d) lease_expired fixture：heartbeat 不跑（interval 9_999_999），时钟前进过期 → role 仍 leader + demotedReason null + lease 对象仍在 → shouldSkipJob 走 Guard 3 返 `lease_expired` — `scheduler-leader.test.ts:200-230`
- 是否有边界场景没覆盖？（如 lease 对象在但已过期 ms+1 vs ms-1 边界）

### 2. v2b F2 status enum 8 / reason enum 4 锁定 — `job-trace.ts`

- `JOB_TRACE_STATUS_VALUES` 是否真 8 个完整？(`ok / failed / timeout / skipped_reentry / skipped_not_leader / missed_window / recovered_from_crash / lease_lost`)
- `JOB_TRACE_REASON_VALUES` 是否真 4 个完整？(`lease_expired / lease_lost / role_not_leader / heartbeat_failed`)
- `validateJobTrace()` 字段校验是否漏：缺 windowStart / windowEnd 之类必填字段？非法 enum 值？错时间格式？— `job-trace.test.ts:60-130`
- `writeJobTrace()` 落点路径：`<root>/.runtime/job-traces/<jobName>/<YYYY-MM-DD>/<HHMMSS-runId>.json` 与 plan §4 一致吗？atomic write (.tmp + rename) 的 .tmp 残留风险？— `job-trace.test.ts:165-200`

### 3. v2b F3 Iron Laws 3 gate fallback — `scheduler-config.ts`

- `loadSchedulerConfig({ rootDir })` 在无 `wiki.config.yaml` 时返 fallback default + fromFile=false 对吗？
- **`loadSchedulerConfig` 绝不创建文件** — pre/post `assertNoConfigFile(rootDir)` 双断言（test 文件第一个 + 最后一个 test）— 是否充分？还是要每个 test case 内嵌一次？
- DST fixture 3 个（NY spring forward 2026-03-08 / NY fall back 2026-11-01 / Asia/Shanghai 24h 严格）覆盖度 — 还有其他 tz 边界要测吗？
- YAML 解析路径（虽然 Day 3 不走，但 Gate 2 后 P19.3b 直接用）：cron 校验 / missing fields / not-array 三个 throw fixture 够吗？

### 4. AC-P2-5 crash injection 清理 — `startup-reconciler.ts`

- `wiki_events.state='pending' → 'aborted'` UPDATE 路径 — reject_stale_leader 触发器只 fire on INSERT 安全的判断对吗？（trigger 定义见 `drizzle-instance.ts:419-425`）
- `room_checkpoints.committed_at IS NULL → DELETE` — 直接删行的语义：下次 compile 重建。是否对？还是该保留 row + mark abort（schema 没 state 列，删行是唯一选择）？
- 复合 fixture 6 行混合（3 pending + 1 committed + 2 uncommitted ckpt + 1 committed ckpt）→ 计数对（{3, 2}）— `startup-reconciler.test.ts:140-180`
- 幂等性：第二次 reconcile 返 {0, 0} — 实现路径靠 SQL `WHERE state='pending'` 自然幂等；够吗？

### 5. AC-P2-6 RoomCompilerTick reentrancy + missed window — `room-compiler-tick.ts`

- 三段 outcome 顺序：missed_window > reentrancy > run — 顺序对吗？还是该先 reentrancy（防止已经在跑的 tick 触发新的 missed_window 路径）？
- **zombie lock 防御**：executor throw → finally 复位 inProgress → 后续 tick 可正常跑 — `room-compiler-tick.test.ts:147-185`
- onTrace 回调 throw 不打断 tick result（tick 仍正常返 status='ok'）— `room-compiler-tick.test.ts:280-300`
- isIdle 30min 边界：lastSuccessAt + 30min 整 = isIdle true 还是 false？当前实现 `>=` → true。是否有 race（30min 整 vs 30min+1ms 差异）？

### 6. p18-judge.ts generic 化 back-compat（不是 v2b 锁点但 plan §0 D6）

- 默认 `--ac-pattern '^AC-P1-\d+$'` + 默认 evidence files 7 件套 + 默认 inline AC_TEXT — Phase 1 调用零改动跑通吗？
- Phase 2 复用：传 `--ac-pattern '^AC-P2-\d+[ab]?$' --evidence-files 'result.json,judges/...' --ac-text-file phase2.json` 是否够？还是要再扩 prompt 模板可定制？

## Out of Scope

- **scheduler-runtime 集成层** — Day 5 各组件独立可测，wiring 到 Week 2-4 整合（见 Known Risks #6）
- **P19.3b 真 `wiki.config.yaml`** — 阻塞 feature.md Gate 2，等小孙显式批
- **Week 2-4 11 个真 jobs**：NightlyHealthCheck / Vacuum / WeeklyDigest / DriftDetector / MonthlySnapshot / ArchiveYearly / ChainedAlertNotifier / WikiCompilerDebounce / DocsWatcher / backfill-docs.ts script
- **真实 room compile 实现**（RoomCompilerTick 注入 executor，本身只是调度壳）
- **Phase 2 evidence pack 19/19 + 异构双 judge** — Week 4 P19.17 单独走（generic judge wrapper Day 4 已备好）

## Review 节奏

按 [[f027_phase2_status]] 定的 Per Week 节奏（不每天 / 不一次性）：
- 本轮 r1 = Week 1 全 6 commit 一次性提交（含 Day 1 框架到 Day 5 第一个 tick job）
- r2-rN 视反馈，按 P13 r1→r3 chain 模式
- Week 1 GO 才推 Week 2（DocsWatcher + Backfill + HealthCheck）

任何 Q/A 在本文件下方追加段落，或开 `F027-P19-week1-review-r{N}-followup.md` 链接到此处。

## 给范德彪的入口指令

```
cd C:\Users\-\Desktop\Multi-Agent\.worktrees\F027

# 看 commit chain (5 个 Day commit + 之前 plan v1→v2b chain)
git log --oneline -10

# 看 plan v2b（你 confirm GO 那版，作为 spec 真相源）
cat docs/plans/F027-phase2-implementation-plan.md | head -100

# 看本 review request 全文（你正在读）
cat docs/plans/F027-P19-week1-review-request-r1.md

# 跑全套验回归（应 0 P19 fail；SessionTitler AC-14d 预存 flake 50% 概率挂，不算）
pnpm test:api 2>&1 | tail -10

# 单跑 6 个新 test 文件（应 85/85 全过）
pnpm exec tsx --test packages/api/src/services/scheduler/*.test.ts
pnpm exec tsx --test packages/api/scripts/p18-judge.test.ts
```

逐项过 6 个 Review Focus + 6 个 Known Risks 判定（GO / CONDITIONAL / NO-GO）。
