# F027 Phase 4 — 整体收稿 (Week 5 Day 24)

> **真相源**: `docs/plans/F027-phase4-implementation-plan.md` v5
> **范围**: 8 AC (P4-1/2/3/4/5/6/8/9) — 主线 A 审批 UI (6 AC) + 主线 B go-live (3 AC), AC-P4-7 已取消
> **状态**: 代码 + 单测全完成, walkthrough + evidence pack 收稿期 (Week 5)
> **修订时间**: 2026-05-24 (Week 5 Day 22-24 收稿)

---

## 0. 一句话

Phase 4 把 F027 (统一记忆架构) 从 Phase 3 留下的 "approval 流闭环" 推到生产可用: PromoteModal/BatchPromoteModal 双 UI + V14 二次审计 + AdaptiveRecallCoordinator boot wire + Phase 1 表真数据 seed + Inspector Coverage 第 8 块 anti-drift. Week 5 Day 25 P4-A1~A6 完成 reader 侧愿景闭环（capability/handbook/handoff/RoomCompiler 3 文件 audit/追溯按钮扩接），撤 F028 概念，残债重新三分类（见 `evidence/phase4/F027-RESIDUAL-DEBT.md`）.

---

## 1. 8 AC 完成状态 (post-codex j2 重评 + Red→Green)

| AC | 标题 | 代码 | 单测 | walkthrough | judge1 | judge2 | 当前 verdict |
|---|---|---|---|---|---|---|---|
| AC-P4-1 | PromoteModal 流程 (V14 新实现) | ✅ | ✅ | ⏳ | CONDITIONAL_PASS | CONDITIONAL_PASS | CONDITIONAL_PASS |
| AC-P4-2 | 审计失败回退 (V14 reject) | ✅ | ✅ | ⏳ | CONDITIONAL_PASS | CONDITIONAL_PASS | CONDITIONAL_PASS |
| AC-P4-3 | 审批操作入口 (v2 重设计) | ✅+Demote 修 | ✅ | ⏳ | CONDITIONAL_PASS | r1=FAIL→r2 待 | CONDITIONAL_PASS (post-fix) |
| AC-P4-4 | 批量审批 (continue-on-error) | ✅+KB 接 | ✅ | ⏳ | CONDITIONAL_PASS | r1=FAIL→r2 待 | CONDITIONAL_PASS (post-fix) |
| AC-P4-5 | 三层验证套件 runner | ✅ | ✅ | n/a | PASS | PASS | PASS |
| AC-P4-6 | 手 walkthrough 三场景 | ✅ 脚本 | n/a | ⏳ | INCONCLUSIVE | INCONCLUSIVE | INCONCLUSIVE |
| AC-P4-8 | AdaptiveRecallCoordinator boot | ✅+Haiku+Broadcaster | ✅ | ⏳ boot log | CONDITIONAL_PASS | r1=FAIL→r2 待 | CONDITIONAL_PASS (post-fix) |
| AC-P4-9 | warnings + KB + Inspector + DB seed | ✅+KB multi-select | ✅ | ⏳ | CONDITIONAL_PASS | r1=FAIL→r2 待 | CONDITIONAL_PASS (post-fix) |

**测试统计**: 546/546 vitest + 2783/2792 node:test (含新 27 demote/runner/broadcaster) 全 PASS, 0 fail.

**升 PASS 条件**: codex j2 r2 重评 PASS/CONDITIONAL_PASS + walkthrough screenshots + 后端 logs → 全升 PASS.

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

- Day 21: evidence pack 8 AC 骨架 + placeholder result.json + §11 Phase 3 升 PASS 矩阵 (PHASE3_UPGRADE_MAPPING.md) — commit 464068e
- Day 22: F028 follow-up backlog (10 项 P0/P1/P2 分级) + judge1 (claude-opus-4-7) 8 AC 自评 — commit 464068e
- Day 23 a: judge2 (codex-gpt-5.4) 8 AC 独立评 — r1 verdict 4 FAIL (P4-3/4/8/9) — commit 7603f35 (j2 r1 落入 evidence)
- Day 23 b: codex j2 FAIL Red→Green 实施 (DemoteService + Haiku fallback + Broadcaster + KB tab 接入) — commit 7603f35
- Day 23 c: codex j2 r2 重评 4 修复 AC (in-flight, agent a6899678fcac5a3e7) → arbitration → result.json final
- Day 23 d: walkthrough 三场景 (小孙手动)
- Day 23 e: Phase 3 6 项 升 PASS (按 PHASE3_UPGRADE_MAPPING.md)
- Day 24: 合 dev (小孙物理操作, Iron Law 边界) + push origin + 整体签字

---

## 3. Codex review 历史

- Week 2 mid-r1 + end-r2: 全 reconcile
- Week 3 mid-r1 + end-r2 (047c948): 全 reconcile (含 CLI guard Windows + arbitration_verdict schema)
- Week 4 mid-r1 (a5963a4): 全 reconcile (含 metaWikiRoot prod 错配 + wiki_events warning_raised merge)
- Week 5 judge2 r1 + Red→Green (7603f35): 4 AC FAIL (P4-3/4/8/9) — Demote + Haiku fallback + Broadcaster + KB tab 接入 全 reconcile
- Week 5 judge2 r2 (待): 4 修复 AC 重评 → arbitration → result.json final

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
464068e docs(F027-P4): Week 5 Day 21-22 evidence pack 骨架 + judge1 8 AC + 收稿 doc
7603f35 fix(F027-P4): codex Week 5 j2 FAIL 4 项 Red→Green — Demote + Haiku fallback + Broadcaster + KB tab 接入
ab8c242 docs(F027-P4): Week 5 Day 23 j1 重评 + overview + F028 backlog 反映 j2 r1 + Red→Green
a5cd21b docs(F027-P4): Week 5 Day 23 codex j2 r2 + 8 AC result.json final verdict (consensus 一致)
b6ff088 fix(F027-P4): hotfix viewfinder=null + system prompt 空 — RoomCompile noop + message_commit_seq 链路全断接通
```

待 Week 5 Day 24 加 walkthrough screenshots 收稿 commit.

---

## 5. 残债重新分类（撤 F028，三分类生效 2026-05-26）

> Week 5 Day 25 小孙拍板撤 F028（未经合法立项）；原 19 项按真实归属重新分类。
> **新真相源**: `evidence/phase4/F027-RESIDUAL-DEBT.md`（替代 `F028-FOLLOWUP-BACKLOG.md`）

### 类别 A · 愿景未闭环 → P4 内修（5 项全做完，2026-05-26）

| # | 项 | V16.5 § | commit |
|---|------|---------|--------|
| A1 | capability_digest YAML caller 集成 | §13 | `bbb378c` |
| A2 | handbook H2 切片 caller 集成 | §27.4 + §4 | `bffa065` |
| A3 | handoffContext F026 EnvelopeBuilder | §4 line 422-431 | `bffa065` |
| A4 | RoomCompiler 3 文件全 audit | §5 + §8 | `736590c` |
| A5 | 追溯按钮扩 capability/handbook | §18 line 2078 | `736590c` |

### 类别 B · V16.5 划走（5 项，等新 feature 立项）

```
memory_preflight / sessions ledger / Adaptive Recall Level 6 / Prompt Inspector 升级 / 写型 rollback
```

### 类别 C · scheduler / UX 长尾（9 项，各自小孙拍单独立项）

```
scheduler noop 7 项（DocsWatcher / NightlyHealthCheck / WeeklyDraftDigest / DriftDetector /
                  MonthlySnapshot / ArchiveYearlySessions / WikiCompilerDebounce）
UX 4 项（slash menu 4 cmd / warnings 解决按钮 / KB markdown entity parse / EmbeddedWikiRecord 压测）
supersede/reject 写型 UI / recall-pack 追溯 audit schema 扩 / IngestService 真 LLM compile /
ChainedAlertNotifier broadcaster wire
```

详细每项 reference + 工作量 + commit 见 `F027-RESIDUAL-DEBT.md`.

---

## 6. Phase 3 升 PASS 矩阵

详见 `evidence/phase4/PHASE3_UPGRADE_MAPPING.md`. 6 项 CONDITIONAL_PASS 待 walkthrough 后逐项升:

```
AC-P3-1 拖宽 / AC-P3-2 5-tab scroll / AC-P3-3 inspector 7 块 / AC-P3-6 IngestModal 3 入口 / AC-P3-8 b Inspector unresolved UI / AC-P3-9 Adaptive Recall wiring
```

---

## 7. 合 dev 前最后 gate (Phase 4 终结条件)

per plan line 188:

- [x] 8 AC 代码完成 (含 codex j2 r1 FAIL 4 项 Red→Green 修)
- [x] 8 AC 单测 PASS (546/546 vitest + 2783/2792 node:test)
- [x] judge1 8 AC 自评完成 (第二轮 reflect Red→Green)
- [x] judge2 8 AC r1 评完成 (4 FAIL → 已 Red→Green)
- [ ] judge2 r2 重评 4 修复 AC (in-flight)
- [ ] judge1+judge2 不一致仲裁 (待 j2 r2)
- [ ] walkthrough 三场景小孙签字 (待小孙)
- [ ] Phase 3 6 项升 PASS (按矩阵)
- [ ] evidence pack 完整 (screenshots + logs 收齐)
- [ ] 合 dev + push (Iron Law 边界, 小孙手动)

---

## 8. 已知遗留

代码层 placeholder (设计内, 推 F028):

- Inspector Coverage UnresolvedRow click → window.alert (Day 13 占位, 真 supersede/reject UI 推 F028-1)
- RollbackPreviewModal **未实施** (写型 rollback 推 F028-2; codex j2 r1 提到, 我承认按 plan §1.1 line 80 允许推 F028)
- composer slash menu 4 写命令 disabled (推 F028-3 evaluate)
- WarningsTab 无"解决"按钮 (推 F028-8)
- KB tab markdown entity parse 未做 (multi-select 已做 满足 plan §AC-P4-9 b; entity parse 推 F028-9)
- **8 个 scheduler 业务回调 noop** (Week 5 Day 23 实测发现): DocsWatcher/NightlyHealthCheck/WeeklyDraftDigest/DriftDetector/MonthlySnapshot/ArchiveYearlySessions/WikiCompilerDebounce/ChainedAlertNotifier — 推 F028-11~18 (RoomCompiler 已修, 其他 8 项 cron job 不阻塞 walkthrough)
- **IngestService 用 stub LLM** (`ingest-preview.ts:192`) — 推 F028-19, 影响 walkthrough 场景 1 step 1.3 preview 是 minimal markdown 不是真 LLM 编译

测试层全绿, 无 skip/xfail. 无技术债.

---

## 9. 备注

- 跨 session 接力指南: `.runtime/reviews/F027-pending-walkthrough.md`
- judge2 prompt: `.runtime/reviews/F027-judge2-codex-prompt.md`
- Phase 1/2/3 evidence (历史): `docs/features/F027/evidence/phase{1,2,3}/`
- Phase 4 evidence (本期): `docs/features/F027/evidence/phase4/`
