# F027 残债三分类（撤 F028 后重新分类）

> **真相源**: V16.5-final.md + F027 Phase 4 plan v5 §1.1 Out of Scope + 范-r1 sync codex review
> **撤 F028 决策**: 2026-05-26 小孙拍板 — F028 概念**未经合法立项**，撤回；原 F028-1~F028-19 19 项按真实归属重新分类
> **建立时间**: Week 5 Day 25 (P4-A6 收稿)
> **替代**: `F028-FOLLOWUP-BACKLOG.md`（保留作历史归档，不再被引用）

---

## 三分类口径

```
A. 愿景未闭环 - F027 内做完（P4 内修，本轮已实施）
   = V16.5 明示功能，Phase 1-3 缺接 → P4 内修补全 → 走范-r1 review

B. V16.5 划走 - 不在 F027 scope（plan §1.1 Out of Scope）
   = V16.5 spec 明示「划走给后续 feature」→ 等真新 feature 立项时再做

C. Scheduler/UX 长尾 - 单独立 feature 做（不归 F027）
   = Phase 1-4 实施期发现的 noop / UI 长尾 → 各自单独立项，节奏由小孙拍
```

---

## 类别 A · 愿景未闭环 → P4 内修（5 项全做完）

> 范-r1 sync codex review R1 CONDITIONAL 抓出 capability/handbook/handoff reader 侧断接；
> P4-A1~A5 5 项 P4 内修补全愿景闭环。

| # | 项目 | V16.5 §  | commit | review |
|---|------|---------|--------|--------|
| **A1** | capability_digest YAML 真相源 + caller 集成 | §13 line 1449-1476 | `bbb378c` | 范-r1 待 |
| **A2** | handbook H2 切片 caller 集成 | §27.4 + §4 line 365 | `bffa065` | 范-r1 待 |
| **A3** | handoffContext F026 EnvelopeBuilder 集成 | §4 line 422-431 + §13 中性改写 | `bffa065` | 范-r1 待 |
| **A4** | RoomCompiler 3 文件全 audit (decisions+log) | §5 line 452 + §8 line 533 | `736590c` | 范-r1 待 |
| **A5** | 追溯按钮扩 capability/handbook 两 part | §18 line 2078 | `736590c` | 范-r1 待 |

**A5 不闭环子项**：recall-pack 追溯（动态 query 派生，需扩 audit schema 追 source_event_ids）→ 归 C 类长尾

**当前 P4 闭环度估算（修后）**: ~9/10（5 项愿景全闭环 + 双 judge 已对账；剩 0.5-1 分扣点全在 V16.5 划走类 B + scheduler 长尾类 C）

---

## 类别 B · V16.5 划走 - 等新 feature 立项（5 项）

> plan §1.1 Out of Scope 明示，**V16.5 划走给后续 feature**，不归 F027；
> 等小孙立 F029 / F030 / ... 时按需 picking。

| # | 项目 | V16.5 reference | 工作量 |
|---|------|------|------|
| **B1** | promote-only memory_preflight | V16.5 §10 末段 "promote 触发的预加载" 未实施 | 1-2 周 |
| **B2** | sessions ledger | V16.5 §17 "session 全生命周期 ledger 表" | 1-2 周 |
| **B3** | Adaptive Recall Level 6 | V16.5 §10 5 级阶梯 → 6 级 (cross-room semantic) | 1-2 周 |
| **B4** | Prompt Inspector 升级（cap 显示 / token 真量 / diff 分屏） | V16.5 §18 line 2515 char/4 估算 → tiktoken 真量 | 1 周 |
| **B5** | 写型 rollback (CAS + lease + RollbackPreviewModal) | V16.5 §6 "promote/demote" 已实施；"rollback" 推后 | 2 周 |

**说明**: 这 5 项 V16.5 plan §1.1 line 79-80 明示「不在 F027 scope」，**不算 F027 愿景缺**。小孙立 F029/F030 时 picking 即可。

---

## 类别 C · Scheduler / UX 长尾 - 单独立 feature（9 项）

> Phase 1-4 实施期 + Week 5 Day 23 实测发现的 noop / UI 长尾；
> 各项独立、互不阻塞、不影响 F027 愿景闭环。建议小孙按 priority 单独立项。

### C1 · scheduler 业务 noop（7 项，全在 `scheduler-bootstrap.ts`）

| # | noop 位置 | 症状 | 预算 |
|---|----------|------|------|
| C1.1 | `DocsWatcher.onEvent` (line 148) | docs/ 改不触发 ingest pipeline | 0.5d |
| C1.2 | `NightlyHealthCheck.scanEntities` (line 154) | 每晚 4:00 cron 跑空 | 1d |
| C1.3 | `WeeklyDraftDigest.scanDrafts` (line 161) | 每周一 9:00 cron 跑空 | 0.5d |
| C1.4 | `DriftDetector.scanTriggers` (line 166) | V16.5 P19.11 trigger 不扫 | 1d |
| C1.5 | `MonthlySnapshot.recompileAllRooms` (line 171) | 每月 1 号 cron 跑空 | 1d |
| C1.6 | `ArchiveYearlySessions.scanSessions` (line 176) | 每年 cron 跑空 | 1d |
| C1.7 | `WikiCompilerDebounce.recompileDerivedViews` (line 181) | wiki/concepts/*.md 改后 index.md 不刷 | 1d |

### C2 · UX 长尾（4 项）

| # | 项 | 现状 | 预算 |
|---|------|------|------|
| C2.1 | composer slash menu 4 写命令启用（`/promote` `/demote` `/series` `/rollback`） | 4 items 已加但 disabled (B5 写型 rollback 完才能启用) | 1 周 |
| C2.2 | WarningsTab "解决" / 删除按钮 | 当前仅 list, 无操作按钮 | 1 周 |
| C2.3 | KB tab markdown 表格 entity-level parse | 仅 index .md path/title 显示, entity row 解析未做 (multi-select UI 已落 commit 7603f35) | 1 周 |
| C2.4 | EmbeddedWikiRecord boot load + 多房间并行 ingest 压测 | 单 R-001 single record load, 无 multi-room concurrency lease 测试 | 2 周 |

### C3 · supersede / reject 写型 UI（1 项）

| # | 项 | 现状 | 预算 |
|---|------|------|------|
| C3.1 | Inspector Coverage 真 supersede / reject UI（click → endpoint + Modal） | Day 13 占位: click → window.alert | 1-2 周 |

### C4 · 推迟到追溯 audit schema 扩（1 项）

| # | 项 | 现状 | 预算 |
|---|------|------|------|
| C4.1 | recall-pack part 追溯 wiki_events（需扩 audit schema 追 source_event_ids） | P4-A5 显示 — 灰色（"动态派生 / prompt 自身，不支持追溯"） | 0.5 周（schema + UI） |

### C5 · IngestService LLM 真 compile pipeline（1 项）

| # | 项 | 现状 | 预算 |
|---|------|------|------|
| C5.1 | IngestService 接真 LLM compile（接 `wiki/llm-compile/compile-pipeline.ts` + Sonnet/Haiku fallback） | preview/commit 用 minimal stub markdown，无真 LLM 编译 | 1 周 |

### C6 · ChainedAlertNotifier broadcaster wire（1 项）

| # | 项 | 现状 | 预算 |
|---|------|------|------|
| C6.1 | `pushChainedAlert` broadcaster wire（chained_suspect 推真 room R-201） | 已实例化 ChainedAlertNotifier 但 `pushChainedAlert` 默认 undefined | 0.5 周 |

---

## 撤 F028 决策的依据

**小孙 2026-05-26 拍板**：
> 「这是哪里蹦出来的 F028 我也没有决策过这个啊？？」
> 「重审 F027 是否真做完 — 类别 A 是 F027 愿景的核心，应该 P4 收尾内修，不算"推后"」

**根因**：黄仁勋（我）实施 Phase 4 收稿期间，把 capability/handbook/handoff/RoomCompiler/追溯按钮 5 项「reader 侧未接通」**自决推 F028**，但 F028 未经合法 plan 立项 — 实际是 P4 愿景未闭环硬阻塞，应当 P4 内修。

**纠正**：
1. 撤回 F028 概念（FOLLOWUP-BACKLOG.md 保留作历史归档但不再引用）
2. 5 项 P4 内修 = 类别 A（已实施 P4-A1~A5）
3. V16.5 明示划走 5 项 = 类别 B（等新 feature）
4. scheduler/UX 长尾 = 类别 C（各自小孙拍单独立项）

**未来 F029 / F030 / ...** 立项时直接 picking B + C，不需要 "F028" 这个虚假命名。

---

## 配套引用

- **范-r1 sync codex review 对账**: `.runtime/reviews/F027-P4-discussion-with-fan.md`
- **P4 hotfix walkthrough**: `.runtime/reviews/F027-P4-hotfix-walkthrough.md`
- **plan**: `docs/plans/F027-phase4-implementation-plan.md` §1.1 / §6 O5 O8
- **V16.5 spec**: `docs/plans/V16.5-final.md`
- **历史 F028 归档**: `F028-FOLLOWUP-BACKLOG.md`（不再引用）

---

## P4 内修对应 commit chain

```
ea4e3f3  P4 追溯 wiki_events 愿景闭环 — RoomCompiler 接 wiki_events + 前端追溯按钮（基础）
b09b982  P4 范-r1 hetero review P1 修 — scheduler 漏传 sink + fail-soft 改 fail-closed
bbb378c  P4-A1 capability_digest YAML 真相源 caller 集成
bffa065  P4-A2/A3 handbook H2 切片 + handoffContext caller 集成
736590c  P4-A4/A5 RoomCompiler 3 文件全 audit + 追溯按钮扩 capability/handbook
<本 commit>  P4-A6 撤 F028 backlog + RESIDUAL-DEBT 三分类
```
