# F027 残债三分类（撤 F028 后重新分类）

> **真相源**: V16.5-final.md + F027 Phase 4 plan v5 §1.1 Out of Scope + 范-r1 sync codex review
> **撤 F028 决策**: 2026-05-26 小孙拍板 — F028 概念**未经合法立项**，撤回；原 F028-1~F028-19 19 项按真实归属重新分类
> **建立时间**: Week 5 Day 25 (P4-A6 收稿)
> **替代**: `F028-FOLLOWUP-BACKLOG.md`（保留作历史归档，不再被引用）
>
> **2026-06-15 收口刷新**（F027 标 done 时对账 `scheduler-bootstrap.ts:24-35` 头注释 + 代码实证）：
> C1 调度 noop 七项中**仅剩 C1.5 待武装**，其余六项已由 v3 G2 / final-vision / chunk B / 收尾修1 接通；
> C6.1 已接 ws broadcast；C7.2 体验目标已被收尾补丁 AC-W2 同源收敛取代。逐项见下表删除线标注。

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
| **A1** | capability_digest YAML 真相源 + caller 集成 | §13 line 1449-1476 | `bbb378c` | fallback j2 PASS |
| **A2** | handbook H2 切片 caller 集成（first wake-up only） | §27.4 + §4 line 365 | `bffa065` + `397e7f1` | fallback j2 P1.2 → 修后 PASS |
| **A3** | handoffContext F026 EnvelopeBuilder 集成（dispatch 路径） | §M1 line 422-431 + §13 | `bffa065` + `397e7f1` | fallback j2 P1.1 → 修后 PASS |
| **A4** | RoomCompiler 3 文件全 audit (decisions+log) | §5 line 452 + §8 line 533 | `736590c` | fallback j2 PASS |
| **A5** | 追溯按钮扩 capability/handbook 两 part | §18 line 2078 | `736590c` + `ad59916` | fallback j2 PASS |

**fallback j2 ensemble 抓出 2 个 P1 + 1 P2 + 3 P3 全修**（2026-05-26）:
- **P1.1** (`397e7f1`): handoffContext 改走 F026 envelope (dispatch.ts derive + 透传到 entry，message-service caller fallback) — V16.5 §M1 line 422-431
- **P1.2** (`397e7f1`): handbook 仅 first wake-up 注入 (thread.nativeSessionId === null 判定) — V16.5 §4 line 364-365
- **P2** (`397e7f1`): server.ts boot loader fail-soft → fail-closed + ENV opt-in `MULTI_AGENT_WIKI_LOADER_FAIL_SOFT=1` — V16.5 §4
- **P3 × 3** (`ad59916`): bottom 追溯按钮 F028 文案残留 / context-assembler 注释 misleading / RESIDUAL-DEBT 三分类边界（C2.1/C2.4/C3.1 上移到 B6/B7/B8）

**A5 不闭环子项**：recall-pack 追溯（动态 query 派生，需扩 audit schema 追 source_event_ids）→ 归 C 类长尾

**当前 P4 闭环度（修后双 fallback j2 对账）**: 9/10（5 项愿景核心全闭环 + 0 P1 + 0 未修 P2；剩 1 分扣点在 C 类长尾 6 项 + B 类划走 8 项）

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

### 类别 B 追加（2026-05-26 fallback j2 P3 finding 上移）

> 原归类别 C，按 plan §1.3 line 81-83 写的「推 F028 evaluate」语义跟「V16.5 划走」更接近，**P3 上移到 B**。

| # | 项目 | 工作量 |
|---|------|------|
| **B6** | composer slash menu 4 写命令启用（`/promote` `/demote` `/series` `/rollback`） | 1 周（B5 写型 rollback 做完才能 enable `/rollback`） |
| **B7** | EmbeddedWikiRecord boot load + 多房间并行 ingest 压测 | 2 周 |
| ~~**B8**~~ | ~~Inspector Coverage 真 supersede / reject UI（click → endpoint + Modal）~~ | **已完成** — 2026-05-27 final-vision P1-1 修（commit `ebcc0ff` + `84f52d4`）：`DecisionSupersedeRejectModal` + `ledger.supersede()` 分流 + click 接 modal |

---

## 类别 C · Scheduler / UX 长尾 - 单独立 feature（9 项）

> Phase 1-4 实施期 + Week 5 Day 23 实测发现的 noop / UI 长尾；
> 各项独立、互不阻塞、不影响 F027 愿景闭环。建议小孙按 priority 单独立项。

### C1 · scheduler 业务 noop（7 项，全在 `scheduler-bootstrap.ts`）

| # | noop 位置 | 症状 | 预算 |
|---|----------|------|------|
| ~~C1.1~~ | ~~`DocsWatcher.onEvent` (line 148)~~ | **已完成** — 2026-05-27 final-vision P1-2 修（commit `bfcbba2` + `227daf1`）：DocsIngestRunner 接 preview→commit pipeline + versioned `_auto/<stem>-<unixMs>.md` 避免 change CAS conflict + 默认 enable | n/a |
| ~~C1.2~~ | ~~`NightlyHealthCheck.scanEntities`~~ | **已完成** — v3 G2 接 `scanWikiEntitiesFs` 真扫描 + chunk B（R1 重复 canonical / R3 死 supersedes 治理搬 NHC）+ 续篇 warnings 文件生产链（报告落 `wiki/warnings/` 进「警告」tab） | n/a |
| ~~C1.3~~ | ~~`WeeklyDraftDigest.scanDrafts`~~ | **已完成** — v3 G2 接通 scanDrafts/pushDigest（scheduler-bootstrap.ts:28 头注释 ~~不接~~ 已划销） | n/a |
| ~~C1.4~~ | ~~`DriftDetector.scanTriggers`~~ | **已完成** — 2026-06-14 收尾修1（小孙 goal）：scanDriftTriggersDbDeduped 真扫 wiki_events+a2a_calls + openUpdateDraft 真开 `_auto/` draft 进审批队列 + drift 告警走现有「警告」tab（往 `wiki/warnings/` 写 warning，复用 NHC warnings 原语）。德彪 r1→r2 GO | n/a |
| C1.5 | `MonthlySnapshot.recompileAllRooms` | **小孙 2026-06-14 拍「先放着，下一轮专门做」**（收尾修2）。实测确认审计属实（recompiled===current → drift 恒 0）。设计 fork（下轮必读）：createViewfinderCompileFn 是增量编译+写 room_decisions 账本（铁律雷），出真 drift 信号需建 side-effect-free 探针（① 全量重编只读探针[推荐] / ② 轻量再渲染），auto-replace 默认 OFF 只出 dry-run 体检报告，backup 落 .runtime/snapshots，pushAudit 新 hook。MonthlySnapshot 类本身已全，只缺探针+4 hook 接线 | 1.5d |
| ~~C1.6~~ | ~~`ArchiveYearlySessions.scanSessions`~~ | **已完成** — v3 G2 接通（scheduler-bootstrap.ts:31 头注释 ~~不接~~ 已划销） | n/a |
| ~~C1.7~~ | ~~`WikiCompilerDebounce.recompileDerivedViews`~~ | **主体已完成** — B2/B1-c 接两件：① reindexWiki（wiki_entity_index FTS 增量重建 → search_wiki）② compileWiki 全局 markdown 索引（→ KB tab）。markdown 派生视图（index/sources/log 程序编）重生成仍 follow-up（独立 F-id，见 scheduler-bootstrap.ts:32-34） | n/a |

### C2 · UX 长尾（2 项；C2.1/C2.4/C3.1 已上移到类别 B — fallback j2 finding P3）

> **2026-05-26 fallback j2 finding**: C2.1 (composer slash menu) / C2.4 (多房间压测) / C3.1 (supersede/reject UI)
> 原 plan §1.3 line 81-83 写的是「推 F028 evaluate」语义，跟 V16.5/plan 明示划走更接近 —
> 归类别 B6/B7/B8 比 C 更准确（避免「实施期偶然 noop/UI 长尾」的误读）。

| # | 项 | 现状 | 预算 |
|---|------|------|------|
| C2.2 | WarningsTab "解决" / 删除按钮 | 当前仅 list, 无操作按钮 | 1 周 |
| C2.3 | KB tab markdown 表格 entity-level parse | 仅 index .md path/title 显示, entity row 解析未做 (multi-select UI 已落 commit 7603f35) | 1 周 |

### C4 · 推迟到追溯 audit schema 扩（1 项）

| # | 项 | 现状 | 预算 |
|---|------|------|------|
| C4.1 | recall-pack part 追溯 wiki_events（需扩 audit schema 追 source_event_ids） | P4-A5 显示 — 灰色（"动态派生 / prompt 自身，不支持追溯"） | 0.5 周（schema + UI） |

### C5 · IngestService LLM 真 compile pipeline（1 项）

| # | 项 | 现状 | 预算 |
|---|------|------|------|
| C5.1 | IngestService 接真 LLM compile（接 `wiki/llm-compile/compile-pipeline.ts` + Sonnet/Haiku fallback） | **Phase 3 user-driven simplification by design** — preview/commit 用 sanitized markdown 是性能选择（preview 实时性 + commit 时小孙 review 内容不需要 LLM 编译 schema-only JSON 多此一举）；未来 batch ingest / agent-initiated draft 才需要接 | 1 周 |

### C6 · ChainedAlertNotifier broadcaster wire（1 项）

| # | 项 | 现状 | 预算 |
|---|------|------|------|
| ~~C6.1~~ | ~~`pushChainedAlert` broadcaster wire~~ | **已完成** — ChainedAlertNotifier.pushAlert 已接 ws broadcast（scheduler-bootstrap.ts:35 头注释 ~~不接~~ 已划销） | n/a |

### C7 · 生产路径 TODO（2026-05-27 final vision codex review 新增）

| # | 项 | 现状 | 预算 |
|---|------|------|------|
| C7.1 | `packages/api/src/services/message-service.ts:990` `end_session` 事件空实现 TODO | live client event 分支，长期以 TODO 留生产路径 | 0.5 周 |
| C7.2 | docs-watcher `change` 触发的 supersedes/superseded_at frontmatter 写入 | **体验目标已被取代（降级低优）** — 收尾补丁 AC-W2（2026-06-12 `784b5de`）同源 _auto draft 自动收敛：旧 draft 物理归档 `_superseded/`、审批列表只见最新、TTL 排除，解决了「审两次」痛点。V16.5 chap 17 line 2662 的 frontmatter 血缘字段（supersedes/superseded_at）仍未写，仅剩元数据完整性价值 | 0.5 周 |

---

## 类别 D · 设计决策推后（不在 ABC 三分类内 — final vision r2 round 2 新增）

> **2026-05-26 fallback j2 r2 round 2 共识**：以下项目 by design 不接，不算缺；
> 区别于「未做」(类 A/C) 和「划走」(类 B)，标 D 显式记录 design 决策避免被未来 review 误判为 silent skip。

### D1 · update_wiki MCP 4 actions (patch/promote/demote/ingest) by design 不接

| 项 | 状态 | V16.5 reference |
|------|------|------|
| `packages/api/src/wiki/update-wiki-service.ts:240-252` 4 actions 返 `not_implemented` | by design | V16.5 §6 ACL + §17 一致性原则 |

**理由**：
- agent 不应自动 promote/demote/patch/ingest canonical wiki — 应 user-driven
- promote/demote 走 HTTP POST `/api/wiki/drafts/promote|demote` + PromoteWikiService/DemoteService + IngestModal UI（小孙审计 + 二次审计 + ledger）
- ingest 走 `IngestModal` 用户拖拽 raw → preview → commit 流程，不走 MCP
- patch 是 surgical edit 必须人工 — V16.5 §6 安全契约
- MCP path 暴露 promote/demote 会让 agent 绕过 user 审计直写 canonical wiki — 违反 V16.5 §17 一致性

**反对意见**：「MCP 通用 API 应支持所有 actions 让 future agent flow 可用」 — 拒绝；agent flow 应该走 HTTP route + UI gate，MCP 仅留 read/write/append 是 minimal viable surface。

### D2 · `rewriteHandoffForReceiver` 完整 4 字段 envelope production 0 caller（by design 留）

| 项 | 状态 | V16.5 reference |
|------|------|------|
| `packages/api/src/wiki/capability-registry/handoff-rewriter.ts:28` 完整 4 字段 envelope rewriter | spec-locked by test caller | V16.5 §M1 line 422-431 + §13 line 1481-1492 + ADR-003 |

**理由**：
- V16.5 §M1 line 422-431 明示 production 可简化 2 字段（receiverAlias + taskSummary）
- 4 字段 envelope（receiver_must_do / expected_evidence / do_not_section）是 ADR-003 反向路由复杂场景才需要
- 当前 A2A 路径不需要，但 `capability-registry.test.ts` 8 处 test caller + leak-detector e2e 覆盖 — **不是 dead code，是 spec-locked 测试覆盖**
- 未来 ADR-003 反向路由 enable 时 dispatch.ts 接通 rewriter 即可

**反对意见**：「YAGNI 删了」— 拒绝；删了未来 enable 反向路由还要重写 + leak-detection 风险。

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
