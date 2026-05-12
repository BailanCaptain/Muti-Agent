---
id: F027
title: 统一记忆架构（V16.5 整套 · wiki entity + 派生视图 + 唯一注入合约 + 自动召回）
status: spec
owner: 黄仁勋
created: 2026-05-11
updated: 2026-05-11
plan_truth_source: docs/plans/V16.5-final.md
review_history:
  - V16.5: 范德彪 GO + 4 处实施侧硬约束 (F1-F5, 已 inline 进 V16.5.3)
  - V16.5.2: 小孙第一性原理重审 chap 18 (拆复用三层)
  - V16.5.3: 小孙 walkthrough 暴露 docs/* gap (加 cron docs-watcher + P6.5 backfill)
  - F027 v1: 范德彪 review GO with conditions (scope 自相矛盾)
  - F027 v2: 小孙戳穿 v1 拆分前提错误 → 整套立项不分批
---

# F027 — 统一记忆架构（V16.5 整套）

> **真相源**：`docs/plans/V16.5-final.md`（3300+ 行 self-contained spec）
>
> 本文件是**立项 spec**，不重复 V16.5 plan 内容——仅锚定立项要素（Why / What / AC / Phase / 工时 / 依赖 / Risk）+ 引用 V16.5 章节。
>
> **F027 = V16.5 整套**（不分 F027/F028）。原因详见末尾「F027 v1 → v2 reviewing 失误归档」段。

## Why

### R-201 痛点（小孙 117 条留言归类后剔除 A2A 部分）

V16.5 plan 章节 0 / chap 22 已系统化分析。核心 6 类**部分缓解**痛点（A2A 类 R-201 痛点已由 F026 944b7b1 解决，本 feature 解决其余）：

| 痛点 | 实证场景 | F027 对应解决 |
|---|---|---|
| **Agent 知识黑盒** | 新 agent 进新 room 完全白板，不知道项目历史 | memory_preflight 自动召回 + Adaptive Recall 5 级 fallback (V16.5 chap 10/12) |
| **小孙反复教 agent** | 同一 feedback 解释 N 次，agent 记不住 | 6 类记忆桶 + canonical_owner + supersedes 链 (chap 14) + agent-sessions ledger (chap 9) |
| **跨 session 决策漂移** | 100 次总结后 "lorry accident → bus explosion"（telephone game） | viewfinder anti-drift: decision ledger + tombstone + monthly recompile (chap 11) |
| **Prompt 注入冗余** | B022 修复 4 源 .md 冗余，但缺持续观测 | Prompt Inspector tab 实时显示注入 part + iron_laws_count (chap 18) |
| **docs/ 知识无法召回** | 几百份 docs/features / docs/lessons 不在 wiki | docs-watcher cron + backfill 脚本 (V16.5.3 D1+D2) |
| **拍板理由不可追溯** | 你 reject draft 的 reason 写完即丢 | wiki_events append-only + ACL + CAS + lease + fencing (chap 5) |

### 北极星

> **越用越好用，越用越聪明**：
> - 新 agent 进新 room 不再白板（自动召回项目历史 — memory_preflight 兑现）
> - 小孙不用反复教 agent（feedback 自动入 wiki，agent 自然引用 — Adaptive Recall + Quality Gate 兑现）
> - 跨 session 决策不漂移（decision ledger 锚定 — viewfinder anti-drift 兑现）
> - 错误模式不重复（LL-XXX 进 wiki，DriftDetector 主动告警 — DriftDetector cron 兑现）
> - **每一条北极星都对应 F027 内某一个 phase 的 AC，不依赖未来 feature**

## What

V16.5 plan 整套实施（V16.5 chap 21 列的 22+ phase / 9 个模块边界），**单一 F-id**。高层 4 大 Phase 划分仅作工程组织，**完整覆盖 V16.5 全部 phase + 全部 sub-feature 模块**。

### Phase 1 · 后端基础设施（V16.5 P0-P15 + P21）

**核心交付物**：
- 4 张新表：`wiki_events` / `wiki_memories` / `room_decisions` / `prompt_audit`
- 8 个新 service（含原 6 + memory_preflight + viewfinder anti-drift）：
  - `event-store.ts` (P1) / `compiler.ts` (P2) / `room-compiler.ts` (P7) / `acl.ts` (P3)
  - `sanitize-raw-drop.ts` (P4) / `system-prompt-assembler` 扩展 F004 (P5)
  - `memory-preflight.ts` (P11) ★ Quality Gate + Adaptive Recall 5 级 fallback (P13)
  - `viewfinder-compiler.ts` (P12) ★ decision ledger + tombstone + Decision Coverage Check
- 4 个新 MCP 工具：`update_wiki` / `read_wiki` / `search_wiki` / `query_messages` (FTS5, P14) — 全部挂 F023 mcp/server.ts
- LLM 编译 3 阶段（pre / compile / post）含 cross_refs 5 关系 + dedup 3 阈值 + canonical_owner 选择
- raw drop 5 层 sanitize + multi-drop cross-correlation (7 天滑动窗口)
- Agent Wiki Handbook 4 H2 切片 (compile-LLM / sanitize-LLM / agent runtime / dev human)
- agent-sessions ledger (per-agent S-XXXX.md + sharding + yearly pack, P8) ★
- alias-aware capability registry + handoff 中性改写 (P9)
- 6 类记忆 wiki_memories 表 + 防漂桶 lint (P10)
- BM25 search + LLM rerank (P15)

**引用 V16.5 章节**：3 / 4 / 5 / 6 / 7 / 8 / 9 / 10 / 11 / 12 / 13 / 14 / 15 / 26 / 27

### Phase 2 · 调度（V16.5 P19）

**核心交付物**：
- `NightlyJobScheduler` service + Leader Lease 共享
- 9 个 cron-scheduled jobs + 2 个 event-driven notifiers（V16.5.3 D1 升级版，对齐 plan chap 17 schedule 代码）：
  - **scheduled (9)**：StartupReconciler / RoomCompilerTick / **DocsWatcher** ★新 / NightlyHealthCheck / NightlyVacuum / WeeklyDraftDigest / DriftDetector / MonthlySnapshot / ArchiveYearlySessions
  - **event-driven (2)**：WikiCompilerDebounce (写后 5s) / ChainedAlertNotifier (实时)
- `wiki.config.yaml` 调度配置文件（**Iron Laws 3 涉及**：新增配置文件需 Round 2 安全 gate 批准）
- `scripts/backfill-docs.ts` 一次性 backfill 脚本（V16.5.3 P6.5）

**引用 V16.5 章节**：17 + V16.5.3 D1/D2/D3 修订段

### Phase 3 · 前端（V16.5 P20）

**核心交付物**：
- StatusPanel 拖宽（width state in layout-store + ResizeHandle）
- RuntimeLog 容器：1 级 tabs（system prompt + 日志）+ 2 级 tabs（5 tab）
- 5 个 tab 内容：
  - **viewfinder（取景器）**：6 段 reference-based 视图，§4 含 a2a 引用用 F026 `<AtPill>` / `<TimeoutTombstone>` 渲染（V16.5.2 三层复用决策）
  - **prompt-inspector（默认 tab）**：注入 part + token 占比 + **自动召回 query 列表 + Adaptive Recall Policy 状态** ★ + 🔔 wake-up 触发因 a2a_call=xxx（V16.5.2）
  - **draft-approval（审批待办）**
  - **warnings（警告）**
  - **knowledge-base（知识库）**：含 [+ Drop 资料] 按钮 → IngestModal
- IngestModal（3 个 drop 入口）+ composer 拖文件 + composer-slash-menu

**引用 V16.5 章节**：18 + 25

### Phase 4 · 审批 UI + 验证（V16.5 P20 + P18 + P22）

**核心交付物**：
- PromoteModal（draft 升正式 + reason 必填 + V14 二次审计反馈）
- `/promote` `/demote` `/series` `/rollback` 命令面板（composer-slash-menu 集成）
- 批量审批 UI：按 type / mtime / path 排序的 list view + 一键 promote 一组（共用 reason）
- 三层验证套件 + evidence pack + 异构双 judge (P18)
- 手 walk-through + evidence binding (P22)
- vacuum / snapshot / archive yearly (P22.5)

**引用 V16.5 章节**：18 PromoteModal + 25 命令面板 + 16 验证矩阵 + V16.5.3 D3 批量审批

## Acceptance Criteria

### Phase 1 AC（后端基础设施）

- [ ] **AC-P1-1 · 4 张新表 schema 通过 drizzle migration**：`wiki_events` / `wiki_memories` / `room_decisions` / `prompt_audit` 全部建表 + 索引 + 复合索引（V16.5.1 F3 实证：`drizzle-instance.ts:253-267` 必须显式建索引）+ EXPLAIN AC ≤ 50ms（fixture: viewfinder failed/timeout 查询 SQL，详见 V16.5 chap 11 F2 段）
- [ ] **AC-P1-2 · update_wiki MCP 工具 ACL/CAS/lease/fencing 全绿**：fuzz 100 并发写测试（同一 path 多 agent 同时写）通过率 100%（CAS 拒后重试），死锁 0 次，**evidence pack 含 race trace + 重试日志**
- [ ] **AC-P1-3 · LLM 编译 3 阶段端到端 PASS**（**fixture 锁定**）：
  - 输入 fixture: `tests/fixtures/wiki-ingest/rag-tutorial-input.md`（已锁定一篇 RAG paper, 23 KB）
  - 预期 top-5 相似（Phase 1）：`[F018:0.78, B022:0.65, Microcompact:0.52, L0-DIGEST:0.48, SessionBootstrap:0.45]` ±0.05 容差
  - 预期 schema-only JSON（Phase 2）：`tests/fixtures/wiki-ingest/rag-tutorial-expected.json` 含 `cross_refs[].relation ∈ {extends/supersedes/references/contradicts/implements}` 强制类型 / `dedup_decision.verdict ∈ {new_entity/merge_into/supersedes}` / `canonical_owner_suggestion ∈ {wiki/concepts/, wiki/rules/, wiki/methods/, wiki/people/}`
  - 预期 frontmatter fill 三段（Phase 3）：agent 写 3 字段 + LLM 输出 13 字段 + post derive 3 字段（共 19 字段，对账表见 plan chap 26.7）
  - 写 wiki_events action='ingest' + content_hash 比对 fixture 一致
- [ ] **AC-P1-4 · sanitize 5 层防御**（**fixture 锁定**）：5 层全部命中触发 fixture（`tests/fixtures/sanitize/L1-unicode.md` 同形字 / `L2-html.md` HTML 注释 / `L3-fence.md` fence role-token / `L4-base64.md` 高熵段 / `L5-multipass.md` chained-instruction）+ chained_suspect 进 `wiki/concepts/draft/_quarantined/`
- [ ] **AC-P1-5 · multi-drop cross-correlation**：7 天滑动窗口内同 series_id drop sim ≥ 0.8 自动归 series；不同 series 但 sim ≥ 0.7 触发 chained_suspect 警告（fixture: `tests/fixtures/multi-drop/series-vs-chained.md`）
- [ ] **AC-P1-6 · Agent Wiki Handbook 4 H2 切片 + cross-file dedupe**（**红绿样例锁定**）：
  - sliceHandbookByH2() 返回 4 个独立切片（`## 编译规则` / `## Sanitize 规则` / `## Agent 动作手册` / `## Dev / human 部分`）
  - cross-file dedupe lint 红样例：`tests/fixtures/lint/red-handbook-adds-at-rule.md`（handbook 加"@ 规则"段 → 跟 shared-rules 重叠 → lint 红灯）
  - cross-file dedupe lint 绿样例：`tests/fixtures/lint/green-cross-ref-only.md`（handbook 用 `[shared-rules.md § @ rule]` cross-ref 不复制 → lint 绿）
- [ ] **AC-P1-7 · 唯一注入合约**：扩展 F004 `assemblePrompt` 加 7 字段 + 5 注入区段；runtime 内 grep "Iron Laws" = 1（B022 防回归）；harness 端 grep ≤ 2（接受 CLI 边界）
- [ ] **AC-P1-8 · agent-sessions ledger**：per-agent S-XXXX.md 写入 + sharding（按 R-XXX 分目录 path: `agent-sessions/R-042/S-001-黄仁勋.md`）+ yearly pack 1/1 03:00 触发；fixture 模拟 100k session 文件归档后 active < 1k
- [ ] **AC-P1-9 · 6 类记忆桶物理表**：wiki_memories 5 type + messages 表 1 类 = 6 类全覆盖；canonical_owner 防漂桶 lint 红绿测试（fixture: `tests/fixtures/canonical-owner/red-drift.md` vs `green.md`）
- [ ] **AC-P1-10 · viewfinder anti-drift**（**漂移度阈值锁定**）：
  - room_decisions append-only + tombstone 字段
  - MonthlySnapshot full recompile 触发 → 漂移度 = `1 - jaccard(old.decisions_summary, new.decisions_summary)`
  - 漂移度 > 30% 自动 replace + 推审计通知到指定 room
  - fixture: `tests/fixtures/viewfinder-drift/100-iter-telephone-game.json` 模拟 100 次总结迭代，最终 jaccard ≥ 0.7（drift ≤ 30%）
- [ ] **AC-P1-11 · memory_preflight 自动召回**（北极星兑现 AC）★：
  - 新 agent 进 R-XXX wake-up 时 runtime 自动跑 memory_preflight
  - 提取 task summary 抽 2-5 query → vectorSearch + BM25 hybrid（chap 15 P15 复用 BM25）
  - Quality Gate：score ≥ 0.75 注入 prompt `[Recall Pack]` 区段 / 0.6-0.75 仅 Inspector 看 / < 0.6 丢
  - **fixture 锁定**：新 agent 桂芬第一次进 R-205 讨论 "F011 drizzle 优化" → 必须命中 `F011-backend-hardening-drizzle.md` (sim ≥ 0.85) + `F021-context-window-resolver.md` (sim ≥ 0.6) + Inspector 区列出至少 3 项中置信
  - **验收边界**（小孙 2026-05-12 拍 B 路径 + 范-r1 P2-4 同步）：
    - **P11.a baseline (本 phase)** 锁定：模块骨架 + Quality Gate + Hard Gate + AC 相对排序（F011 > F021 > B022），物理上 cosine baseline 单 vector 顶 ~0.5
    - **P11.b + P14 + P15 完成后转正**：sim ≥ 0.85 + ≥ 0.6 + ≥ 3 Inspector 项需 BM25 hybrid + LLM rerank 才能达，挂 it.todo 占位
- [ ] **AC-P1-12 · Adaptive Recall 5 级 fallback**：5 级 fallback 全部触发 fixture（Level 1 cache hit / Level 2 search_wiki / Level 3 LLM rerank / Level 4 hard gate / Level 5 escalate to user）+ Hard Gate 命中 escalate 写 wiki_events
- [ ] **AC-P1-13 · alias-aware capability registry**（**fixture 锁定**）：handoff 中性改写测试——sender alias 黄仁勋 → @桂芬 时，receiver 看到的 prompt 不暴露 sender risks
  - **fixture**: `tests/fixtures/capability-registry/red-leaks-sender-risk.json`（含未脱敏 prompt 含"黄仁勋 unresolved threads / 黄仁勋 token 占比 / sender 内部状态"等 forbidden strings）vs `green-neutralized.json`（中性改写后仅含 `{ task, receiver_capability_digest, collaboration_contract }` required fields）
  - **断言**：red fixture 必须命中 forbidden strings 至少 1 条 → 触发改写；green fixture 必须 0 命中 forbidden strings + 含全部 required fields
- [ ] **AC-P1-14 · evidence pack + 双 judge**：每个 AC 配 `docs/features/F027/evidence/phase1/<ac>/` 下 prompt.txt / agent_response.txt / db_dump.sql / wiki_state.tar.gz / config.hash / prod_config_diff.txt / result.json + judges/ 异构双 judge JSON（详见 plan chap 16 行 1680-1704）

### Phase 2 AC（调度）

- [ ] **AC-P2-1 · 9 scheduled + 2 event-driven jobs 全部就位**（**对齐 plan chap 17 行 1780-1788 schedule 代码**）：
  - **9 scheduled**：runtime 跑一周内 RoomCompilerTick (5min) / DocsWatcher (实时 watch) / NightlyHealthCheck (4:00) / NightlyVacuum (5:00) / WeeklyDraftDigest (周一 9:00) / DriftDetector (周一 10:00) / MonthlySnapshot (1 号 3:00) / ArchiveYearlySessions (1/1 3:00) / StartupReconciler (启动) 全部命中目标时间窗
  - **2 event-driven**：WikiCompilerDebounce (写 wiki_events 后 5s 触发派生视图重生成) + ChainedAlertNotifier (chained_suspect 命中后实时推 room)
  - evidence pack 含每 job trace log + 触发时间戳
- [ ] **AC-P2-2 · DocsWatcher 增量编译**（V16.5.3 D1）：手动 touch `docs/features/F999-test.md` → 60s debounce → ingest pipeline → 落 `wiki/concepts/draft/_auto/2026-XX-XX-F999-test.md` + 写 wiki_events
- [ ] **AC-P2-3 · backfill 脚本 dry-run 模式**（V16.5.3 D2）：`pnpm tsx scripts/backfill-docs.ts --dry-run` 输出 `docs/plans/V16.5-backfill-report-<date>.md`，含类型分布 + 高 cross_refs 密度 + 失败文件列表，**不写盘**
- [ ] **AC-P2-4 · backfill 正式跑 + resumable**：跑全部 docs/* 历史存量 → 落 `_backfill/` + 写 wiki_events；中途 kill -9 + `--resume` 跳过已成功文件（按 ingest_event_id 索引）
- [ ] **AC-P2-5 · Leader Lease**：模拟两个 runtime 实例同时跑 RoomCompilerTick，只有一个能 acquire lease，另一个 noop（DB 触发器拒绝 stale leader_term）

### Phase 3 AC（前端）

- [ ] **AC-P3-1 · StatusPanel 拖宽**（**性能阈值锁定**）：360-720px 范围内拖动 ≥ 50fps（Chrome DevTools Performance 实测）+ localStorage persist + reload 后宽度保留误差 ≤ 1px
- [ ] **AC-P3-2 · 5 个 tab 全部渲染 + 状态保持**（**断言锁定**）：viewfinder / prompt-inspector / draft-approval / warnings / knowledge-base 切换时 tab 内 fetch 状态保留（不重新 loading），用 Playwright 截图 + DOM 断言："切换前 tab 内 list scroll 位置在 reload 时 ±10px 内复现"+ 默认 tab = prompt-inspector
- [ ] **AC-P3-3 · prompt-inspector 透明显示**：注入的 part 表（含 token 占比）+ 未注入预期 part + Iron Laws 重复检测 + **自动召回 query 列表（含 Quality Gate 三段：高置信注入 / 中置信仅 Inspector / 低置信 reject）+ Adaptive Recall Policy 状态（recall_required / recall_path Level 1-5 / recall_satisfied）** ★
- [ ] **AC-P3-4 · viewfinder §4 a2a 状态人话化**（V16.5.2）：含 `[a2a_call=xxx]` 引用 → 用 F026 `<AtPill>` 渲染 + click pill in-place drawer 展开 mini call tree（不跳 /debug/a2a）
- [ ] **AC-P3-5 · prompt-inspector 顶部 wake-up 触发因**（V16.5.2）：显示 `🔔 触发因: [a2a_call=xxx]` + click 同样 in-place drawer
- [ ] **AC-P3-6 · IngestModal 3 入口 + sanitize 预扫**：composer 拖文件 / [+ Drop 资料] 按钮 / `/ingest` 命令面板三入口任一触发 → preview 显示 5 层 sanitize + LLM 编译预览 + multi-drop 关联 → 你点 [/ingest 编译] 才落盘

### Phase 4 AC（审批 UI + 验证）

- [ ] **AC-P4-1 · PromoteModal 流程**：选 target + 写 reason → POST `/api/wiki/drafts/<id>/promote` → V14 二次审计通过 → mv 到正式区 + 写 wiki_events action='promote'
- [ ] **AC-P4-2 · 审计失败回退**：tainted_source=true draft 二次审计 reject → modal 显示 audit_reason + 不 mv + 不写 promote event + draft 留原位
- [ ] **AC-P4-3 · 命令面板**：composer 输 `/` 弹下拉 → `/ingest` `/promote` `/demote` `/series` `/rollback` 全部可触发对应 modal / 命令
- [ ] **AC-P4-4 · 批量审批 UI**（**部分失败语义锁定**）：knowledge-base tab 加 [批量审批] → list view 按 type/mtime 排序 + 一键 promote 选中（共用 reason）；**部分失败行为**：每个 draft 独立 promote（一个失败不阻塞其他），最终弹出报告 modal 显示 `success: N / failed: M (含 audit_reason 列表)`，失败 draft 留原位等下次手动 retry
- [ ] **AC-P4-5 · 三层验证套件**（plan P18）：每个 AC 跑双 judge + 仲裁；OAuth quota 用尽 → BLOCKED（不再 SKIP=PASS）；evidence pack 不完整 → INCONCLUSIVE
- [ ] **AC-P4-6 · 手 walk-through**（plan P22）：你（小孙）按场景 1 / 场景 2 / 场景 3（V16.5 walkthrough 三场景）端到端走一遍；每场景独立 evidence

## Phase 拆分 + 工时

| Phase | V16.5 plan 章节 | 工时（单人天）| 依赖 | 多人并行 |
|---|---|---|---|---|
| **Phase 1 · 后端基础设施** | 3-15 + 26 + 27 | 30-45 | 无 | 内部 P0-P15 部分可并行（schema 冻结后）|
| **Phase 2 · 调度** | 17 + V16.5.3 D1/D2 | 5-7 | Phase 1 schema 冻结 | 与 Phase 3 并行 |
| **Phase 3 · 前端** | 18 + 25 | 12-15 | Phase 1 API contract 冻结 | 与 Phase 2 并行 |
| **Phase 4 · 审批 UI + 验证** | 18 PromoteModal + 16 验证 + 22 walkthrough | 11-13 | Phase 3 + Phase 1 evidence 框架 | - |
| **总工时** | | **58-80 单人天** | | **8-13 周（多 agent 并行）** |

**并行性说明**（修 v1 误判）：plan chap 21 依赖**不是**线性链。Phase 1 schema 冻结后，Phase 2 调度（lease + job harness）和 Phase 3 前端（UI shell + tab 容器 + StatusPanel resize）可同时启动；Phase 4 部分（评审 UI）依赖 Phase 3 前端骨架，但验证套件 P18 可在 Phase 1 evidence 框架冻结后并行准备。

## 复用 / 不复用决策

V16.5 chap 21 已对账 8+ 现有 feature：

| Feature | 复用方式 | 影响 |
|---|---|---|
| F004 assemblePrompt | ✅ **扩展现有函数**，加 7 字段 + 5 注入区段（不新建 assembleSystemPrompt）| Phase 1 P5 |
| F018 sanitizeHandoffBody | ✅ **借鉴设计模式**，新建 sanitize-raw-drop.ts（4 层 + multi-pass 第 5 层）| Phase 1 P4 |
| F018 embedding service | ✅ **直接调用** vectorSearch（B019 修复后真生效）| Phase 1 P4.6 + P11 + P15 |
| F018 SessionBootstrap | ✅ **扩展 7 区段框架**叠加 5 注入区段 | Phase 1 P3.6 |
| F018 TranscriptWriter | ✅ **扩展**为更广泛的 wiki_events 框架 | Phase 1 P7 |
| F018 recall_similar_context | ✅ **复用作召回后端** | Phase 1 P11 |
| F022 R-XXX namespace | ✅ **联动**作 wiki PK | Phase 1 P8 |
| F023 MCP server | ✅ **直接挂** update_wiki / read_wiki / search_wiki / query_messages 4 工具到 mcp/server.ts | Phase 1 P3 + P14 |
| F011 schema 风格 | ✅ **沿用** drizzle-orm 风格 | Phase 1 P0 |
| F011 messages + FTS5 | ✅ **复用**作 conversation 类记忆物理表 + query_messages MCP 来源 | Phase 1 P10 + P14 |
| F024 worktree port | ✅ **复用**作 worktree 起服务验收 | 全 phase |
| F026 后端接口 `/debug/a2a` | ✅ **强复用**作 viewfinder/prompt-inspector 数据源（V16.5.2）| Phase 3 |
| F026 前端组件 `<AtPill>`/`<TimeoutTombstone>`/`<A2ATreeView>` | ✅ **强复用**渲染（V16.5.2）| Phase 3 |
| F026 前端 page `app/debug/a2a/page.tsx` | ❌ **不复用**（dev tool UX 断层 + 数据滞后，V16.5.2 三层决策）| Phase 3 |
| F011 agent_events | ❌ **不复用**（语义不同，新建 wiki_events）| Phase 1 P1 |
| F011 session_memories | ❌ **不复用**（schema 不兼容，新建 wiki_memories）| Phase 1 P10 |
| F002 Decision Board | ❌ **不复用**（viewfinder anti-drift 独立实现，避免跨 feature 耦合）| Phase 1 P12 |
| F015 dispatch state | ❌ **不立项**（superseded by F026 I4）| - |
| shared-rules.md | ❌ **不拆**（保留作项目家规真相源，V16.4 决策）| - |

## Risk + 兜底

V16.5 chap 22 已系统化分析。F027 整套立项关注：

### 高风险

| 风险 | 兜底 |
|---|---|
| **LLM 编译质量漂移**（compile-LLM 模型升级 → cross_refs 关系判断变化）| 异构双 judge（chap 16）+ MonthlySnapshot 全量 recompile + DriftDetector |
| **draft 队列爆炸**（backfill 几百份 + 日常新增 → 你审批疲劳）| WeeklyDraftDigest 仅推 user-drop 主流（V16.5.3 D3 隔离 `_backfill/` `_auto/`）+ 30 天 TTL 自动 `_expired/` + 批量审批 UI（Phase 4）|
| **memory_preflight LLM 调用成本**（每 wake-up 2-5 query × Opus 4.7）| Quality Gate 控制（chap 10）+ 高置信 ≥0.75 才注入 + per-turn budget |
| **room_agent_sessions 文件膨胀**（10×100×100 = 100k）| sharding + yearly pack（chap 9）→ ~1k active |
| **F027 工期长（58-80 天单人）→ 期间无法并行其他 feature**| 多 agent 并行（黄/范/桂芬 拆 phase 同时干）→ 8-13 周；中间不允许 hotfix 偷渡（hotfix 走独立 worktree）|

### 中风险

viewfinder LLM 漂移 / lease 死锁 / 多 agent 并发 LLM API / token 超限 / BM25 中文分词 / cross-ref 解析失败 / FTS5 触发器同步漏 / sources 字段循环引用 / agent-capabilities 与实际能力 drift（V16.5 chap 22 兜底）

## 立项材料

- **F-id**: F027
- **优先级**: P0
- **worktree**: `feat/F027-unified-memory-architecture`
- **期间策略**: B022 当前 fix 保留；非紧急 feature 暂缓策略立项时拍
- **工期**: 58-80 单人天 / 8-13 周多 agent 并行
- **SOP**: `feat-lifecycle` skill

## Round 2 Approval（待拍）

### Gate 1 · 立项 GO
- [ ] 小孙拍板：F027 整套（V16.5 全 22+ phase 单 F-id）GO + 工时 58-80 接受
- [ ] 范德彪 verify F027 v2 spec（review F027 v1 已 GO with conditions, v2 修订是否覆盖原 4 条 conditions）

### Gate 2 · 配置 / MCP 安全授权（Iron Laws 3 联动）
- [ ] 小孙批准新增 `wiki.config.yaml` 配置文件（Iron Laws 3：`.env / MCP config / 运行时配置禁止修改` 涉及边界扩展）
- [ ] 小孙批准 4 个新 MCP 工具暴露集（update_wiki / read_wiki / search_wiki / query_messages）
- [ ] ACL dry-run 验收方式拍板：PR review + CI lint（plan chap 22 兜底机制）

### Gate 3 · Evidence Owner / Judge Quota
- [ ] evidence pack owner：黄仁勋（每 phase 落地后产出）
- [ ] 异构双 judge provider 拍板（建议：judge1 Anthropic Opus / judge2 OpenAI GPT-X，或其他配对）
- [ ] judge OAuth quota 用尽处理：BLOCKED（不再 SKIP=PASS, plan chap 16 行 1671）

### Gate 4 · Worktree
- [ ] worktree port：等 F024 worktree-port-registry 分配（不抢主库 :8787）

## 后续 follow-up（不在 F027 范围）

- **M8**：F026 cleanup 补 ADR-002/003 CI guard（V16.5 chap 0 V16.5 follow-up）
- **F5**：F026 加独立 cascade recovery job（V16.5 chap 0 V16.5.1 follow-up）

---

## F027 v1 → v2 reviewing 失误归档（不删原则 · 跟 V16.5.2 复盘段同款）

**v1 → v2 演进**：
- **v1**（2026-05-11 上午）：F027 拆为"第一批 4 phase + 第二批 F028"——把 memory_preflight / sessions ledger / viewfinder anti-drift / Adaptive Recall / Prompt Inspector 升级 5 项推到 F028。spec 内部矛盾：北极星写"新 agent 自动不白板"但 Phase 1 AC 无 memory_preflight，Why 引用这 5 项但 follow-up 又说 F028 做。
- **范德彪 review v1**：判 GO with conditions——4 处 conditions（最大 blocker：scope 自相矛盾要拍 F027/F028 边界；其他：5 个 AC 客观可测性 / Phase 并行性误判 / Round 2 gate 缺漏）。**但范默认拆分前提合理，给的解法是"逐项标 included/deferred/minimal only"**。
- **小孙戳穿前提**：问"这是 feature 工期问题还是路线问题？"——质疑了我和范都接受的"拆分合理"前提。我才回头看 V16.5 chap 23 line 2415 明明写"F0XX（待分配，**整套**）"，chap 21 sub-feature 表只是"模块拆分示意"不是"立项拆分"。
- **v2**（2026-05-11 下午）：F027 = V16.5 整套（不分 F027/F028）。所有 v1 的 spec 矛盾自动消失。

**两层失误**：
- **第一层**（写 v1 时）：把 V16.5 chap 21 的 sub-feature 表当成"立项分批"硬切。讽刺的是我之前回答小孙时**自己说过** "chap 21 命名是 plan 写作残留误导"——但写 spec 时还是被自己识别过的误导骗。
- **第二层**（读范 review 时）：范没有戳穿"拆分合理"前提，他默认拆分给"逐项标"的解法。我读完反应是"小孙拍 A/B"——接受了范的拆分前提。**没人去问"该不该拆分"**，直到小孙戳穿。

**教训**：propose / spec 写出后第一件事不是"找 review"，是"**先质疑自己的拆分前提**"。如果 spec 内部出现"X 进第一批"和"X 留 follow-up"同时存在，这不是 scope 待定，是**spec 抽象错了**。

**这是 reviewing 失误的第二次**（第一次：V16.5.2 chap 18 复用 /debug/a2a 拆三层。两次都是小孙戳穿）。两次失误共同模式：**接受错误前提下做精细化讨论**。归档此处作以后 propose / spec 抽象的镜子。

---

**最终归属**：F027 是 V16.5 plan 整套立项实施。spec 完整真相在 `docs/plans/V16.5-final.md`，本文件仅作 feat-lifecycle 立项 + AC + 工时锚定 + reviewing 失误归档。
