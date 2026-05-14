---
id: F027-phase2
title: F027 Phase 2 调度（NightlyJobScheduler + 9 jobs）· 实施 plan 第一稿
status: draft (待小孙 5 Open review)
parent: F027 (docs/features/F027-unified-memory-architecture.md)
created: 2026-05-14
owner: 黄仁勋
plan_truth_source: docs/plans/V16.5-final.md (chap 17 行 1778-1885 + chap 24 行 2343)
phase1_status: 14/14 AC double-pass + ea773d9 合 dev
---

# F027 Phase 2 · 调度实施 plan（第一稿）

> **scope**：V16.5 chap 17 NightlyJobScheduler + 9 cron/event-driven jobs + Leader Lease 共享 + 调度配置
>
> **目标工时**：10-15 单人天 / 2-3 周（多 agent 可并行 9-12 天）
>
> **此 plan 仅覆盖 Phase 2 (P19)**。Phase 3 前端 (P20) / Phase 4 审批 UI 各自独立 plan。

## 0. Phase 1 已交付（依赖前置）

ea773d9 合 dev (2026-05-14) 后，Phase 2 可直接使用：

| 来自 Phase 1 的能力 | 用途 |
|---|---|
| `compiler_leader_lease`（P3.5） | NightlyJobScheduler **每个 job 启动前 acquire** |
| `wiki_events` repository（P1） | nightly job 失败写 `action='nightly_job', result='failed'` |
| `wiki_memories` repository（P10） | DriftDetector 写 update draft；MonthlySnapshot 触发 viewfinder |
| `query_messages` MCP（P14） | nightly health check 跨 room 历史扫描 |
| `memory_preflight`（P11） | 每个 job 启动前可选 recall（observability） |
| `Adaptive Recall`（P13） | health report 召上下文用 |
| `viewfinder anti-drift`（P12） | MonthlySnapshot 触发 full recompile + 漂移 > 30% replace |
| `agent-sessions ledger`（P8） | ArchiveYearlySessions 用 |

**Phase 2 不引入任何新 schema**（沿用 P0 的 4 张表 + Phase 1 各模块）。

## 1. Phase 2 依赖 DAG

```
                    ┌─ P19.1 NightlyJobScheduler service 框架（cron 库 + lifecycle）
                    │           │
                    │           ├─ P19.2 Leader Lease 集成（复用 P3.5）
                    │           │
                    │           └─ P19.3 Job 注册 + 调度配置（wiki.config.yaml schedules 段）
                    │
                    ├─ P19.4 StartupReconciler job（runtime 启动）
                    │
                    ├─ P19.5 RoomCompilerTick job（每 5 分钟）
                    │
                    ├─ P19.6 DocsWatcher job（实时 chokidar） ★ V16.5.3
                    │
                    ├─ P19.7 NightlyHealthCheck job（凌晨 4:00）
                    │
                    ├─ P19.8 NightlyVacuum job（凌晨 5:00）
                    │
                    ├─ P19.9 WeeklyDraftDigest job（周一 9:00）
                    │
                    ├─ P19.10 DriftDetector job（周一 10:00）
                    │
                    ├─ P19.11 MonthlySnapshot job（每月 1 号 3:00）
                    │
                    ├─ P19.12 ArchiveYearlySessions job（每年 1/1 3:00）
                    │
                    └─ P19.13 ChainedAlertNotifier job（实时事件驱动）

Critical Path: P19.1 → P19.2 → P19.3 → P19.7 (NightlyHealthCheck 最复杂)
              ≈ 决定 Phase 2 最早完成时间
```

**并行性**：
- **多 agent 并行**：P19.1 框架冻结后，P19.4-P19.13 各 job 可并行（不同 owner 拆领）
- **单人串行 fallback**：按 critical path 走，约 10-15 天

## 2. 每周里程碑（单人 15 天估算 / 多 agent 并行 2 周）

### Week 1 · 框架 + 核心 jobs（5 天）

| Day | Phase | 任务 | Commit | Evidence |
|---|---|---|---|---|
| 1 | **P19.1** | NightlyJobScheduler service 框架 + cron 库选型 (Open #1) + lifecycle (start/stop/health) | `feat(F027-P19.1): NightlyJobScheduler 框架` | unit test (schedule/cancel/lifecycle) |
| 2 | **P19.2** | Leader Lease 集成 — 每个 job 调用 acquire compiler_leader_lease，多 runtime 不重跑 | `feat(F027-P19.2): scheduler leader lease` | 双 runtime 实例 job 互斥测试 |
| 3 | **P19.3** | wiki.config.yaml schedules 段 + 加载 + cron 表达式校验 | `feat(F027-P19.3): scheduler config + validation` | 配置 fixture (Asia/Shanghai 时区) |
| 4 | **P19.4** | StartupReconciler — pending wiki_events / NULL room_checkpoints 处理 | `feat(F027-P19.4): StartupReconciler` | crash injection: wiki_events.state='pending' → 启动后清理 |
| 5 | **P19.5** | RoomCompilerTick — 每 5 分钟扫所有 room cursor，idle 30min 触发 | `feat(F027-P19.5): RoomCompilerTick` | mock cursor + idle 30min 触发 |

**Week 1 验收**：scheduler 起来 + 2 个 cron job 跑通 + leader lease 互斥（对应 AC-P2-1/2/3/4/5）

---

### Week 2 · Health/Vacuum/Digest/Drift jobs（5 天）

| Day | Phase | 任务 | Commit | Evidence |
|---|---|---|---|---|
| 6 | **P19.6** | DocsWatcher — chokidar 监听 docs/features|bugReport|lessons → ingest pipeline → wiki/concepts/draft/_auto/ | `feat(F027-P19.6): DocsWatcher V16.5.3 D1` | watch fixture: 写 docs/lessons/x.md → 5s 后 _auto/ 出 draft |
| 7-8 | **P19.7** | NightlyHealthCheck — 死链 / 孤岛 / frontmatter / canonical_owner 漂桶 / draft TTL 30 天归档 | `feat(F027-P19.7): NightlyHealthCheck` | red fixture (含死链 + 孤岛 + 漂桶) → report 全命中 |
| 9 | **P19.8** | NightlyVacuum — wiki_events 30 天前 compact + archive | `feat(F027-P19.8): NightlyVacuum` | 写 31 天前 event → vacuum 后 archive 出现 |
| 10 | **P19.9** | WeeklyDraftDigest — 推 user-drop draft 待审清单到 R-201 (target_room 配置)，_auto/_backfill/_quarantined/_expired 不推 | `feat(F027-P19.9): WeeklyDraftDigest` | 混合 fixture: 5 user + 3 auto → digest 只含 5 user |

**Week 2 验收**：5 个核心 health/vacuum/digest job 跑通 + draft 分类推送正确（对应 AC-P2-6/7/8/9）

---

### Week 3 · Drift/Snapshot/Archive/Alert + evidence pack + 合 dev（5 天）

| Day | Phase | 任务 | Commit | Evidence |
|---|---|---|---|---|
| 11 | **P19.10** | DriftDetector — LL-XXX 新增 / 模型升级 / handoff 失败 → 自动开 update draft | `feat(F027-P19.10): DriftDetector` | 注入 LL-XXX → draft 出 |
| 12 | **P19.11** | MonthlySnapshot — full wiki backup + viewfinder full recompile + 漂移 > 30% replace | `feat(F027-P19.11): MonthlySnapshot` | mock viewfinder drift 35% → replace 触发 |
| 13 | **P19.12** | ArchiveYearlySessions — S-XXXX.md 合并 yearly pack + mv archive | `feat(F027-P19.12): ArchiveYearlySessions` | 100k session fixture → 1 year 合并 → active < 1k |
| 14 | **P19.13** | ChainedAlertNotifier — chained_suspect 事件驱动推 room | `feat(F027-P19.13): ChainedAlertNotifier` | trigger chained_suspect event → room 收到 alert |
| 15 | **P19.14** | Phase 2 evidence pack 精简版（按 V16.5 chap 16 精简 spec）+ 双 judge 异构 + arbitration | `docs(F027-P19): Phase 2 evidence pack` | 14 个 AC × {result.json + judges/} |

**Week 3 验收**：9 jobs 全跑通 + Phase 2 evidence pack 14/14 双 PASS → 合 dev

---

## 3. AC 列表（待小孙 review 后冻结）

| AC | 内容 | 复用测试位 | Evidence 主体 |
|---|---|---|---|
| **AC-P2-1** | NightlyJobScheduler service 起停 + lifecycle 健康 | `nightly-job-scheduler.test.ts` | scheduler.start() → 9 jobs 注册 → stop() 全清 |
| **AC-P2-2** | Leader Lease 互斥 — 双 runtime 同 job 只跑一次 | `scheduler-leader-lease.test.ts` | 2 runtime spawn → 同 cron 触发 → 1 winner / 1 lease_expired |
| **AC-P2-3** | wiki.config.yaml schedules 加载 + cron 校验 + 时区（Asia/Shanghai）| `scheduler-config.test.ts` | bad cron → reject + 时区 fixture |
| **AC-P2-4** | StartupReconciler 处理 pending wiki_events / NULL checkpoints | `startup-reconciler.test.ts` | crash injection fixture |
| **AC-P2-5** | RoomCompilerTick idle 30min 触发 | `room-compiler-tick.test.ts` | mock cursor age fixture |
| **AC-P2-6** | DocsWatcher 监听 docs/{features|bugReport|lessons} → _auto/ draft | `docs-watcher.test.ts` | chokidar mock + 写 fixture md → _auto/ 出现 |
| **AC-P2-7** | NightlyHealthCheck — 5 类问题（死链 / 孤岛 / frontmatter / 漂桶 / draft TTL）红绿 | `nightly-health-check.test.ts` | red fixture 全命中 / green 全空 |
| **AC-P2-8** | NightlyVacuum — wiki_events 30 天前 compact + archive | `nightly-vacuum.test.ts` | time travel fixture |
| **AC-P2-9** | WeeklyDraftDigest — user-drop only，4 类 draft (auto/backfill/quarantined/expired) 不推 | `weekly-draft-digest.test.ts` | 混合 5+4 fixture |
| **AC-P2-10** | DriftDetector — LL-XXX / 模型升级 / handoff 失败 → update draft | `drift-detector.test.ts` | 3 trigger fixture |
| **AC-P2-11** | MonthlySnapshot — backup + viewfinder full recompile + 漂移 > 30% replace | `monthly-snapshot.test.ts` | drift 35% fixture → replace |
| **AC-P2-12** | ArchiveYearlySessions — yearly pack + mv archive | `archive-yearly-sessions.test.ts` | 100k session fixture |
| **AC-P2-13** | ChainedAlertNotifier — chained_suspect 事件 → room 收 alert | `chained-alert-notifier.test.ts` | trigger event fixture |
| **AC-P2-14** | Phase 2 evidence pack 14/14 PASS double-pass（精简 3 件套版） | 本 plan 自身 | result.json + judges/judge1/judge2/arbitration |

## 4. Evidence Pack 规则（沿用 V16.5 chap 16 精简版，2026-05-14 拍）

每个 AC 入 git **3 件套**：
```
docs/features/F027/evidence/phase2/AC-P2-N/
  result.json
  judges/
    judge1_claude-opus-4-7.json   # 订阅模式 wrapper (复用 packages/api/scripts/p18-judge.ts)
    judge2_codex-gpt-5.4.json     # 异构 judge2 (Codex)
    arbitration.json
```

raw evidence (prompt/agent_response/db_dump/wiki_state/config/prod_config_diff) `.gitignore` 已规则化，本地 audit 时按需现产。

## 5. 5 Open 待小孙拍

| # | Open | 选项 | 我的倾向 |
|---|---|---|---|
| **1** | Cron 库选 | (a) `node-cron` 老牌轻量 (b) `croner` 新派零依赖 + TS 原生 (c) `bull/bullmq` 重量带 redis | **b croner** — 项目已是 TS 原生，无需 redis |
| **2** | Leader Lease 是否复用 Phase 1 P3.5 `compiler_leader_lease`（同一 lease） | (a) 复用同 lease 统一抢占 (b) 新建 `scheduler_leader_lease` 分离责任 | **a 复用** — 原子性更好，避免双 lease 死锁 |
| **3** | Job timeout 策略 | (a) 每 job 独立 timeout 配 (b) global 默认 10min (c) 不设 timeout 靠 lease 超时回收 | **a 每 job 独立** — 不同 job 工作量差异大 (vacuum 1min vs MonthlySnapshot 30min) |
| **4** | Job fail 处理 | (a) 单 job fail 不影响后续 jobs (b) 自动重试 N 次 (c) 推告警 + 不重试人审 | **a + c** — 不重试避免雪崩，告警让小孙拍 |
| **5** | Health report 推送 room | (a) R-201 (V16.5 chap 17 默认) (b) 新建 R-301 健康检查专用 room (c) 直接 console + log 不推 room | **a R-201** — 沿用 spec 默认，避免 room 数膨胀 |

## 6. 风险点 + mitigations

| 风险 | mitigation |
|---|---|
| Cron 不准（容器时区漂移） | wiki.config.yaml `timezone: Asia/Shanghai` + 启动时打印当前 tz，单元测试用固定时间 |
| Leader Lease 抢占不公平（同 runtime 一直赢） | 加随机抖动 0-100ms，公平分布 |
| MonthlySnapshot 30min 长跑阻塞其他 job | scheduler 用 worker thread / spawn 独立进程，主线程不阻 |
| chokidar Windows fs.watch 兼容 | 用 chokidar 自带 polling fallback，Windows fixture 跑过测试 |
| draft TTL 30 天误归档（小孙正在审） | 归档前再次 check `state='reviewing'` flag，flag set 则不归档 |
| ArchiveYearlySessions 1 年只跑 1 次难测试 | 用 mock clock + 测试用 30 天周期短跑路径 |

## 7. 异常 / 回滚

- **某 job 跑失败**：写 wiki_events `action='nightly_job', result='failed'` + 推告警，**不自动回滚**（Phase 1 设计原则一致）
- **scheduler 整体起不来**：runtime 不阻塞启动（fail-open），告警推 R-201，运维介入
- **Leader Lease 永远拿不到**：30s 失败后 fail-open 跳过这次执行（不挂主流程）

## 8. 合 dev 节奏（按 memory `feature_completion_before_merge` 例外 2）

Phase 2 满足例外条件 → 单独合 dev：
- (a) 14/14 AC 100% done
- (b) evidence pack + 异构双 judge 双 PASS
- (c) Phase 2 是 enabling layer（Phase 3 前端 RuntimeLog 依赖 scheduler 健康数据）
- (d) worktree preview 验收通过

## 9. 与 Phase 3 / 4 的边界

| 我们做 | 不做 |
|---|---|
| NightlyJobScheduler 后端 service + 9 jobs 实现 | 前端 scheduler 状态 panel（属 Phase 3 P20） |
| jobs 内部触发 ingest / vacuum / archive 调用 Phase 1 service | IngestModal 前端审批 UI（属 Phase 4） |
| Health report 推 room（结构化 JSON message） | StatusPanel 拖宽 / RuntimeLog 5 tab UI（属 Phase 3） |

---

**下一步**：等小孙 review 5 Open + AC 列表是否合理 → 拍后冻结 plan → 启动 P19.1 框架。
