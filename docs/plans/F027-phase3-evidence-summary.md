---
id: F027-phase3-evidence-summary
title: F027 Phase 3 evidence pack 收稿 — 10 AC double-pass (judge1 已写 + judge2 codex 跑中)
created: 2026-05-23
phase: F027 Phase 3 — 前端容器 + IngestModal + AC 闭环
plan: docs/plans/F027-phase3-implementation-plan.md（v3.5 frozen）
walkthrough: docs/plans/F027-phase3-walkthrough.md
---

# F027 Phase 3 Evidence Pack 收稿 (待 judge2 + arbitration + 小孙合 dev 拍)

**Branch / Worktree:** `feat/F027-unified-memory-architecture` @ `.worktrees/F027`
**Plan:** `docs/plans/F027-phase3-implementation-plan.md`（v3.5 frozen，含 v3.2 warnings/kb Phase 4 推迟 / v3.3 walkthrough not Playwright / v3.4 拖宽 max 1200 / v3.5 tab label 改名）

## 交付总览

Phase 3 = 前端 RuntimeLog 容器 + Inspector 数据 + IngestModal 3 入口 + viewfinder/wake click drawer + 调度器 go-live + ledger/recall/ingest 三 endpoint。

| Week | 内容 | review chain |
|---|---|---|
| 1 | backend HTTP API 层 (8 endpoint contracts + 4 真 endpoint + Iron Laws 3 fallback config) | P19/P20 Week 1 review GO |
| 2 | manual decision + recall wiring + ingest commit endpoint + scheduler go-live | Phase 3 Week 2 r3 GO |
| 3 | StatusPanel 拖宽 + RuntimeLog 5-tab 容器 + draft-approval/viewfinder/prompt-inspector tab | Day 11/12-13/14-15/16-17 r2 GO chain |
| 4 | IngestModal 3 入口 + composer 拖/slash + KB [+ Drop] + viewfinder/wake click drawer + label 改名 | Day 18/19a r2/19b/19c r2/20 r1 GO chain |
| 5 | Walkthrough script + Phase 2 evidence pack pattern 复用 + 双 judge (Playwright 推 Phase 4 — v3.3 patch) | 本文档 + judge2 codex 跑中 |

每 Week + 每 Day 走 requesting-review → 范德彪 code-review → receiving-review chain。范德彪 (Codex) 异构 reviewer.

## 实施规模

- **15 commits** in worktree branch (Day 16-17 至 Day 20 + 4 plan patches v3.2/3/4/5)
- 关键 commits:
  - `5a06a38` Day 16-17 viewfinder a2a 引用
  - `8c643cd` Day 16-17 r1 P3 fix
  - `d2d69d8` Day 18-19 draft-approval
  - `7c0c8e6` plan v3.2 warnings/kb Phase 4
  - `d372f6d` Day 18 r1 P3 (clock skew clamp)
  - `a9d90de` Day 19a IngestModal
  - `6921a27` Day 19a r2 (targetType + race + Escape)
  - `5d23538` Day 19b-1 KB tab
  - `32b538d` Day 19b-2 composer drop
  - `1d16bfe` Day 19c-1 slash menu
  - `a2b6e32` Day 19c-2 composer slash 集成
  - `0cd8aaa` Day 19c r2 (dismissedSlashKey + Enter/Tab preventDefault)
  - `c72a882` Day 20 click drawer
  - `f120101` Day 20 P3 pill click → store glue
  - `91df33d` v3.4 拖宽 max 1200 (小孙浏览器实测拍)
  - `55b587c` v3.5 tab label 改名 (小孙浏览器实测拍)
  - `b080d6a` plan v3.3 + walkthrough script

## 测试规模

- **frontend unit: 46 files / 484+ pass / 0 fail** (Phase 3 新增 ~+200 cases)
- 关键测试文件:
  - layout-store/resize-handle (拖宽 24)
  - runtime-log/index (5-tab 20)
  - ingest-modal/ingest-modal (15) + use-ingest-api (13)
  - composer (25) + composer-slash-menu (30)
  - a2a-drawer-store (4) + a2a-call-drawer (9)
  - knowledge-base-tab (9)
  - draft-approval-tab (12)
  - viewfinder-tab (12) + use-viewfinder-data (8)
  - prompt-inspector-tab (14)
- backend: Phase 3 endpoints 完整单测 (drafts/viewfinder/prompt-inspector/ingest-preview/ingest-commit/decisions)
- 0 Phase 3 回归

## review chain 汇总 (15 review verdicts all GO/CONDITIONAL→GO)

| review | verdict | notes |
|---|---|---|
| Day 11 r1 → r2 | GO | StatusPanel 拖宽 |
| Day 12-13 r1 CONDITIONAL → r2 | GO | always-render + ARIA keyboard |
| Day 14-15 r1 NO-GO → r2 | GO | API_BASE_URL + enabled wire |
| Day 16-17 r1 GO + P3 | GO | enabled wire 负 case 测试 |
| Day 18 r1 GO + P3 | GO | formatRelative clamp clock skew |
| Day 19a r1 NO-GO → r2 | GO | targetType + race + Escape |
| Day 19b r1 GO + P3 | GO (P3 在 19c-2 一并 fix) | composer mention/queue smoke |
| Day 19c r1 CONDITIONAL → r2 | GO | dismissedSlashKey + Enter/Tab preventDefault |
| Day 20 r1 GO + P3 | GO (P3 立即 fix f120101) | pill click → store glue |
| G1 r1 CONDITIONAL → r2 | GO | scenario 显式 + broadcast spy |
| Phase 3 Week 1 r1 | GO | backend HTTP API + contracts |
| Phase 3 Week 2 r1 NO-GO → r3 | GO | decisions + recall + ingest commit |
| Phase 3 P12.b r1 CONDITIONAL → r2 | GO | viewfinder 6 段语义二轮打磨 |
| Phase 1 Phase | (历史 commit ea773d9) | (前置) |
| Phase 2 Phase | (历史 commit 944b7b1 风) | (前置 11 jobs) |

## 10 AC double-pass 最终 verdict (judge1 + judge2 + arbitration 全 close)

每 AC 落点: `docs/features/F027/evidence/phase3/AC-P3-<N>/`
三件套: `result.json` + `judges/{judge1_claude-opus-4-7, judge2_codex-gpt-5.4, arbitration}.json` + `screenshots/`

**结果分布**: 4 PASS / 5 CONDITIONAL_PASS / 1 **FAIL**

| AC | j1 | j2 | arbitration | 备注 |
|---|---|---|---|---|
| AC-P3-1 拖宽 | PASS | CONDITIONAL_PASS | CONDITIONAL_PASS | browser fps + reload 像素 实测 BLOCKED |
| AC-P3-2 5 tab | PASS | CONDITIONAL_PASS | CONDITIONAL_PASS | browser scroll ±10px 实测 BLOCKED |
| AC-P3-3 inspector 7 块 | PASS | CONDITIONAL_PASS | CONDITIONAL_PASS | 真数据依赖 P3-9 + DB schema |
| AC-P3-4 viewfinder pill 点击 drawer | PASS | PASS | **✅ PASS** | Day 20 闭环 |
| AC-P3-5 wake-trigger pill 点击 drawer | PASS | PASS | **✅ PASS** | G1 + Day 14-15 + Day 20 闭环 |
| AC-P3-6 IngestModal 3 入口 | PASS | CONDITIONAL_PASS | CONDITIONAL_PASS | 3 入口 browser modal 实测 BLOCKED |
| AC-P3-7 调度器 go-live + Iron Laws 3 | PASS | PASS | **✅ PASS** | dev:api 启动 log 实证 |
| AC-P3-8 manual decision + Inspector unresolved | CONDITIONAL_PASS | CONDITIONAL_PASS | **⚠️ CONDITIONAL_PASS** | b Inspector unresolved UI 推 Phase 4 — 升级小孙拍 |
| AC-P3-9 Adaptive Recall wiring | CONDITIONAL_PASS | **FAIL** | **❌ FAIL** | server.ts line 239 用 noop coordinator, production wiring 未真接 — 升级小孙拍 |
| AC-P3-10 ingest commit endpoint | PASS | PASS | **✅ PASS** | backend + frontend 完整 |

## 升级小孙 3 件拍板 (Phase 3 合 dev 前必经)

### O1 AC-P3-9 FAIL 路径选 (重要)
**实证**: `packages/api/src/server.ts:239-242` 用 `createNoopAdaptiveRecallCoordinator()` 而非生产 `AdaptiveRecallCoordinator({enabled:true, executorDeps})`. 注释明示推 Phase 4. plan v3.1 §3 Week 2 Day 7-9 字面是 "production wiring", 与实施 gap.

- A: Phase 3 加 commit 改 server.ts 真接生产 coordinator (scope creep 大, critique LLM + level2-4 backend + Level5Sink 都是 Phase 4 deps, 假接也不行)
- B: 修 plan v3.6 patch — AC-P3-9 重写为 "ready-for-Phase-4 wiring (代码/接口/单测 ready, server.ts boot 推 Phase 4 接 critique LLM 后启用)" + 接受 CONDITIONAL_PASS (而非 FAIL)
- C: 维持 FAIL, 等 Phase 4 一并做 (诚实但 block 合 dev)

### O2 AC-P3-8 b 推 Phase 4 还是 Phase 3 补
feature.md line 184 字面 "Inspector unresolved 入口 UI click → manual confirm" Phase 3 必做。当前 prompt-inspector tab 7 块无 Coverage section。
- A: 加 Phase 3 commit 补 Coverage section (~30min, 单测可覆盖)
- B: 修 plan v3.6 patch 明示 b 推 Phase 4 + 接受 CONDITIONAL_PASS

### O3 5 个 CONDITIONAL_PASS (browser 实测 BLOCKED) 怎么走
AC-P3-1/2/3/6 + 部分 P3-10 浏览器实测项 BLOCKED. j2 严格不让 PASS-with-BLOCKED.
- A: 你抽 1-2h 跑 walkthrough script (浏览器实测 5 AC + 截图) + 我补 screenshots/ + arbitration 升 PASS — Phase 3 完美收口
- B: 接受 5 CONDITIONAL_PASS, 合 dev (浏览器真验等 Phase 4 与 worktree DB schema 一起做)

## 浏览器实测受限 — 跨 Phase 1 wiring 缺口

**worktree-preview DB (`.runtime/worktree-preview/data/multi-agent.sqlite`) schema 是 Phase 0 时代备份**:
- 缺表: `rooms`, `prompt_audit`, `wiki_events`, `wiki_leases`, `room_decisions`, `viewfinder_cache`
- 浏览器实测 P3-3/4/5/6/10 全 fall back 到 empty data (UI 渲染 placeholder)
- 这不是 Phase 3 bug — 是 worktree DB schema 缺 Phase 1 migration 跑 (dev branch 已合 Phase 1 commit ea773d9, 但 worktree DB 是历史备份)

**收口选项** (小孙 2026-05-23 已拍 walkthrough + 双 judge 路径, v3.3 patch):
- 浏览器实测项标 BLOCKED (合理 — 不阻 Phase 3 收口)
- Phase 4 与 worktree DB schema migration + Phase 1 wiring 真接通一起做完整端到端验

## Phase 3 收口前 2 个待小孙拍

### O1 AC-P3-8 b 推 Phase 4 还是 Phase 3 补?
feature.md line 184 字面 "Inspector unresolved 入口 UI click → manual confirm" 是 Phase 3 必做。
当前 prompt-inspector tab 7 块不含 Coverage warning section。
- 选项 A: 加 Phase 3 commit 补 Coverage section (~30min, 单测可覆盖)
- 选项 B: 修 plan v3.6 patch 明示 b 推 Phase 4 + 收口接受 CONDITIONAL_PASS

### O2 AC-P3-9 a/b/c wiring 状态明确
plan v3 line 103-106 列 Phase 3 Week 2 Day 7-9 做 a/b/c, 但 Phase 1 P13 commit ea773d9 已 done。
- 是 Phase 3 a/b/c 'fixture 验证' (不重做 backend wire) → 应该有 fixture test pass evidence
- 或 Phase 1 P13 已经端到端 wire 完 (a 真触发 + b 真写 + c Level5Sink) → Phase 3 a/b/c 是冗余 plan, 应在收口明示

## Phase 3 状态

代码本体 + 集成层 + plan v3.5 + walkthrough script + 10 AC evidence pack (judge1 完成, judge2 codex 跑中) 完成, commit 全程留在 worktree branch `feat/F027-unified-memory-architecture`.

**未合 dev**: feature 级合并需:
1. judge2 codex 跑完 (~5-10min) → 写 arbitration
2. 小孙拍 O1 + O2 决策
3. 小孙最终拍合 dev

按 feedback `feature_completion_before_merge`: feature 全 AC + worktree 验收 + 小孙拍合后才合 dev.
按 feedback `no_commit_review_docs`: review-request/confirmation md 不 commit, 写 .runtime/reviews/ scratch.
本 evidence summary md + result.json + judges/* 可 commit (evidence pack 是产物不是 review scratch).
