# F027 → F028 Follow-up Backlog 【已弃用 · 2026-05-26 + final-vision r2 update】

> **DEPRECATED**: F028 概念未经合法立项 — 小孙 2026-05-26 拍板撤回；
> 本文档保留作历史归档，**不再被引用**（quickref/checklist 等已切到 RESIDUAL-DEBT）。
>
> **新真相源**: `F027-RESIDUAL-DEBT.md` — 19 项按三分类（A. 愿景未闭环 P4 内修 /
> B. V16.5 划走等新 feature / C. scheduler/UX 长尾单独立项）重新分类。
>
> 类别 A 5 项已在 P4-A1~A5 commit chain `bbb378c` / `bffa065` / `736590c` 实施。
>
> **final-vision r2 update (2026-05-27)**:
> - ~~F028-1 真 supersede / reject UI~~ → **已实施** (final-vision P1-1，commit `ebcc0ff`+`84f52d4`)：`DecisionSupersedeRejectModal` + `ledger.supersede/revoke` 后端分流。归 RESIDUAL-DEBT B8 已完成。
> - ~~F028-11 DocsWatcher.onEvent~~ → **已实施** (final-vision P1-2，commit `bfcbba2`+`227daf1`)：DocsIngestRunner 接 preview→commit pipeline + versioned `_auto/<stem>-<unixMs>.md`。归 RESIDUAL-DEBT C1.1 已完成。
> - 下文 backlog 仅作历史 reference，**不要按下文 F028-1/F028-11 当前待办处理**。

---

> **原真相源**: F027 Phase 4 plan v5 §1.1 Out of Scope + §6 O8 + 各源码内 `推 F028` 注释 (10 处, 见末尾)
> **原目的**: Phase 4 严守 O8 不蔓延; 此 backlog 记录所有"明示推 F028"的项, 供 F028 立项时直接 picking
> **建立时间**: Week 5 Day 22 (Phase 4 收稿阶段)

---

## 推 F028 项总览 (19 项)

> **Week 5 Day 23 hotfix b6ff088 后增 F028-11 ~ F028-19** — 见末尾 §E "scheduler 业务回调 8 项 + Phase 1 P7 漏接 1 项".
> 全量 audit: `.runtime/reviews/F027-NOOP-GAP-AUDIT.md`

| # | 项目 | 类别 | 来源 | F027 占位状态 | F028 立项工作量预估 |
|---|------|------|------|---------------|----------------------|
| **F028-1** | 真 supersede / reject UI (Inspector Coverage section) | 写型 UI | plan §1.1; prompt-inspector-tab.tsx:44-45,442 | Day 13 占位: click → window.alert | 1-2 周 (新 endpoint + DecisionRef→draftPath 映射 + Modal) |
| **F028-2** | 写型 rollback + RollbackPreviewModal (codex j2 r1 确认 scope) | 写型 backend + UI | plan §1.1 line 80; O5 拍 C; codex Week 5 j2 r1 P4-3 finding | Phase 4 不实施 (codex j2 r1 确认 RollbackPreviewModal + endpoint 都未实施 — 按 plan 允许推 F028) | 2 周 (CAS / lease / fencing / 二次审计 / wiki_events action='rollback' / 并发 promote 拒绝测试 + RollbackPreviewModal UI) |
| **F028-3** | composer slash menu 4 写命令启用 (`/promote` `/demote` `/series` `/rollback`) | UX evaluate | plan §1.1 line 81; §6 O8 | 4 items 已加但 disabled | 1 周 (evaluate "命令面板原意 V16.5 line 2539-2545 vs 右侧面板按钮入口" 用户偏好 → 启用 + UX 完善) |
| **F028-4** | promote-only memory_preflight | 写型 backend | plan §1.1 line 79; §6 O8 | 未实现 | 1-2 周 (V16.5 划走的 5 项之一) |
| **F028-5** | sessions ledger | 写型 backend | plan §1.1 line 79; §6 O8 | 未实现 | 1-2 周 (V16.5 划走的 5 项之一) |
| **F028-6** | Adaptive Recall Level 6 | 写型 backend | plan §1.1 line 79; §6 O8 | F027 Level 5 escalate 已落 (P3-9 c); Level 6 推 F028 | 1-2 周 (V16.5 划走的 5 项之一; 复用 Level 5 sink 模式) |
| **F028-7** | Prompt Inspector 升级 | UI | plan §1.1 line 79; §6 O8 | F027 Day 13 加了 Coverage 第 8 块占位 | 1 周 (V16.5 划走的 5 项之一; 具体升级点待 V16.5 line 重读) |
| **F028-8** | WarningsTab "解决" / 删除 / mark resolved 按钮 | 写型 UI | warnings-tab.tsx:24 | Day 17 仅 list 显示, 无操作按钮 | 1 周 (后端 endpoint + UI button + wiki_events action='warning_resolved') |
| **F028-9** | KB tab markdown 表格 entity-level parse | UI | wiki-meta.ts:23; codex Week 5 j2 r1 P4-9(b) finding | Day 17 仅 index .md path/title 显示; **multi-select 已在 commit 7603f35 实施** (KbDraftsSection 加入 + 行 [Promote] [Demote] + 顶部批量按钮); entity-level markdown 表格 row 解析未做 | 1 周 (parse markdown 表格 row → entity 列表; BatchPromoteModal 已挂 KB tab) |
| **F028-10** | EmbeddedWikiRecord boot load + 多房间并行 ingest 压测 | 性能/scale | production-recall-executor-deps.ts:36; plan §1.1 line 83 | Phase 4 单 R-001 房间 single record load | 2 周 (multi-room concurrency lease 测试 + EmbeddedWikiRecord cold-start load) |

---

## 推 F028 详情 (按来源分类)

### A. plan §1.1 Out of Scope (5 项明示)

```
F028 范围:
- promote-only memory_preflight    → F028-4
- sessions ledger                  → F028-5
- Adaptive Recall Level 6          → F028-6
- Prompt Inspector 升级            → F028-7
- 写型 rollback                    → F028-2
```

加上小孙 Q2 拍的:
- composer slash menu 4 写命令启用 → F028-3
- 多房间并行 ingest 压测 → F028-10 (后半)

### B. 源码 `推 F028` 注释 (5 处, 4 个 feature)

```
prompt-inspector-tab.tsx:44-45,442,447,473   → F028-1 (supersede/reject UI)
warnings-tab.tsx:24                          → F028-8 (warnings 解决按钮)
wiki-meta.ts:23                              → F028-9 (KB markdown entity parse; multi-select 已 commit 7603f35 落)
production-recall-executor-deps.ts:36        → F028-10 (前半: EmbeddedWikiRecord boot)
promote-modal.tsx:39                         → F028-3 (slash menu trigger 配合)
```

### D. codex Week 5 j2 r1 review 确认推 F028 (commit 7603f35 期间 scope 决策)

```
P4-3 (c) RollbackPreviewModal              → F028-2 (写型 rollback 一起做)
P4-9 (b) KB entity-level markdown parse    → F028-9 (multi-select 已实施 但 markdown 表格 entity 解析推后)
```

### C. plan §11 Phase 3 升 PASS 引用 (1 项)

```
AC-P3-8 b Inspector unresolved UI: Day 13 占位 click → alert; 真 supersede/reject UI 推 F028
```

即 F028-1, 已计。

---

## F028 立项优先级建议

```
P0 (核心写型功能, F027 留下硬阻塞):
- F028-1 supersede / reject UI       (Inspector Coverage 闭环)
- F028-2 写型 rollback              (rollback 不能 read-only forever)

P1 (V16.5 划走的 5 项):
- F028-4 memory_preflight
- F028-5 sessions ledger
- F028-6 Adaptive Recall Level 6
- F028-7 Prompt Inspector 升级

P2 (UX evaluate / 性能):
- F028-3 composer slash menu 4 写命令
- F028-8 WarningsTab 解决按钮
- F028-9 KB markdown parse + multi-select
- F028-10 多房间压测 + EmbeddedWikiRecord boot
```

F028 plan 立项时按此 backlog 拆 phase: P0 (2 项) → P1 (4 项) → P2 (4 项), 共 ~10-12 周。

---

## F027 Phase 4 严守 O8 已审视

per plan §6 O8 (line 283):
> F028 边界 严守不做; 命令面板 4 写命令 + 写型 rollback + memory_preflight / sessions ledger / Level 6 / Prompt Inspector 升级全部 F028

per plan §7 (line 293):
> F028 边界扯不清 风险: AC scope 蔓延 → O8 严守 + 任何"顺手"PR 必须升级小孙

Phase 4 Week 1-4 实施全程未越界 (源码 10 处 `推 F028` 注释全部为 placeholder + 注释, 无暗藏实现).

---

## 配套引用

- **Phase 3 升 PASS 矩阵**: `PHASE3_UPGRADE_MAPPING.md` (AC-P3-8 b 等条目引本 backlog)
- **plan**: `docs/plans/F027-phase4-implementation-plan.md` §1.1 / §6 O5 O8 / §7
- **V16.5 spec**: `docs/plans/V16.5-final.md` (line 2539-2545 命令面板原意; line 2563-2564 Series 字段)

---

## E. scheduler 业务回调 + Phase 1 P7 漏接 (Week 5 Day 23 实测发现, hotfix b6ff088 修了主因后)

> **触发**: 小孙浏览器实测 viewfinder=null + system prompt 空 → 全面 grep "noop" → 14 项 gap
> **本次修复**: 已修 #1 RoomCompiler noop + Phase 1 P7 message_commit_seq 漏接 (commit b6ff088)
> **本节列剩余 8 项推 F028**

### F028-11: DocsWatcher.onEvent 真业务接入
- **位置**: `scheduler-bootstrap.ts:148` `onEvent: async () => {}`
- **症状**: docs/features/* / docs/lessons/* / docs/bugReport/* 改动不自动触发 ingest pipeline
- **预算**: 0.5d — onEvent 内调 IngestService (sanitize + LLM 编译 + commit)
- **walkthrough 影响**: 场景 2 step 2.1 改 F999-test.md 自动 ingest, quickref 已说跳改用 draft-approval

### F028-12: NightlyHealthCheck.scanEntities 真 wiki 扫描
- **位置**: `scheduler-bootstrap.ts:154` `scanEntities: async () => []`
- **症状**: 每晚 4:00 cron 跑空 — 无 wiki entity 扫描 + chained_suspect / drift 检测
- **预算**: 1d — 扫 wiki/concepts/*.md + wiki/rules/*.md... 计 mtime / acl violation
- **影响**: 长期产生 warnings 缺失, 短期不阻塞

### F028-13: WeeklyDraftDigest.scanDrafts 真 draft 列表
- **位置**: `scheduler-bootstrap.ts:161` `scanDrafts: async () => []`
- **症状**: 每周一 9:00 cron 跑空 — 不推 weekly digest
- **预算**: 0.5d — 复用 GET /api/wiki/drafts query

### F028-14: DriftDetector.scanTriggers 真 trigger 扫描
- **位置**: `scheduler-bootstrap.ts:166` `scanTriggers: async () => []`
- **澄清**: 跟 viewfinder anti-drift jaccard 不同 — DriftDetector 是 V16.5 P19.11 (new_lesson / model_upgrade / handoff_failure 3 类 trigger 开 update draft); jaccard drift 已在 RoomCompiler 内 computeCoverage 跑 ✅
- **预算**: 1d — scanTriggers 扫 lessons/*.md 新加 + model_runtime 表升级 + a2a 失败 history

### F028-15: MonthlySnapshot.recompileAllRooms 全量重编
- **位置**: `scheduler-bootstrap.ts:171` `recompileAllRooms: async () => []`
- **症状**: 每月 1 号 3:00 cron 跑空 — 无 viewfinder drift backup + replace
- **预算**: 1d — 复用 ProductionRoomCompileExecutor + readFile current + diff drift ratio

### F028-16: ArchiveYearlySessions.scanSessions 年归档
- **位置**: `scheduler-bootstrap.ts:176` `scanSessions: async () => []`
- **症状**: 每年 1 月 1 日 cron 跑空 — 无 session yearly pack
- **预算**: 1d — scan 12 月前 session_groups → 写 yearly archive .md

### F028-17: WikiCompilerDebounce.recompileDerivedViews 派生视图重编
- **位置**: `scheduler-bootstrap.ts:181` `recompileDerivedViews: async () => {}`
- **症状**: wiki/concepts/*.md 写入后, wiki/index/concepts.md 派生视图不刷新 (V16.5 chap 22)
- **预算**: 1d — 写 wiki indexer 跑 markdown 表格 row 生成 index.md
- **影响**: KB tab 显示是 boot fixture 复制的, 之后 wiki 变化不刷新

### F028-18: ChainedAlertNotifier.pushAlert 推真 room
- **位置**: scheduler-bootstrap.ts 已实例化 ChainedAlertNotifier 但 `pushChainedAlert` 默认 undefined
- **症状**: chained_suspect 命中后 notifier noop, 不推 R-201
- **预算**: 0.5d — server.ts wire pushChainedAlert → broadcaster (扩 RealtimeServerEvent union 加 'wiki.chained_alert')

### F028-19: IngestService 接真 LLM compile pipeline
- **位置**: `ingest-preview.ts:11,18,94,192` `ingest-commit.ts:29`
- **症状**: preview 用 minimal stub markdown (sanitized + frontmatter, 无真 LLM 编译); commit 也不重新 LLM 编译
- **预算**: 1d — 接已有 `wiki/llm-compile/compile-pipeline.ts` (plan 提到但没 wire) + Sonnet/Haiku fallback runner
- **walkthrough 影响**: 场景 1 step 1.3 preview 是 stub 不是真 LLM 编译; 用户能跑流程但 LLM 编译内容简化

### F028 优先级 (新 9 项)

```
P0 (核心 spec gap, F027 留下硬阻塞):
- F028-1 supersede / reject UI         (Inspector Coverage 闭环)
- F028-2 写型 rollback                (rollback 不能 read-only forever)
- F028-19 IngestService LLM           (preview 是 stub 影响真 LLM 编译质量)

P1 (V16.5 划走 + scheduler 业务):
- F028-4 memory_preflight
- F028-5 sessions ledger
- F028-6 Adaptive Recall Level 6
- F028-7 Prompt Inspector 升级
- F028-11 DocsWatcher 真业务
- F028-12 NightlyHealthCheck 真扫描
- F028-14 DriftDetector 真 trigger 扫描
- F028-15 MonthlySnapshot 全量重编

P2 (UX evaluate + 长期):
- F028-3 composer slash menu 4 写命令
- F028-8 WarningsTab 解决按钮
- F028-9 KB markdown entity parse
- F028-10 多房间压测 + EmbeddedWikiRecord boot
- F028-13 WeeklyDraftDigest
- F028-16 ArchiveYearlySessions
- F028-17 WikiCompilerDebounce 派生视图
- F028-18 ChainedAlertNotifier broadcaster wire
```

总 19 项, 估 ~16-18 周 (4-5 个月 F028).
