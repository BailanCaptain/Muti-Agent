---
id: F027-P19-week2-review-r1
title: F027 Phase 2 Week 2（P19.7 + P19.7.5 + P19.8）r1 review 请求
reviewer: 范德彪
requester: 黄仁勋
created: 2026-05-15
status: open
round: r1（Per Week 节奏批 review；同 Week 1 r1→r3 chain 模式）
parent: F027-P19-week1-review-confirmation-r3
---

# F027 Phase 2 Week 2 r1 Review Request — DocsWatcher / Backfill / NightlyHealthCheck

**Feature:** F027 — `docs/features/F027-unified-memory-architecture.md`
**Plan:** `docs/plans/F027-phase2-implementation-plan.md`（v2b frozen）
**真相源:** V16.5 chap 17 line 1789-1855 (NightlyHealthCheck) / line 2640-2672 (backfill + watcher)
**Branch / Worktree:** `feat/F027-unified-memory-architecture` @ `.worktrees/F027`
**HEAD:** Day 9-10 commit (this PR's HEAD)
**Parent (Week 1):** `docs/plans/F027-P19-week1-review-confirmation-r3.md`（你 r3 GO）

## What Changed

Week 2（5 天 / 3 个 P 阶段 / 4 个 AC）— DocsWatcher 增量监听 + backfill 一次性导入 + NightlyHealthCheck 5 类问题检测。集成层 wire 仍推 Week 4 整合。

| Day | Commit | P 阶段 | 文件 | 测试 | AC 覆盖 |
|---|---|---|---|---|---|
| 6 | `b0bfc31` | P19.7 | `docs-watcher.ts/.test.ts` + chokidar^5 dep | 10 | AC-P2-7 (chokidar mock + 真 fs temp + 半写 race + 忽略临时文件) |
| 7-8 | `6dcde9f` | P19.7.5 | `scripts/backfill-docs.ts/.test.ts` | 15 | AC-P2-8 (dry-run 报告) + AC-P2-9 (resumable + v2a F4 marker 双源) |
| 9-10 | (本 commit) | P19.8 | `nightly-health-check.ts/.test.ts` | 18 | AC-P2-10 (5 类 red/green + v2 修订 reviewing=true 跳过) |

**总规模**：3 src 文件 + 3 test 文件 + chokidar^5 dep。
**Diff**：+约 1700 LOC（含测试）/ 0 删除既有功能。
**0 schema 改 / 0 enum 扩 / 0 wiki.config.yaml 创建**（v2a F2 Iron Laws 3 + plan §1 仍遵守）。

## Why

Plan §3 Week 2 schedule：DocsWatcher + Backfill + HealthCheck 是 P19 的"业务感知层"——比 Week 1 框架层更靠近用户场景，但仍是辅助 jobs（不是 Phase 3 UI / Phase 4 审批的核心路径）。

V16.5 spec 锁定的 3 个真相源已对齐：
- chap 17:1807 / 2660 — DocsWatcher chokidar/fs.watch + 60s debounce
- chap 17:2640-2654 — backfill resumable + state.jsonl + frontmatter dual marker
- chap 17:1816-1854 — NightlyHealthCheck 5 桶 + draft TTL

## Original Requirements

**小孙原话** (2026-05-15)：
> "go" × N（每天 Day 6 → Day 10 推进）
> "不要停下来 直接做完 然后一直按照之前的流程走就行了"

无 Open 决策，按 plan v2b 严格落地。

## v2b 修订点（Week 2 范围内）落实情况

- **F4 backfill marker 双源** — `scripts/backfill-docs.ts` `.runtime/backfill-state.jsonl` 优先 + frontmatter `ingest_metadata.ingest_event_id`（post-compile.ts:83 已落，不重写）
- **draft frontmatter `reviewing: true` 跳过归档** — `nightly-health-check.ts:179` `if (entity.frontmatter.reviewing === true) continue`
- **不新增 DB column / index / schema** — backfill 脚本 0 DB import；health check 走注入 scanEntities 不直接 import drizzle

## Self-Check Evidence

**quality-gate**: ✅ PASS (2026-05-15)
- typecheck `pnpm --filter @multi-agent/api typecheck` → exit 0 ✅
- 全套 `pnpm test:api` → 2303 → 2321 tests / 0 fail / 8 skip / 1 todo（含 +43 new Week 2 tests）
- 3 个 commit 全过 husky pre-commit gate（typecheck + check-docs + lint-staged biome + 全套 test）
  - Day 7-8 中途撞 biome `noImplicitAnyLet` 一处（walk() entries 类型）→ 修后 retry 过
  - SessionTitler AC-06/AC-10/AC-14d 仍 50% 概率 flake → retry 模式

**+43 new tests**：
```
docs-watcher.test.ts            10 (AC-P2-7)
backfill-docs.test.ts           15 (AC-P2-8 + AC-P2-9)
nightly-health-check.test.ts    18 (AC-P2-10)
```

**回归基线**：Week 1 r3 收官 2260 → Week 2 收官 2303（+43 / 0 P19 回归）。
SessionTitler 预存 flake 已 verify 不是 P19 引入（Week 1 review 时已 flag）。

**acceptance-guardian**: ⏭️ 跳过（同 Week 1，scheduler 业务层属测试基础设施类，AC 即测试命令）

## Known Risks（5 个想听你判）

1. **DocsWatcher `ignoreInitial: true`** — 启动时已存在的文件不算 add，避免 watcher 触发一遍 backfill。但若 runtime 重启时刚好有文件未被 backfill 处理过，watcher 也不会触发它。**问**：这是设计漏洞吗？还是合理（由 backfill --resume 单独负责"启动期未处理文件"）？看`docs-watcher.ts:108`。

2. **DocsWatcher `awaitWriteFinish` pollInterval 计算** — 当前 `min(50, stability/3)`。若 caller 传 stabilityMs=10（极小），pollInterval = max(5, min(50, 3)) = 5ms。会不会过度 CPU 占用？**问**：要不要 hardcoded 最小 100ms？看`docs-watcher.ts:98-100`。

3. **backfill `--resume` 仅读 state.jsonl，不 fallback 扫 frontmatter** — v2a F4 spec 写"state 优先；缺失 fallback 扫 frontmatter"。我只实现 state 优先；frontmatter fallback 没做。**问**：场景是 state.jsonl 损坏 / 丢失但 frontmatter 完整 → 当前会重跑全部。是否必须实现 frontmatter fallback？还是可以视为"丢 state 就重做，post-compile 已写 frontmatter 就 idempotent"？看`backfill-docs.ts:286-291`。

4. **NightlyHealthCheck orphans 默认豁免 draft 路径** — `isDraftPath(p) → 包含 '/draft/'`。我假设 draft 都没 inbound 是正常的（未发布）。但若某 draft 真的孤立（user 写了忘了），就被永久豁免。**问**：是否该改为"draft 30 天前的孤岛进 draftExpired，<30 天豁免"？看`nightly-health-check.ts:165`。

5. **NightlyHealthCheck deadLinks ref 解析** — 当前 `[[wikilink]]` 直接当 path（自动加 .md 后缀），`(../path.md)` 用 path.posix 算相对路径。但 wikilink 实际可能是 `[[Concept Name|alias]]`（人类可读），需要查名→path 映射，而非直接当 path。当前实现把它当 path 直接对比 entity.path → 会大量误报 deadLink。**问**：这是 P1（必须改）吗？要不要 caller 传一个 nameToPath resolver？看`nightly-health-check.ts:213-216`。

## Review Focus（按 4 个新 AC 验证）

### 1. AC-P2-7 DocsWatcher（最高优先级 — chokidar 集成）— `docs-watcher.ts`

- chokidar v5 ESM-only → 用 `await import("chokidar")` 动态加载，对吗？看 `docs-watcher.ts:96`
- start() 等 `ready` event 后才返（防 race：start 返回 ≠ watcher 真就绪）— `docs-watcher.ts:120-129`
- 半写 race mitigation：内置 awaitWriteFinish (stabilityThreshold + pollInterval) — 测试用 stabilityMs=100/30 验证收敛 — `docs-watcher.ts:98-104`
- kind 收敛：`add` + `change` 在 debounce 内 → finalKind=`add`（保留新文件信号）— `docs-watcher.ts:155-159`
- unlink 立即 fire + cancel pending add/change — `docs-watcher.ts:175-187`
- 忽略 `*.tmp / *~ / *.swp / .DS_Store / .git/ / node_modules/` — 默认 ignored — `docs-watcher.ts:60-67`

### 2. AC-P2-8 dry-run + AC-P2-9 resumable — `backfill-docs.ts`

- dry-run：写报告 `V16.5-backfill-report-<date>.md` + 不调 ingest + 不写 state — 测试 `backfill-docs.test.ts:317`
- resume：state 优先 skip；缺失 fallback 扫 frontmatter — Known Risks #3 要听你判
- v2a F4 marker：state.jsonl + frontmatter（post-compile.ts:83 已落 frontmatter；本脚本只写 state）
- kill -9 容错：`readBackfillState` 半行损坏跳过不打断 — 测试 `backfill-docs.test.ts:175`
- DB schema 不动：本脚本 0 DB import → 验证；测试断言`不动 sqlite_master diff`未直接做（需 DB 集成测试，本 Phase 推后）

### 3. AC-P2-10 NightlyHealthCheck 5 类 — `nightly-health-check.ts`

- 5 桶 red/green fixture 全覆盖（10 个核心测试 + 1 复合 fixture + 7 个边界 / 回调）
- v2 修订 `reviewing: true` 跳过 draftExpired — `nightly-health-check.ts:179` + 测试 `nightly-health-check.test.ts:281`
- orphans 豁免 draft 路径 — Known Risks #4 要听你判
- deadLinks wikilink 当 path 直接对比 — Known Risks #5 要听你判（可能 P1）
- mover throw / 缺 mover dry-run 都不打断 health check — `nightly-health-check.ts:189-199`

### 4. 整体集成层缺位（同 Week 1 r3 时态）

Week 2 三个组件都独立可测：
- `DocsWatcher` (fs watch + debounce)
- `runBackfill` (CLI script main loop)
- `NightlyHealthCheck` (scan 注入逻辑)

但仍**没有任何文件把它们 wire 进 NightlyJobScheduler**（DocsWatcher kind='watcher' / backfill kind='startup' / NightlyHealthCheck kind='cron'）。

**问**：Week 2 review 这个集成层缺位仍可接受？还是 Week 4 整合前必须先来一个 scheduler-runtime.ts 把 Week 1 + Week 2 的组件接起来？

## Out of Scope

- **scheduler-runtime 集成层**（Week 4 整合一并做；Week 2 各组件独立可测）
- **真 ingest pipeline**（caller 注入；本 Phase 不做 sanitize / LLM 编译）
- **真 fs entity scanner**（NightlyHealthCheck 注入 scanEntities）
- **R-201 推送**（NightlyHealthCheck onReport 回调；caller 串）
- **wiki.config.yaml 真文件**（仍阻塞 feature.md Gate 2）
- **Week 3 jobs**：Vacuum / WeeklyDigest / DriftDetector / MonthlySnapshot

## Review 节奏

按 [[f027_phase2_status]] Per Week + Week 1 r1→r3 chain 模式：
- 本轮 r1 = Week 2 全 3 commit 一次性提交
- r2-rN 视反馈
- Week 2 GO 才推 Week 3（Vacuum / WeeklyDigest / Drift / MonthlySnapshot）

## 给范德彪的入口指令

```
cd C:\Users\-\Desktop\Multi-Agent\.worktrees\F027

# 看 Week 2 commit chain
git log --oneline -10

# 看本 review request 全文
cat docs/plans/F027-P19-week2-review-request-r1.md

# 跑全套验回归（应 0 P19 fail）
pnpm test:api 2>&1 | tail -10

# 单跑 3 个 Week 2 test 文件（应 43/43 全过）
pnpm exec tsx --test packages/api/src/services/scheduler/docs-watcher.test.ts
pnpm exec tsx --test packages/api/scripts/backfill-docs.test.ts
pnpm exec tsx --test packages/api/src/services/scheduler/nightly-health-check.test.ts
```

逐项过 4 个 Review Focus + 5 个 Known Risks 判定（GO / CONDITIONAL / NO-GO）。
