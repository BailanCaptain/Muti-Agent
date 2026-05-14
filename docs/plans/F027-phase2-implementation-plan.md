---
id: F027-phase2
title: F027 Phase 2 调度（NightlyJobScheduler + 11 jobs）· 实施 plan v2（冻结）
status: frozen (小孙 2026-05-14 拍板 5 Open + D1/D2/D6 + 工时上调 + 范 v2a confirm review)
parent: F027 (docs/features/F027-unified-memory-architecture.md)
created: 2026-05-14
revised: 2026-05-14 (v2a — 范德彪 v2 confirm review 4 修前阻断点修订)
owner: 黄仁勋
plan_truth_source: docs/plans/V16.5-final.md (chap 17 行 1778-1885 + chap 24 行 2343 + V16.5.3 D1/D2)
phase1_status: 14/14 AC double-pass + ea773d9 合 dev
v1_commit: 598bab1 (历史保留，未删)
v2_commit: a8e24b1 (历史保留，未删)
---

# F027 Phase 2 · 调度实施 plan v2（冻结）

> **scope**：V16.5 chap 17 NightlyJobScheduler + **11 jobs（9 scheduled + 2 event-driven）** + Leader Lease（runtime owner election 模式）+ 调度配置 + backfill 脚本
>
> **目标工时**：19-22 单人天 / 4 周（多 agent 可并行压到 13-15 天）
>
> **此 plan 仅覆盖 Phase 2**。Phase 3 前端 / Phase 4 审批 UI 各自独立 plan。

## 0. v1 → v2 → v2a 修订摘要

### v2 → v2a（范德彪 v2 confirm review · 2026-05-14）

| # | 修订项 | v2 → v2a | 触发 |
|---|---|---|---|
| **F1** | lease heartbeat 失败处理 | `setInterval(() => renew())` 不接返回值 → **`renewLeader()` 返 null 时 `selfDemote('heartbeat_failed')` + `runJob` 双重 check `role==='leader' && lease 未过期`** | 范 finding 1：compiler-leader-repository.ts:89-99 `renewLeader` term/lease 不匹配返 null；旧伪代码进程没死也会继续触发 job |
| **F2** | `wiki.config.yaml` Iron Laws 3 gate | 无前置 → **§1 增 Iron Laws 3 前置 gate 段 + P19.3 拆 P19.3a (loader/默认) + P19.3b (真文件 · 等 Gate 2)** | 范 finding 2：feature.md:80 明标 Iron Laws 3 + feature.md:292-294 Gate 2 未批 |
| **F3** | job_trace status enum + 时间窗 | 缺 `missed_window` / `lease_lost` + 无 `scheduledFor/windowStart/windowEnd` → **§4 enum 加 2 个 + 时间窗 3 字段 + AC-P2-4 强化** | 范 finding 3：§9/AC-P2-6 要求写 `missed_window` 但 §4 enum 不含 |
| **F4** | backfill resume marker 落点 | "ingest_event_id 索引"模糊 → **明确双源：draft frontmatter `ingest_metadata.ingest_event_id`（post-compile.ts:83 已落）+ `.runtime/backfill-state.jsonl`；不新增 DB column/index；AC-P2-9 加 schema diff=∅ 断言** | 范 finding 4：wiki_events schema 无 `ingest_event_id` 字段（schema.ts:265-294） |
| AC-P2-2 加 fixture | 原 (a)+(b) → **+ (c) lease-lost-live**（leader 进程未死但 `renewLeader` 返 null） | F1 配套验证 |

### v1 → v2 修订摘要（范德彪 walkthrough 2026-05-14 + 二次拦截后）

| 修订项 | v1 → v2 | 触发 |
|---|---|---|
| Jobs 总数 | 9 scheduled + 1 event-driven → **9 scheduled + 2 event-driven** | 漏 `WikiCompilerDebounce`（F027 feature.md:166） |
| Backfill 脚本 | 无 → **新增 `scripts/backfill-docs.ts` + 2 AC（dry-run + resumable）** | F027 feature AC-P2-3/4 漏排（feature.md:170-172） |
| Lease 语义 | 每 job acquire compiler_leader → **scheduler 起来时一次性 acquire（runtime owner election）+ 每 job 进程内 reentrancy guard** | 范-walkthrough §6：原方案长 job 阻塞 5min tick |
| Vacuum 实现 | "30 天前 events 软删 state=archived"（自我矛盾）→ **不改 DB / 不扩 state / 不建表；只产 jsonl 文件 + job_trace** | 范二次拦截：`wiki_events.state` CHECK 只允许 `pending\|committed\|aborted` |
| Job trace 落点 | wiki_events action='nightly_job' → **`.runtime/job-traces/<job>/<ts>.json`** | V16.5 chap 17:1881 vs P1 WikiEventAction 枚举 7 种 drift（见 §13） |
| Cron 库 | TBD → **croner**（Open 1） | TS 原生、零依赖、无 redis |
| Job timeout | TBD → **每 job 独立 timeout 配**（Open 3） | Vacuum 1min vs MonthlySnapshot 30min 差异 |
| Job fail 策略 | TBD → **不重试 + 推 R-201 告警人审**（Open 4） | 避免雪崩 + 重复写 |
| Judge wrapper | 复用现状 → **改 generic（参数化 ac-pattern + evidence-files）**（D6） | p18-judge.ts:92 硬编码 `^AC-P1-\d+$` + 7 件套 |
| AC 数 | 14 → **18** | 补 backfill×2 + WikiCompilerDebounce + 长跑 vs tick 撞 + crash lease + AC-P2-1 强化 + job_trace 契约 |
| 工时 | 15 天 / 3 周 → **19-22 天 / 4 周** | + backfill 2d + WikiCompilerDebounce 0.5d + judge wrapper 1d + lease 语义研究 1d + AC 增项 fixture 0.5d |
| draft TTL 跳过标记 | state='reviewing'（不存在）→ **frontmatter `reviewing: true`** | wiki_memories.state CHECK 三态：draft/canonical/deprecated |
| V16.5 drift | 未识别 → **§13 真相源 drift 归档** | chap 5:522 snapshot/archive 表 + chap 17:1881 nightly_job action 都在 V16.5 写了但 P1 未落地 |

## 1. Phase 1 已交付（依赖前置）

ea773d9 合 dev (2026-05-14) 后，Phase 2 可直接使用：

| Phase 1 能力 | Phase 2 用途 |
|---|---|
| `compiler_leader_lease`（P3.5） | scheduler runtime owner election（**不**每 job 持锁，见 §3） |
| `wiki_events` repository（P1） | Job 触发的业务写入（ingest / promote 等）；**不**承载 job trace |
| `wiki_memories` repository（P10） | DriftDetector 写 update draft；MonthlySnapshot 触发 viewfinder |
| `query_messages` MCP（P14） | NightlyHealthCheck 跨 room 历史扫描 |
| `memory_preflight`（P11） | 每个 job 启动前可选 recall（observability） |
| `Adaptive Recall`（P13） | Health report 召上下文用 |
| `viewfinder anti-drift`（P12） | MonthlySnapshot 触发 full recompile + 漂移 > 30% replace |
| `agent-sessions ledger`（P8） | ArchiveYearlySessions 用 |
| `p18-judge.ts`（P18 → **P19.16 改 generic**） | Phase 2 evidence pack 复用 |
| `sanitize-raw-drop`（P4） | DocsWatcher + backfill 走 ingest pipeline 时复用 |

**Phase 2 不引入任何新 schema、不扩 enum、不改 state CHECK**。V16.5 chap 5:522-524 的 `wiki_events_snapshot` / `wiki_events_archive` 表 + chap 17:1881 的 `action='nightly_job'` 是真相源 drift（详见 §13）。

### ⚠️ Iron Laws 3 前置 Gate（v2a F2 · 范 confirm review 拦截）

**`wiki.config.yaml` 是新增运行时配置文件，触发 Iron Laws 3 边界扩展**（F027 feature.md:80 标注 + Gate 2 未批准 feature.md:292-294）：

| 阶段 | 允许动作 | 禁止动作 |
|---|---|---|
| **Gate 2 批准前** | 实现 `ConfigLoader` + 默认 schema（**无文件 → fallback 内置默认调度**）+ 类型契约 + 单测 | **创建 / 修改** `wiki.config.yaml` 文件（worktree / 主仓 / preview 任何位置） |
| **Gate 2 批准后**（小孙显式 OK 留证据 commit） | 创建模板 `wiki.config.example.yaml` → 文档化字段 → 真 `wiki.config.yaml` | — |

**执行节奏**：
- P19.3 拆为 **P19.3a（loader/默认 + 单测）+ P19.3b（真配置文件 · 等 Gate 2）**
- P19.3a 在无 Gate 2 批准时也可推进（不创建实际配置文件）
- P19.3b 启动前 commit 关联 feature.md Gate 2 ✓ 证据，否则 ❌ 不动手

**为什么不能等 implementation 时再问**：Iron Laws 3 是 fail-safe，违反 = 数据/配置不可逆风险；早识别早升级，避免 implementation 阶段 P1 阻断返工。

## 2. Phase 2 依赖 DAG（v2 重排）

```
P19.1 NightlyJobScheduler 框架（croner + lifecycle）
  │
  ├─ P19.2 scheduler runtime owner election（acquire compiler_leader 一次 + 30s 心跳 renew）
  │
  ├─ P19.3a ConfigLoader + 默认 schema + cron 校验 + 时区（无文件 fallback）★ v2a F2
  │  P19.3b 创建真 wiki.config.yaml（**阻塞 · 等 feature.md Gate 2 小孙批准**）
  │
  ├─ P19.4 job_trace 契约（.runtime/job-traces/<job>/<ts>.json schema 冻结）★ v2 新增
  │
  ├─ P19.5 StartupReconciler（runtime 启动）
  │
  ├─ P19.6 RoomCompilerTick（每 5min）+ 长跑 reentrancy guard
  │
  ├─ P19.7 DocsWatcher（chokidar 实时 + race mitigation）★ V16.5.3 D1
  │
  ├─ P19.7.5 scripts/backfill-docs.ts dry-run + resumable ★ V16.5.3 D2 / v2 新增
  │
  ├─ P19.8 NightlyHealthCheck（凌晨 4:00，draft frontmatter reviewing flag）
  │
  ├─ P19.9 NightlyVacuum（凌晨 5:00，**只产 jsonl 文件 + job_trace**）
  │
  ├─ P19.10 WeeklyDraftDigest（周一 9:00）
  │
  ├─ P19.11 DriftDetector（周一 10:00）
  │
  ├─ P19.12 MonthlySnapshot（每月 1 号 3:00，**含 IO + replace + 通知**）
  │
  ├─ P19.13 ArchiveYearlySessions（每年 1/1 3:00）
  │
  ├─ P19.14 ChainedAlertNotifier（实时事件驱动）
  │
  ├─ P19.15 WikiCompilerDebounce（写后 5s，事件驱动）★ v2 新增
  │
  └─ P19.16 p18-judge.ts → generic（参数化 ac-pattern + evidence-files）★ v2 新增
```

**Critical Path（v2 重排）**：
- 主路径：P19.1 → P19.2 → P19.3 → P19.4 → P19.8 (NightlyHealthCheck, 最复杂 cron job)
- 第二路径：P19.7 + P19.7.5 (DocsWatcher 是 backfill 前置)
- 第三路径：P19.12 MonthlySnapshot (IO + replace + 通知)

**并行性**：
- 多 agent 并行：P19.4 契约冻结后，P19.5-P19.15 可并行 owner
- 单人串行：按 critical path 走 19-22 天

## 3. Lease 语义（v2 关键决策 — Open 2）

**v1 设计（已撤销）**：每 job 调用前 acquire compiler_leader_lease。
**问题**：长 job 持有 lease 期间，5min RoomCompilerTick 拿不到 lease 全部跳过；释放后 spawn 又有重复执行风险。

**v2 设计**：scheduler runtime owner election + 每 job in-process reentrancy guard。

```ts
// scheduler.start() — 启动一次性 acquire
async start() {
  this.lease = await leaseRepo.acquireLeader({
    leaderAlias: 'scheduler',
    ttlSeconds: 60,
  })
  if (this.lease) {
    this.role = 'leader'
    // v2a F1：heartbeat 必须接收 renewLeader 返回值；null = lease 被抢占 / term 不匹配
    // 参考 compiler-leader-repository.ts:89-99（renewLeader WHERE current_term=? AND lease_expires_at>now）
    this.heartbeat = setInterval(async () => {
      const renewed = await leaseRepo.renewLeader({
        currentTerm: this.lease.currentTerm,
        ttlSeconds: 60,
      })
      if (!renewed) {
        // heartbeat 失败 → 旧 leader 必须立即 self-demote，否则 runtime 没死但已丢 lease 仍会触发 job
        await this.selfDemote('heartbeat_failed') // clearInterval(this.heartbeat) + 阻断新 job + 转 follower poll
        return
      }
      this.lease = renewed
    }, 30_000)
  } else {
    this.role = 'follower'
    this.pollInterval = setInterval(() => this.tryPromoteToLeader(), 60_000)
  }
  this.registerJobs() // 注册 11 jobs（leader 才会执行；follower / demoted 跳过）
}

// 每 job 在跑前 guard（v2a F1：双重保险——role + lease expiry 都 check）
async runJob(job: Job) {
  // 即使 role 还标记 leader，若 lease 已过期（heartbeat 慢于 30s tick）也禁跑
  const leaseAlive = this.lease &&
    new Date(this.lease.leaseExpiresAt).getTime() > Date.now()
  if (this.role !== 'leader' || !leaseAlive) {
    writeJobTrace({ status: 'skipped_not_leader', reason: !leaseAlive ? 'lease_expired' : 'role_not_leader' })
    return
  }
  if (job.inProgress) {
    writeJobTrace({ status: 'skipped_reentry', lastStart: job.startedAt })
    return
  }
  job.inProgress = true
  job.startedAt = Date.now()
  try {
    await this.executeWithTimeout(job, job.timeoutMs)
  } finally {
    job.inProgress = false
  }
}

// v2a F1：self-demote 路径
async selfDemote(reason: 'heartbeat_failed' | 'manual_stop') {
  clearInterval(this.heartbeat)
  this.heartbeat = undefined
  this.role = 'follower'
  writeJobTrace({ jobName: 'scheduler', status: 'lease_lost', reason })
  // 正在跑的 job 由 reentrancy guard 自然完成（不强 kill 避免数据不一致）
  // 新 job 由 runJob() 头部 leaseAlive check 阻断
  // 重启 follower poll 等下次抢占机会
  this.pollInterval = setInterval(() => this.tryPromoteToLeader(), 60_000)
}
```

**性质**：
- 全局只有 1 runtime 跑 jobs（owner election）
- 长 job 持有 reentrancy 不阻塞同 runtime 上其他 job
- runtime 崩溃 → lease TTL ≤ 60s 过期 → follower 接管
- 加 0-100ms 随机抖动避免多 follower 同时抢
- **v2a F1**：heartbeat 续约失败 → leader self-demote → 阻断新 job + 转 follower（防"进程没死但已丢 lease 仍触发 job"）

## 4. Job Trace 契约（v2 新增 P19.4）

每个 job 跑完写 `.runtime/job-traces/<job>/<YYYY-MM-DD>/<HHMMSS-runId>.json`：

```json
{
  "schemaVersion": "1.0",
  "jobName": "nightly-health-check",
  "runId": "uuid-v4",
  "scheduledFor": "2026-05-15T04:00:00.000Z",
  "windowStart": "2026-05-15T04:00:00.000Z",
  "windowEnd": "2026-05-15T04:05:00.000Z",
  "startedAt": "2026-05-15T04:00:02.123Z",
  "finishedAt": "2026-05-15T04:00:32.456Z",
  "durationMs": 30333,
  "status": "ok | failed | skipped_reentry | skipped_not_leader | timeout | missed_window | recovered_from_crash | lease_lost",
  "leaderTerm": "12",
  "reason": "lease_expired | role_not_leader | heartbeat_failed | ...",
  "result": { },
  "error": null,
  "alertedRoom": "R-201"
}
```

**status enum 完整列表**（v2a F3：补 `missed_window` + `lease_lost`）：
- `ok` — 正常完成
- `failed` — 业务异常（推 R-201）
- `timeout` — 超 `wiki.config.yaml schedules.<job>.timeout_ms`（推 R-201）
- `skipped_reentry` — 同一 job 上次未结束，本次跳过
- `skipped_not_leader` — role 不是 leader 或 lease 已过期（reason 字段细化）
- `missed_window` — cron 在 `windowEnd` 之前未触发（runtime crash 期间错过 / 长跑 job 阻塞导致迟到）；按 skip policy 不补跑
- `recovered_from_crash` — 上次 runtime crash 后 reconciler 标记
- `lease_lost` — heartbeat 续约失败 self-demote 时记录（v2a F1）

**时间窗语义**：
- `scheduledFor` — cron 触发时刻（croner 计算的下一次）
- `windowStart` / `windowEnd` — 该 cron 周期的有效窗口（默认 `[scheduledFor, scheduledFor + min(cron_period, 5min)]`，job 在窗外触发记 `missed_window`）
- `startedAt` — 实际开跑时刻；`durationMs = finishedAt - startedAt`

Phase 3 scheduler panel 直接读这个目录。failed / timeout / recovered_from_crash / lease_lost 同时推 R-201 告警（**不**写 wiki_events）。

## 5. 每周里程碑（19-22 单人天 / 4 周）

### Week 1 · 框架 + lease + 契约 + 核心 jobs（5 天）

| Day | Phase | 任务 | Commit |
|---|---|---|---|
| 1 | **P19.1** | NightlyJobScheduler 框架（croner + lifecycle start/stop/health） | `feat(F027-P19.1): NightlyJobScheduler 框架 with croner` |
| 2 | **P19.2** | scheduler runtime owner election（acquire 一次 + 30s renew + follower poll + crash 接管） | `feat(F027-P19.2): scheduler runtime owner election` |
| 3 | **P19.3a** + **P19.4** | ⚠️ **P19.3a**（无 Gate 2 也可推）：`ConfigLoader` + 默认 schema + cron 校验 + tz + DST fixture（**无文件 fallback 内置默认**）；P19.3b 创建真 `wiki.config.yaml` 阻塞至 feature.md Gate 2 批准。job_trace JSON schema 冻结。 | `feat(F027-P19.3a/4): config loader + job_trace contract` |
| 4 | **P19.5** + **P19.16** | StartupReconciler；p18-judge → generic 参数化 | `feat(F027-P19.5/16): reconciler + generic judge wrapper` |
| 5 | **P19.6** | RoomCompilerTick（5min + idle 30min + reentrancy guard）+ 长跑 vs tick 撞调度 fixture | `feat(F027-P19.6): RoomCompilerTick with reentrancy` |

### Week 2 · Watcher + Backfill + Health（5 天）

| Day | Phase | 任务 | Commit |
|---|---|---|---|
| 6 | **P19.7** | DocsWatcher (chokidar) — 监听 docs/{features\|bugReport\|lessons}；半写 race mitigation（size/mtime 稳定 + 忽略临时文件） | `feat(F027-P19.7): DocsWatcher V16.5.3 D1` |
| 7-8 | **P19.7.5** | `scripts/backfill-docs.ts` dry-run + 正式跑 resumable（**v2a F4 marker 落点**：draft frontmatter `ingest_metadata.ingest_event_id` + `.runtime/backfill-state.jsonl` 进度文件；kill -9 + `--resume` 跳过已成功；**不**新增 DB column/index/schema） | `feat(F027-P19.7.5): backfill-docs script V16.5.3 D2` |
| 9-10 | **P19.8** | NightlyHealthCheck — 5 类问题（死链/孤岛/frontmatter/漂桶/draft TTL）；draft frontmatter `reviewing: true` 跳过归档 | `feat(F027-P19.8): NightlyHealthCheck` |

### Week 3 · Vacuum/Digest/Drift/Snapshot（5 天）

| Day | Phase | 任务 | Commit |
|---|---|---|---|
| 11 | **P19.9** | NightlyVacuum — 产 `.runtime/wiki-events-snapshot/<year>-<month>.jsonl` + `.runtime/wiki-events-archive/<year>/<month>.jsonl` + job_trace；**DB 不动** | `feat(F027-P19.9): NightlyVacuum jsonl only` |
| 12 | **P19.10** | WeeklyDraftDigest — user-drop only | `feat(F027-P19.10): WeeklyDraftDigest` |
| 13 | **P19.11** | DriftDetector — LL-XXX / 模型升级 / handoff 失败 → update draft | `feat(F027-P19.11): DriftDetector` |
| 14-15 | **P19.12** | MonthlySnapshot — backup + viewfinder full recompile + drift > 30% replace + Jan-1 边界 + 幂等 + 100k mock pressure | `feat(F027-P19.12): MonthlySnapshot` |

### Week 4 · Archive + Alert + Debounce + evidence + 合 dev（4-7 天 buffer）

| Day | Phase | 任务 | Commit |
|---|---|---|---|
| 16 | **P19.13** | ArchiveYearlySessions — yearly pack + mv archive（mock clock） | `feat(F027-P19.13): ArchiveYearlySessions` |
| 17 | **P19.14** | ChainedAlertNotifier — chained_suspect 事件 → R-201 | `feat(F027-P19.14): ChainedAlertNotifier` |
| 18 | **P19.15** | WikiCompilerDebounce — 写 wiki_events 后 5s 派生视图重生成（事件驱动）★ v2 新增 | `feat(F027-P19.15): WikiCompilerDebounce` |
| 19-20 | **P19.17** | Phase 2 evidence pack 精简版（18 AC × 3 件套）+ 异构双 judge + arbitration | `docs(F027-P19): Phase 2 evidence pack 18/18` |
| 21-22 | buffer | bug fix / 整合 / 合 dev | - |

## 6. AC 列表（18 个，v2 冻结）

| AC | 内容 | 测试位 |
|---|---|---|
| **AC-P2-1** | NightlyJobScheduler 起停 + **11 jobs（9 scheduled + 2 event-driven）全部触发命中目标时间窗 + job_trace 落盘** | `nightly-job-scheduler.test.ts` + runtime 跑一周 fixture |
| **AC-P2-2** | Runtime owner election — (a) 双 runtime spawn → 1 leader / 1 follower poll；(b) winner crash → follower ≤ 60s 接管；(c) **v2a F1 lease-lost-live**：leader 进程未死但 `renewLeader()` 返 null（fixture：强抢 term）→ 旧 leader self-demote + 后续 `runJob` 全部 `skipped_not_leader (reason=lease_expired)` + trace 写 `lease_lost` | `scheduler-owner-election.test.ts` |
| **AC-P2-3** | wiki.config.yaml schedules 加载 + cron 校验 + 时区（Asia/Shanghai）+ DST fixture（美东 spring/fall 锁库语义） | `scheduler-config.test.ts` |
| **AC-P2-4** | job_trace JSON schema 契约 + Phase 3 panel 可读（schema 验证 + 字段完整性）；**v2a F3**：必须含 `scheduledFor / windowStart / windowEnd / status / reason` 全字段；status enum 9 种全覆盖 fixture（含 `missed_window` / `lease_lost`） | `job-trace-contract.test.ts` |
| **AC-P2-5** | StartupReconciler — crash injection: wiki_events.state='pending' / room_checkpoints.committed_at IS NULL 启动后清理 | `startup-reconciler.test.ts` |
| **AC-P2-6** | RoomCompilerTick — 5min + idle 30min + **reentrancy guard 长跑期间新触发跳过 + missed window 走 skip policy 落 trace** | `room-compiler-tick.test.ts` |
| **AC-P2-7** | DocsWatcher — chokidar mock + 真 fs temp integration + 半写 race mitigation（size/mtime 稳定 + 忽略 `*.tmp`/`*~`） | `docs-watcher.test.ts` |
| **AC-P2-8** | `pnpm tsx scripts/backfill-docs.ts --dry-run` 输出 `docs/plans/V16.5-backfill-report-<date>.md`（类型分布 + 高 cross_refs 密度 + 失败文件列表），**不写盘** | `backfill-dry-run.test.ts` |
| **AC-P2-9** | backfill 正式跑 — 全量 docs/* 落 `wiki/concepts/draft/_backfill/` + 写 wiki_events；kill -9 + `--resume` 跳过已成功（**v2a F4**：marker 双源——draft frontmatter `ingest_metadata.ingest_event_id`（post-compile.ts:83-87 已落）+ `.runtime/backfill-state.jsonl` 进度文件；resume 时优先读 state 文件，缺失 fallback 扫 frontmatter）；**断言：测试前后 `wiki_events` schema/索引/CHECK diff = ∅**（不新增 DB column 或 index） | `backfill-resume.test.ts` |
| **AC-P2-10** | NightlyHealthCheck — 5 类问题红绿 fixture；draft frontmatter `reviewing: true` 不归档 | `nightly-health-check.test.ts` |
| **AC-P2-11** | NightlyVacuum — 30 天前 events 产 `.runtime/wiki-events-snapshot/<year>-<month>.jsonl` + `.runtime/wiki-events-archive/<year>/<month>.jsonl` + job_trace；**DB 行 / state / schema 全不变（断言：测试前后 sqlite_master diff = ∅）** | `nightly-vacuum.test.ts` |
| **AC-P2-12** | WeeklyDraftDigest — user-drop only，4 类 draft (auto/backfill/quarantined/expired) 不推；混合 5+4 fixture | `weekly-draft-digest.test.ts` |
| **AC-P2-13** | DriftDetector — LL-XXX 新增 / 模型升级 / handoff 失败 三类 trigger fixture → update draft | `drift-detector.test.ts` |
| **AC-P2-14** | MonthlySnapshot — backup + viewfinder full recompile + drift > 30% replace + Jan-1 边界 + 幂等 + 100k mock pressure | `monthly-snapshot.test.ts` |
| **AC-P2-15** | ArchiveYearlySessions — 100k session fixture → yearly pack + mv archive + Jan-1 边界（mock clock） | `archive-yearly-sessions.test.ts` |
| **AC-P2-16** | ChainedAlertNotifier — chained_suspect 事件驱动 → R-201 收 alert | `chained-alert-notifier.test.ts` |
| **AC-P2-17** | WikiCompilerDebounce — 写 wiki_events 后 5s 派生视图重生成（事件驱动）★ v2 新增 | `wiki-compiler-debounce.test.ts` |
| **AC-P2-18** | Phase 2 evidence pack 18/18 PASS double-pass（精简 3 件套；generic p18-judge.ts）+ crash lease recovery fixture（runtime crash → lease ≤ 60s 过期 → 备机接管 trace `recovered_from_crash`） | 本 plan 自身 |

## 7. Evidence Pack 规则（沿用 V16.5 chap 16 精简版）

每个 AC 入 git 3 件套：
```
docs/features/F027/evidence/phase2/AC-P2-N/
  result.json
  judges/
    judge1_claude-opus-4-7.json   # generic p18-judge.ts (P19.16)
    judge2_codex-gpt-5.4.json     # 异构 judge2 (Codex)
    arbitration.json
```

raw evidence (prompt/agent_response/db_dump 等) `.gitignore` 已规则化，本地 audit 时按需现产。

**P19.16 p18-judge.ts 改 generic 改动**：

- 参数化 `--ac-pattern`（默认 `^AC-P1-\d+$` 向后兼容；Phase 2 用 `^AC-P2-\d+$`）
- 参数化 `--evidence-files`（默认 7 件套；Phase 2 用 `result.json`）
- 参数化 `--ac-text-file`（外置 AC 文字描述 JSON 路径；Phase 1 内置 map 抽出来）
- `--judge` allowlist 扩展（不只 claude-opus-4-7）
- 向后兼容：Phase 1 evidence 重跑必须仍 PASS（regression 锁定）

## 8. 5 Open 拍板（2026-05-14 小孙拍）

| # | 决策 | 拍板 | 范+我建议理由 |
|---|---|---|---|
| 1 | Cron 库 | **croner** | TS 原生、零依赖、无 redis |
| 2 | Lease 策略 | **scheduler runtime owner election** + 每 job in-process reentrancy guard | 长 job 不阻塞 5min tick；不新建 schema |
| 3 | Job timeout | **每 job 独立 timeout 配** (`wiki.config.yaml schedules.<job>.timeout_ms`) | Vacuum 1min vs MonthlySnapshot 30min |
| 4 | Job fail 处理 | **单 job fail 不影响后续 + 推 R-201 告警人审，不自动重试** | 避免雪崩 + 重复写 |
| 5 | Health report 推哪 | **R-201**（spec 默认）+ 加摘要/阈值避免噪声 | 沿用 spec，不造 R-301 |

## 9. 风险点 + mitigations（v2 扩）

| 风险 | mitigation |
|---|---|
| Cron 时区漂移 | wiki.config.yaml timezone + 启动打印当前 tz + DST fixture（Asia/Shanghai 主 + 美东 spring/fall 锁库语义） |
| Runtime owner 抢占不公平（同 runtime 一直赢） | acquire 加随机抖动 0-100ms |
| 长跑 job 阻塞 5min tick | reentrancy guard（同 runtime 同 job 不重入；不同 job 独立调度） |
| MonthlySnapshot 30min 长跑 | worker thread / spawn 独立进程 + 主调度线程不阻 + reentrancy guard 兜底 |
| DocsWatcher 半写文件 race | size/mtime 稳定（连续 2 次 stat 一致才入 ingest）+ 忽略 `*.tmp`/`*~`/`.DS_Store` 临时文件 |
| chokidar Windows fs.watch 兼容 | 自带 polling fallback + Windows worktree fixture 跑过测试 |
| draft TTL 误归档（小孙正审） | 归档前 check frontmatter `reviewing: true`（**不**用 state，wiki_memories.state 三态 draft/canonical/deprecated 无 'reviewing'） |
| NightlyVacuum + HealthCheck 并发读写 | Vacuum 只产文件不动 DB → 与 HealthCheck 读冲突最小化（HealthCheck 读 SQLite WAL 稳定快照） |
| Cron missed window | last-run trace + skip policy（长周期 job 如 MonthlySnapshot 错过窗口不补跑，下次按 cron 触发；trace 写 `missed_window`） |
| Runtime crash lease 漏跑 | ≤ 60s follower 接管；接管 trace 记 `recovered_from_crash`；crash 期间错过的 cron 不补跑（trace 记 `missed_window`） |
| ArchiveYearlySessions 1 年只跑 1 次难测 | mock clock + 测试用 30 天周期短跑路径 + Jan-1 边界 fixture |
| backfill 几百份淹小孙 | 落 `_backfill/` 隔离区 + WeeklyDraftDigest 不推（V16.5.3 D3）+ 30 天 TTL `_expired/` |
| evidence judge OAuth quota 用尽 | judge1 / judge2 独立配额池；用尽 → BLOCKED（不再 SKIP=PASS） |
| V16.5 chap 5/17 真相源 drift | 见 §13 归档；后续 phase 决策是否补 schema |

## 10. 异常 / 回滚

- **某 job 跑失败**：写 `.runtime/job-traces/<job>/.../status='failed'` + 推 R-201 告警；**不写 wiki_events / 不自动回滚 / 不自动重试**
- **scheduler 整体起不来**：runtime 不阻塞启动（fail-open），告警推 R-201，运维介入
- **Runtime owner 永远拿不到**：follower 持续 60s poll，30s 失败后 fail-open 跳过本次执行（不挂主流程）
- **lease TTL 设错**：单元测试锁 60s + 30s renew + 0-100ms 抖动；boot 时打印实际值 sanity check
- **Heartbeat 续约失败**（v2a F1 · lease 被抢占 / clock skew / DB 暂时挂）：`renewLeader()` 返回 null → 旧 leader 立即 `selfDemote('heartbeat_failed')` → clearInterval(heartbeat) + role=follower + 阻断新 job + 重启 60s follower poll；正在跑的 job 由 reentrancy guard 自然完成（**不强 kill 避免数据不一致**）；trace 记 `status='lease_lost'`
- **Heartbeat 失败但 runJob 已开跑**：`runJob` 头部双重保险——`role==='leader' && new Date(lease.leaseExpiresAt) > Date.now()` 两条件都过才执行；trace 记 `skipped_not_leader` + `reason='lease_expired'`

## 11. 合 dev 节奏（按 memory `feature_completion_before_merge` 例外 2）

Phase 2 满足例外条件 → 单独合 dev：
- (a) 18/18 AC 100% done
- (b) evidence pack + 异构双 judge 双 PASS
- (c) Phase 2 是 enabling layer（Phase 3 前端 RuntimeLog 依赖 job_trace JSON + health report JSON）
- (d) worktree preview 验收通过

## 12. 与 Phase 3 / 4 的边界

| Phase 2 做 | Phase 3/4 做（不在本 plan） |
|---|---|
| NightlyJobScheduler 后端 service + 11 jobs 实现 | 前端 scheduler 状态 panel（Phase 3 P20） |
| **结构化 `.runtime/job-traces/<job>/<ts>.json`**（设计约束：Phase 3 panel 直接读） | StatusPanel 拖宽 / RuntimeLog 5 tab UI（Phase 3） |
| **结构化 health report JSON**（HealthCheck 输出）+ 摘要/阈值推 R-201 | IngestModal 前端审批 UI（Phase 4） |
| Jobs 内部触发 ingest / archive 调用 Phase 1 service | PromoteModal / 命令面板（Phase 4） |

## 13. V16.5 真相源 drift 归档

v1 walkthrough 暴露 2 处 V16.5 真相源 vs P1 实现 drift。Phase 2 保留 P1 契约不破，drift 归档到后续 phase：

| Drift # | V16.5 真相源 | P1 实现 | Phase 2 处理 | 后续 phase |
|---|---|---|---|---|
| **D-1** | chap 5:522-524 写 `wiki_events_snapshot` / `wiki_events_archive` 表（compact + archive 落地点） | P1 schema 未建（drizzle-instance.ts 4 张表无此 2 表） | NightlyVacuum 改产 jsonl 文件 + job_trace；DB 不动 | Phase 5/6 决策是否补 schema（迁移路径：jsonl → table 一次性 import） |
| **D-2** | chap 17:1881 写 Job 失败 `action='nightly_job'` | P1 `WikiEventAction` 枚举 7 种（write/append/patch/ingest/promote/demote/delete），无 nightly_job | Job trace 落 `.runtime/job-traces/`；不污染 wiki_events 语义 | 后续 phase 决策：扩 enum / 新建 `job_runs` 表 / 保持文件层 |

**为什么不在 Phase 2 修 drift**：

- Phase 2 边界（小孙 2026-05-13 拍）：不引新 schema、不扩 enum、不改 state CHECK
- D-1 引入 2 张表 + 触发器/迁移；D-2 扩 enum 影响 Phase 1 类型契约
- 文件层方案对 Phase 2 功能性等价（snapshot/archive/trace 都达成）
- 后续 phase 由小孙拍是否补；不补也不阻塞 V16.5 主线

## 14. 立项材料

- **F-id**: F027 Phase 2
- **优先级**: P0
- **worktree**: `feat/F027-unified-memory-architecture`（沿用 Phase 1）
- **工期**: 19-22 单人天 / 4 周
- **SOP**: `feat-lifecycle` skill（Phase 2 子任务）
- **依赖**: Phase 1 ea773d9 合 dev ✅

---

**下一步**：plan v2a commit 入 worktree → [Call: @范德彪 confirm v2a] → 通过后启动 P19.1 框架。

> v2a 修订点（范 v2 confirm review 4 修前阻断 + 1 AC 强化）：F1 lease heartbeat self-demote · F2 wiki.config.yaml Iron Laws 3 gate 拆 P19.3a/b · F3 job_trace `missed_window`/`lease_lost` enum + 时间窗字段 · F4 backfill marker 落 frontmatter + state.jsonl（**不**碰 DB schema） · AC-P2-2 加 lease-lost-live fixture。
