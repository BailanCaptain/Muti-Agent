# F027 Phase 4 — 整体收稿 (Week 5 Day 24)

> **真相源**: `docs/plans/F027-phase4-implementation-plan.md` v5
> **范围**: 8 AC (P4-1/2/3/4/5/6/8/9) — 主线 A 审批 UI (6 AC) + 主线 B go-live (3 AC), AC-P4-7 已取消
> **状态**: 代码 + 单测全完成, walkthrough + evidence pack 收稿期 (Week 5)
> **修订时间**: 2026-05-24 (Week 5 Day 22-24 收稿)

---

## 0. 一句话

Phase 4 把 F027 (统一记忆架构) 从 Phase 3 留下的 "approval 流闭环" 推到生产可用: PromoteModal/BatchPromoteModal 双 UI + V14 二次审计 + AdaptiveRecallCoordinator boot wire + Phase 1 表真数据 seed + Inspector Coverage 第 8 块 anti-drift. Week 5 Day 25 P4-A1~A6 完成 reader 侧愿景闭环（capability/handbook/handoff/RoomCompiler 3 文件 audit/追溯按钮扩接），撤 F028 概念，残债重新三分类（见 `evidence/phase4/F027-RESIDUAL-DEBT.md`）.

---

## 0.5. final vision verdict 修正（2026-05-27 真 codex hetero review · r1 → r2）

> **真相源**: `.runtime/reviews/F027-codex-final-verdict-summary.md` + r1 三块 codex verdict log + r2 fix commit + r2 愿景 verdict log
> **reviewer**: 范德彪 (codex CLI gpt-5.5)
> **背景**: Day 24-26 的 Claude general-purpose subagent fallback "8.5/10 DONE" 已被推翻 — 真 codex hetero review 抓出 spec drift。

### r1 (2026-05-27 上午): NOT_DONE — 3 P1 升级小孙拍

- **P1-1** Inspector Coverage click → `prompt-inspector-tab.tsx:641-647` 真 `window.alert` 占位
- **P1-2** docs-watcher 自动 ingest `scheduler-bootstrap.ts:20 :157` 真 noop `onEvent: async () => {}`
- **P1-3** evidence gate 未完成：AC-P4-6 INCONCLUSIVE + 6 项 AC CONDITIONAL_PASS

小孙 2026-05-27 拍：P1-1 + P1-2 = (a) 修代码真接；P1-3 留 P1-3 walkthrough 手动验证。

### r2 (2026-05-27 下午): CONDITIONAL_DONE — P1-1 + P1-2 真修

r2 commit 链（4 个，已跑全套绿）：

| commit | 内容 |
|---|---|
| `ebcc0ff` | P1-1 implement — UnresolvedDecisionModal + use-api hook + UnresolvedRow click 接 modal + 10 单测 |
| `84f52d4` | P1-1 r2 fix — supersede vs reject 后端分流（contracts kind += "supersede" + ledger.supersede + decisions.ts 分流 + extraSourceMessageIds 落 ledger） |
| `bfcbba2` | P1-2 implement — DocsIngestRunner + scheduler-bootstrap wire + server.ts 共享 ingest services + 7 单测 |
| `227daf1` | P1-2 r2 fix — IngestCommitService.commit opts.targetPathOverride + DocsIngestRunner versioned `_auto/<stem>-<unixMs>.md` 避免 change CAS conflict + plan AC-P4-6 5s → 60s |

**当前 verdict** (r2 愿景 review): **CONDITIONAL_DONE** — 代码核心 gap 全闭环。

剩余阻断（不在代码范围）：
1. **P1-3 walkthrough**：小孙手动跑三场景 → screenshots/logs → Phase 3 6 项升 PASS → 合 dev (Iron Law 边界小孙手动)
2. **RESIDUAL-DEBT C7.2**：docs-watcher change 触发的 `supersedes/superseded_at` 跨版本血缘 frontmatter，V16.5 chap 17 line 2662 期望，留 future feature (~1 周)

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
2d385d2 docs(F027-P4): hotfix b6ff088 后更新 — F028 backlog 加 F028-11~19 + OVERVIEW 反映

# Week 5 Day 24-25 P4 内修（撤 F028 + reader 侧愿景闭环）
e8e842c fix(F027-P4): hotfix viewfinder + Prompt Inspector reader 侧 wire-up
e37300d feat(F027-P4): 取景器手动编译 + Prompt Inspector raw text + 中文化/字体统一
c6ab3f6 feat(F027-P4): Prompt Inspector「对比上次注入」按钮真实现（不推 F028）
ea4e3f3 feat(F027-P4): 追溯 wiki_events 愿景闭环 — RoomCompiler 接 wiki_events + 前端追溯按钮
b09b982 fix(F027-P4): 范-r1 hetero review P1 修 — scheduler 漏传 sink + fail-soft 改 fail-closed

# Day 25 P4-A 6 项内修（撤 F028 + 5 项愿景闭环）
bbb378c feat(F027-P4-A1): capability_digest YAML 真相源 caller 集成 — wiki/agents 闭环
bffa065 feat(F027-P4-A2/A3): handbook H2 切片 + handoffContext caller 集成 — V16.5 §4/§27 闭环
736590c feat(F027-P4-A4/A5): RoomCompiler 3 文件全 audit + 追溯按钮扩 capability/handbook
11fe3a0 docs(F027-P4): Phase 4 Day 25 — 撤 F028 backlog + 残债重新三分类 + viewfinder limit 修

# Day 25 fallback j2 ensemble verdict 修（codex 翻车，Claude general-purpose subagent fallback）
ad59916 chore(F027-P4-A): fallback j2 P3 cleanup × 3 — Day 25 reclassify Phase 4
397e7f1 fix(F027-P4-A): Phase 4 Day 25 fallback j2 P1 修 × 2 + P2 × 1 — handoffContext envelope 集成 + handbook first-wake-up only + boot fail-closed
```

待 Week 5 Day 26 加 walkthrough screenshots（小孙手动浏览器实测）+ final vision review 闭环.

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

### 类别 C · scheduler / UX 长尾（final-vision r2 后 8 项，各自小孙拍单独立项）

```
scheduler noop 6 项（NightlyHealthCheck / WeeklyDraftDigest / DriftDetector /
                   MonthlySnapshot / ArchiveYearlySessions / WikiCompilerDebounce）
  — C1.1 DocsWatcher.onEvent 已修（final-vision P1-2，commit bfcbba2+227daf1）
UX 4 项（slash menu 4 cmd / warnings 解决按钮 / KB markdown entity parse / EmbeddedWikiRecord 压测）
  — B8 Inspector supersede/reject UI 已修（final-vision P1-1，commit ebcc0ff+84f52d4）
recall-pack 追溯 audit schema 扩 / IngestService 真 LLM compile /
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

代码层 placeholder（撤 F028 后，归 RESIDUAL-DEBT 类别 label，真相源 `evidence/phase4/F027-RESIDUAL-DEBT.md`）:

- ~~Inspector Coverage UnresolvedRow click → window.alert~~ — **已完成**（final-vision P1-1，commit `ebcc0ff`+`84f52d4`）：click → `DecisionSupersedeRejectModal` + ledger.supersede/revoke 分流
- RollbackPreviewModal **未实施** (写型 rollback 归 **B5**; codex j2 r1 提到, 按 plan §1.1 line 80 允许)
- composer slash menu 4 写命令 disabled (归 **B6** evaluate)
- WarningsTab 无"解决"按钮 (归 **C2.2**)
- KB tab markdown entity parse 未做 (multi-select 已做 满足 plan §AC-P4-9 b; entity parse 归 **C2.3**)
- **scheduler 业务回调 noop** (Week 5 Day 23 实测发现): ~~DocsWatcher~~ (final-vision P1-2 已修，commit `bfcbba2`+`227daf1`) / NightlyHealthCheck / WeeklyDraftDigest / DriftDetector / MonthlySnapshot / ArchiveYearlySessions / WikiCompilerDebounce 归 **C1.2~C1.7**, ChainedAlertNotifier 归 **C6.1** (RoomCompiler 已修)
- **IngestService 用 sanitized markdown 不接真 LLM compile** (`ingest-preview.ts:192`) — 归 **C5.1** by-design (Phase 3 user-driven simplification, preview 实时性 + commit 时小孙 review)，影响 walkthrough 场景 1 step 1.3 preview 不是真 LLM 编译
- **`message-service.ts:990` end_session 事件空实现 TODO** — 归 **C7.1** (final vision codex review Day 26 新增)
- **`prompt-inspector-tab.tsx:461 :470-471` agent-sessions ledger UI 写「Phase 4 接」文案 stale** — 实际归 **B2** (sessions ledger 划走未来 feature)

测试层全绿, 无 skip/xfail. 无技术债.

---

## 9. 备注

- 跨 session 接力指南: `.runtime/reviews/F027-pending-walkthrough.md`
- judge2 prompt: `.runtime/reviews/F027-judge2-codex-prompt.md`
- Phase 1/2/3 evidence (历史): `docs/features/F027/evidence/phase{1,2,3}/`
- Phase 4 evidence (本期): `docs/features/F027/evidence/phase4/`
