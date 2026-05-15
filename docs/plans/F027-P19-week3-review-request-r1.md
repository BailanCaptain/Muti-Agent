---
id: F027-P19-week3-review-r1
title: F027 Phase 2 Week 3（P19.9~P19.12）r1 review 请求
reviewer: 范德彪
requester: 黄仁勋
created: 2026-05-15
status: open
round: r1（Per Week 节奏；同 Week 1/2 r1→r3 chain 模式）
parent: F027-P19-week2-review-confirmation-r3
---

# F027 Phase 2 Week 3 r1 Review Request — Vacuum / Digest / Drift / Snapshot

**Feature:** F027 — `docs/features/F027-unified-memory-architecture.md`
**Plan:** `docs/plans/F027-phase2-implementation-plan.md`（v2b frozen）
**真相源:** V16.5 chap 5 line 519-524 (Vacuum) / chap 11 line 1186-1236 (Snapshot) / chap 17 line 1502-1515 (Drift) / line 2676 (Digest)
**Branch / Worktree:** `feat/F027-unified-memory-architecture` @ `.worktrees/F027`
**HEAD:** Week 3 Day 14-15 commit
**Parent (Week 2):** `docs/plans/F027-P19-week2-review-confirmation-r3.md`（你 r3 GO）

## What Changed

Week 3（5 天 / 4 个 P 阶段 / 4 个 AC）— 4 个数据维护 job：Vacuum / WeeklyDigest / DriftDetector / MonthlySnapshot。

| Day | Commit | P 阶段 | 文件 | 测试 | AC 覆盖 |
|---|---|---|---|---|---|
| 11 | `8eafcff` | P19.9 | `nightly-vacuum.ts/.test.ts` | 9 | AC-P2-11 (jsonl archive/snapshot + DB 不变) |
| 12 | `c421b40` | P19.10 | `weekly-draft-digest.ts/.test.ts` | 11 | AC-P2-12 (user-drop only + 4 类子目录不推) |
| 13 | `84b379a` | P19.11 | `drift-detector.ts/.test.ts` | 9 | AC-P2-13 (3 类 trigger → update draft) |
| 14-15 | (本 commit) | P19.12 | `monthly-snapshot.ts/.test.ts` | 16 | AC-P2-14 (backup + recompile + drift>30% replace + 幂等 + Jan-1 + 100k) |

**总规模**：4 src 文件 + 4 test 文件 / +45 new tests。
**Diff**：+约 1900 LOC（含测试）/ 0 删除既有功能。
**0 schema 改 / 0 enum 扩 / 0 wiki.config.yaml 创建**。

## Why

Plan §3 Week 3：4 个数据维护 job 都是"周期性后台 housekeeping"——比 Week 1 框架 / Week 2 watcher 更低耦合，各自独立。共同点：重活（DB scan / LLM recompile / fs backup）全部 caller 注入，本 Phase 只做调度逻辑壳。

V16.5 真相源对齐：
- chap 5:519-524 — Vacuum 30 天前 events compact + archive（plan §13 改 DB 表 → .runtime/ jsonl）
- chap 11:1202-1236 — MonthlySnapshot full recompile + drift>30% 自动 replace
- chap 17:1502-1515 — Drift Policy 3 类自动 trigger
- chap 17:2676 — WeeklyDraftDigest 只推 user-drop 顶层 draft

## Original Requirements

**小孙原话** (2026-05-15)：
> "不要停下来 直接做完 然后一直按照之前的流程走就行了 你发request 然后德彪加载code-review 然后你receive"

无 Open 决策，按 plan v2b 严格落地。

## Self-Check Evidence

**quality-gate**: ✅ PASS (2026-05-15)
- typecheck `pnpm --filter @multi-agent/api typecheck` → exit 0 ✅
- 全套 `pnpm test:api` → 2364 tests / 2355 pass / 8 skip / 1 todo / 0 fail（+45 new Week 3）
- 4 个 commit 全过 husky pre-commit gate
  - SessionTitler AC-06/AC-10/AC-14d 仍 50% 概率 flake → retry 模式（已 verify 不是 P19 引入；Week 1/2 已 flag）

**+45 new tests**：
```
nightly-vacuum.test.ts       9  (AC-P2-11)
weekly-draft-digest.test.ts  11 (AC-P2-12)
drift-detector.test.ts        9 (AC-P2-13)
monthly-snapshot.test.ts     16 (AC-P2-14)
```

**回归基线**：Week 2 收官 2310 → Week 3 收官 2364（+54：+45 Week 3 + 9 来自 dev 上其他 commit）。0 P19 回归。

**acceptance-guardian**: ⏭️ 跳过（同 Week 1/2，scheduler 业务层属测试基础设施类）

## Known Risks（5 个想听你判）

1. **NightlyVacuum 不删老数据 — archive 后 DB 行永久保留** — AC-P2-11 锁定"DB 不变"，我严格遵守（archive 是 copy 不是 move）。但语义上 wiki_events 会无限增长。**问**：这是设计意图（真清理是另一个独立人工决策）还是 Phase 2 该补一个"archive 后标记可清理"机制？看 `nightly-vacuum.ts` 注释 line 17-20。

2. **NightlyVacuum snapshot 按月切文件 → 同 path 跨月出现多次** — `.runtime/wiki-events-snapshot/<year>-<month>.jsonl` 每月一个文件；一个 path 在 4 月和 5 月都改过 → 4 月文件和 5 月文件都有它的条目。compiler 重放时需 load 全部 snapshot 文件取最新。**问**：这个 per-month 切分对 compiler replay 是否够用？还是需要一个"全局最新"merged snapshot？看 `nightly-vacuum.ts:128-157`。

3. **MonthlySnapshot drift 用 word-Jaccard 而非语义相似度** — `computeDrift` 是 word-set Jaccard 距离。措辞微调 drift 小（好），但"换了 5 个词但语义完全反转"（如否定句）Jaccard 也算小 drift → 漏判。**问**：30% 阈值 + word-Jaccard 够稳健吗？还是 MonthlySnapshot 该用 LLM 判语义 drift（成本高）？看 `monthly-snapshot.ts:202-226`。

4. **MonthlySnapshot backup 失败 → 跳过全部 replace** — backup 失败时我选 fail-safe：整轮不 replace（无回滚兜底不敢动）。**问**：这对吗？还是该"backup 失败但仍 replace（接受无回滚风险）"或"backup 失败 → 重试 N 次"？看 `monthly-snapshot.ts:92-110`。

5. **DriftDetector trigger 去重缺位** — `scanTriggers()` 每次返当前所有 trigger。若同一个 LL-031 连续两周都在 trigger 列表里（caller 没去重）→ 每周都开一个新 update draft → draft 泛滥。**问**：去重责任在 caller（scanTriggers 只返"未处理"的）还是 DriftDetector 该自己记已处理 trigger？看 `drift-detector.ts:84-100`。

## Review Focus（按 4 个新 AC 验证）

### 1. AC-P2-11 NightlyVacuum（最高优先级 — DB 安全）— `nightly-vacuum.ts`

- **DB 完全不变**：run() 前后 sqlite_master diff = ∅ + wiki_events 行数不变 — 测试 `nightly-vacuum.test.ts` "AC-P2-11" case
- archive：完整事件行 → `.runtime/wiki-events-archive/<year>/<month>.jsonl`
- snapshot：committed 事件按 path 取 last → `.runtime/wiki-events-snapshot/<year>-<month>.jsonl`
- 只读 SQL（SELECT only，绝无 DELETE/UPDATE）— 核 `nightly-vacuum.ts:99-104`
- atomic write (.tmp + rename)

### 2. AC-P2-12 WeeklyDraftDigest — `weekly-draft-digest.ts`

- 只推 user-drop 顶层 draft；4 类子目录（_auto/_backfill/_quarantined/_expired）不推
- `classifyDraftPath()` user-drop / subdir / non-draft 三分类
- 混合 5+4 fixture → digest 只含 5

### 3. AC-P2-13 DriftDetector — `drift-detector.ts`

- 3 类 trigger（new_lesson / model_upgrade / handoff_failure）→ buildUpdateDraft 映射
- openUpdateDraft throw → 落 failed 不打断
- Known Risks #5 trigger 去重要听你判

### 4. AC-P2-14 MonthlySnapshot — `monthly-snapshot.ts`

- backup → recompile → drift → replace 编排顺序
- drift > 30% replace / ≤ 30% 不 replace
- 幂等：第二次 recompile 一致 → drift 0 不再 replace
- Jan-1 边界：label 年首月
- 100k room mock pressure 线性时间
- backup 失败 fail-safe（Known Risks #4 要听你判）

### 5. 整体集成层缺位（同 Week 1/2 r3 时态）

Week 3 四个 job 全部独立可测，仍**没有 scheduler-runtime.ts wire**。Week 1/2 r3 时你已接受"集成层 Week 4 整合一并做"。**问**：Week 3 之后剩 Week 4（P19.13~P19.15 + evidence pack），集成层最迟必须 Week 4 补。这个时间点你认可吗？

## Out of Scope

- **scheduler-runtime 集成层**（Week 4 整合一并做）
- **真 DB scan / LLM recompile / fs backup**（caller 注入）
- **老数据真清理**（NightlyVacuum archive 后 DB 行保留 — 真删是独立人工决策）
- **wiki.config.yaml 真文件**（仍阻塞 feature.md Gate 2）
- **Week 4 jobs**：ArchiveYearlySessions / ChainedAlertNotifier / WikiCompilerDebounce + evidence pack

## Review 节奏

按 Week 1/2 r1→r3 chain 模式：本轮 r1 = Week 3 全 4 commit 一次性提交；r2-rN 视反馈；Week 3 GO 才推 Week 4。

## 给范德彪的入口指令

```
cd C:\Users\-\Desktop\Multi-Agent\.worktrees\F027

# 看 Week 3 commit chain
git log --oneline -10

# 看本 review request
cat docs/plans/F027-P19-week3-review-request-r1.md

# 跑全套验回归（应 0 P19 fail）
pnpm test:api 2>&1 | tail -10

# 单跑 4 个 Week 3 test 文件（应 45/45 全过）
pnpm exec tsx --test packages/api/src/services/scheduler/nightly-vacuum.test.ts
pnpm exec tsx --test packages/api/src/services/scheduler/weekly-draft-digest.test.ts
pnpm exec tsx --test packages/api/src/services/scheduler/drift-detector.test.ts
pnpm exec tsx --test packages/api/src/services/scheduler/monthly-snapshot.test.ts
```

逐项过 5 个 Review Focus + 5 个 Known Risks 判定（GO / CONDITIONAL / NO-GO）。
