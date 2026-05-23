# F027 Phase 4 — 整体收稿 (Week 5 Day 24)

> **真相源**: `docs/plans/F027-phase4-implementation-plan.md` v5
> **范围**: 8 AC (P4-1/2/3/4/5/6/8/9) — 主线 A 审批 UI (6 AC) + 主线 B go-live (3 AC), AC-P4-7 已取消
> **状态**: 代码 + 单测全完成, walkthrough + evidence pack 收稿期 (Week 5)
> **修订时间**: 2026-05-24 (Week 5 Day 22-24 收稿)

---

## 0. 一句话

Phase 4 把 F027 (统一记忆架构) 从 Phase 3 留下的 "approval 流闭环" 推到生产可用: PromoteModal/BatchPromoteModal 双 UI + V14 二次审计 + AdaptiveRecallCoordinator boot wire + Phase 1 表真数据 seed + Inspector Coverage 第 8 块 anti-drift. 留 10 项 F028 follow-up (见 evidence/phase4/F028-FOLLOWUP-BACKLOG.md).

---

## 1. 8 AC 完成状态

| AC | 标题 | 代码 | 单测 | walkthrough | judge1 | judge2 | 当前 verdict |
|---|---|---|---|---|---|---|---|
| AC-P4-1 | PromoteModal 流程 (V14 新实现) | ✅ | ✅ | ⏳ | CONDITIONAL_PASS | ⏳ | CONDITIONAL_PASS |
| AC-P4-2 | 审计失败回退 (V14 reject) | ✅ | ✅ | ⏳ | CONDITIONAL_PASS | ⏳ | CONDITIONAL_PASS |
| AC-P4-3 | 审批操作入口 (v2 重设计) | ✅ | ✅ | ⏳ | CONDITIONAL_PASS | ⏳ | CONDITIONAL_PASS |
| AC-P4-4 | 批量审批 (continue-on-error) | ✅ | ✅ | ⏳ | CONDITIONAL_PASS | ⏳ | CONDITIONAL_PASS |
| AC-P4-5 | 三层验证套件 runner | ✅ | ✅ | n/a | PASS | ⏳ | PASS (待 j2) |
| AC-P4-6 | 手 walkthrough 三场景 | ✅ 脚本 | n/a | ⏳ | INCONCLUSIVE | ⏳ | INCONCLUSIVE |
| AC-P4-8 | AdaptiveRecallCoordinator boot | ✅ | ✅ | ⏳ boot log | CONDITIONAL_PASS | ⏳ | CONDITIONAL_PASS |
| AC-P4-9 | warnings + KB + Inspector + DB seed | ✅ | ✅ | ⏳ | CONDITIONAL_PASS | ⏳ | CONDITIONAL_PASS |

**测试统计**: 539/539 vitest + 11+24+17 node:test 全 PASS.

**升 PASS 条件**: walkthrough screenshots + 后端 logs 收齐 → 8 AC 全升 PASS (除 AC-P4-6 自身就是 walkthrough).

---

## 2. 实施时间线 (Week 1-4 + 收稿 Week 5)

### Week 1 — go-live 后端基础设施 (Day 1-5)

- scheduler go-live (调度器接 production deps)
- DB seed loader (4 张 Phase 1 表 — concepts/rules/methods/rooms-active)
- 集成层 wiring

### Week 2 — 审批 UI 核心 (Day 6-10)

- V14PromoteAuditService 二次审计 3-step (imperative/prompt_structure/tainted_source_direct_quote)
- PromoteWikiService PREPARE+COMMIT pattern + lease try/finally
- PromoteModal 三 phase UI (compose/submitting/report)
- AC-P4-3 seriesId 透传链 (UI→Modal→Service→wiki_events)

### Week 3 — 批量 + Inspector Coverage + 验证套件 (Day 11-15)

- AC-P4-4 BatchPromoteService 串行 continue-on-error
- AC-P4-4 BatchPromoteModal 共用 reason + 报告 modal
- AC-P4-9 c Inspector Coverage section (V16.5 chap 11 jaccard 0.7 阈值)
- AC-P4-5 evidence runner (§12 schema validate + INCONCLUSIVE 规则 + BLOCKED 优先)

### Week 4 — warnings/KB fixture + walkthrough 三场景 (Day 16-20)

- AC-P4-9 a fixture seed (5 warnings .md + 4 index .md)
- AC-P4-9 a/b 派生 API (wiki-meta.ts WikiMetaScanner)
- AC-P4-9 a wiki_events action='warning_raised' merge (a5963a4 codex r1 fix)
- AC-P4-9 b WarningsTab + KnowledgeBaseTab 接真 fixture (替换 placeholder)
- server.ts:702 isWorktreePreview gate (codex r1 P1 fix)

### Week 5 — 收稿 (Day 21-24)

- Day 21: evidence pack 8 AC 骨架 + placeholder result.json + §11 Phase 3 升 PASS 矩阵 (PHASE3_UPGRADE_MAPPING.md)
- Day 22: F028 follow-up backlog (10 项 P0/P1/P2 分级) + judge1 (claude-opus-4-7) 8 AC 自评
- Day 23: judge2 (codex-gpt-5.4) 8 AC 独立评 + 不一致仲裁
- Day 23: walkthrough 三场景 (小孙手动)
- Day 23: Phase 3 6 项 升 PASS (按 PHASE3_UPGRADE_MAPPING.md)
- Day 24: 合 dev (小孙物理操作, Iron Law 边界) + push origin + 整体签字

---

## 3. Codex review 历史

- Week 2 mid-r1 + end-r2: 全 reconcile
- Week 3 mid-r1 + end-r2 (047c948): 全 reconcile (含 CLI guard Windows + arbitration_verdict schema)
- Week 4 mid-r1 (a5963a4): 全 reconcile (含 metaWikiRoot prod 错配 + wiki_events warning_raised merge)
- Week 5 (this): judge2 codex 独立评 8 AC (本次)

---

## 4. 关键 commit 链

```
817bc5c plan v5 起点
... Week 1-4 commit (详见 git log)
047c948 fix(F027-P4): codex end-r2 review 修 — 1 P1 CLI fail-open + 1 P2 arbitration_verdict schema 漏验
3a2d683 feat(F027-P4): Week 3 Day 14-15 AC-P4-5 三层验证套件 runner + artifact schema §12 + BLOCKED/INCONCLUSIVE 语义
12e6262 feat(F027-P4): Week 4 Day 16 AC-P4-9 a/b — wiki/{warnings,index} fixture seed + boot copier wire
1195217 feat(F027-P4): Week 4 Day 17 AC-P4-9 a/b 派生 API + tabs 接入真 fixture
a5963a4 fix(F027-P4): codex Week 4 mid-r1 review 修 — P1 metaWikiRoot prod 错配 + P2 wiki_events warning_raised merge
```

待 Week 5 Day 24 加 evidence pack + walkthrough 收稿 commit.

---

## 5. F028 follow-up (10 项)

详见 `evidence/phase4/F028-FOLLOWUP-BACKLOG.md`. 概要:

```
P0: F028-1 supersede/reject UI, F028-2 写型 rollback
P1: F028-4 memory_preflight, F028-5 sessions ledger, F028-6 Level 6, F028-7 Inspector 升级
P2: F028-3 slash menu 4 cmd, F028-8 warnings 解决按钮, F028-9 KB markdown parse, F028-10 多房间压测 + EmbeddedWikiRecord boot
```

---

## 6. Phase 3 升 PASS 矩阵

详见 `evidence/phase4/PHASE3_UPGRADE_MAPPING.md`. 6 项 CONDITIONAL_PASS 待 walkthrough 后逐项升:

```
AC-P3-1 拖宽 / AC-P3-2 5-tab scroll / AC-P3-3 inspector 7 块 / AC-P3-6 IngestModal 3 入口 / AC-P3-8 b Inspector unresolved UI / AC-P3-9 Adaptive Recall wiring
```

---

## 7. 合 dev 前最后 gate (Phase 4 终结条件)

per plan line 188:

- [x] 8 AC 代码完成
- [x] 8 AC 单测 PASS (539/539)
- [x] judge1 8 AC 自评完成
- [ ] judge2 8 AC 独立评完成 (此刻 codex 跑中)
- [ ] judge1+judge2 不一致仲裁
- [ ] walkthrough 三场景小孙签字 (待小孙)
- [ ] Phase 3 6 项升 PASS (按矩阵)
- [ ] evidence pack 完整 (screenshots + logs 收齐)
- [ ] 合 dev + push (Iron Law 边界, 小孙手动)

---

## 8. 已知遗留

代码层 placeholder (设计内, 推 F028):

- Inspector Coverage UnresolvedRow click → window.alert (Day 13 占位, 真 supersede/reject UI 推 F028-1)
- RollbackPreviewModal 只显示历史 + 不写盘 (写型 rollback 推 F028-2)
- composer slash menu 4 写命令 disabled (推 F028-3 evaluate)
- WarningsTab 无"解决"按钮 (推 F028-8)
- KB tab 仅 index .md path/title 显示 (markdown entity parse + multi-select 推 F028-9)

测试层全绿, 无 skip/xfail. 无技术债.

---

## 9. 备注

- 跨 session 接力指南: `.runtime/reviews/F027-pending-walkthrough.md`
- judge2 prompt: `.runtime/reviews/F027-judge2-codex-prompt.md`
- Phase 1/2/3 evidence (历史): `docs/features/F027/evidence/phase{1,2,3}/`
- Phase 4 evidence (本期): `docs/features/F027/evidence/phase4/`
