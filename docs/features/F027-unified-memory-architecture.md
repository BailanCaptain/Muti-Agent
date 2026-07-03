---
id: F027
title: 统一记忆架构（V16.5 整套 · wiki entity + 派生视图 + 唯一注入合约 + 自动召回）
status: done
owner: 黄仁勋
created: 2026-05-11
updated: 2026-06-15
completed: 2026-06-15
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

## 📂 F027 文档地图（2026-06-15 收口整合 · 唯一导航入口）

> 收口时删除了 9 篇过时的过程快照/评审往来文档 + 1 篇未跟踪 dry-run 报告（git 历史可查），只留最终版本。下表是全部存留 F027 文档。

**当前权威（读这两篇就够）**
- [`docs/plans/V16.5-final.md`](../plans/V16.5-final.md) — 3300+ 行 self-contained 设计真相源（27 章 spec）
- 本文件 — 立项 spec + AC 对账 + 收尾补丁记录 + 收口对账

**实施计划（历史存档 · 按 phase）**
- [`F027-phase1-implementation-plan.md`](../plans/F027-phase1-implementation-plan.md) — Phase 1 后端基础设施（19 子阶段 / 14 AC）
- [`F027-phase2-implementation-plan.md`](../plans/F027-phase2-implementation-plan.md) — Phase 2 调度（NightlyJobScheduler + 11 jobs，v2 冻结版）
- [`F027-phase3-implementation-plan.md`](../plans/F027-phase3-implementation-plan.md) — Phase 3 前端 5-tab + 调度器 go-live（v3.6）
- [`F027-phase4-implementation-plan.md`](../plans/F027-phase4-implementation-plan.md) — Phase 4 审批 UI + 验证收口（v1→v5）
- [`F027-P13-adaptive-recall-plan.md`](../plans/F027-P13-adaptive-recall-plan.md) — P13 自适应召回子计划（含小孙 5 拍板）

**Spec 补丁与残债（当前有效）**
- [`F027/F027-v3-PATCH.md`](F027/F027-v3-PATCH.md) — 2026-05-28 audit 12 gap（G1-G12）闭环记录
- [`F027/evidence/phase4/F027-RESIDUAL-DEBT.md`](F027/evidence/phase4/F027-RESIDUAL-DEBT.md) — 残债三分类（2026-06-15 已刷新至现状）

**验收证据（199 个 JSON · 异构双 judge）**
- `F027/evidence/phase{1,2,3,4}/<AC>/result.json + judges/` — 逐 AC 裁决 + judge1(Opus)/judge2(Codex) + 仲裁

**报告（历史存档）**
- [`V16.5-bm25-weight-tuning-report.md`](../plans/V16.5-bm25-weight-tuning-report.md) — BM25 nameWeight=5.0 调参依据

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

### Phase 3 · 前端 + P20 wiring（V16.5 P20）

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

- [x] **AC-P1-1 · 4 张新表 schema 通过 drizzle migration**：`wiki_events` / `wiki_memories` / `room_decisions` / `prompt_audit` 全部建表 + 索引 + 复合索引（V16.5.1 F3 实证：`drizzle-instance.ts:253-267` 必须显式建索引）+ EXPLAIN AC ≤ 50ms（fixture: viewfinder failed/timeout 查询 SQL，详见 V16.5 chap 11 F2 段）
- [x] **AC-P1-2 · update_wiki MCP 工具 ACL/CAS/lease/fencing 全绿**：fuzz 100 并发写测试（同一 path 多 agent 同时写）通过率 100%（CAS 拒后重试），死锁 0 次，**evidence pack 含 race trace + 重试日志**
- [x] **AC-P1-3 · LLM 编译 3 阶段端到端 PASS**（**fixture 锁定**）：
  - 输入 fixture: `tests/fixtures/wiki-ingest/rag-tutorial-input.md`（已锁定一篇 RAG paper, 23 KB）
  - 预期 top-5 相似（Phase 1）：`[F018:0.78, B022:0.65, Microcompact:0.52, L0-DIGEST:0.48, SessionBootstrap:0.45]` ±0.05 容差
  - 预期 schema-only JSON（Phase 2）：`tests/fixtures/wiki-ingest/rag-tutorial-expected.json` 含 `cross_refs[].relation ∈ {extends/supersedes/references/contradicts/implements}` 强制类型 / `dedup_decision.verdict ∈ {new_entity/merge_into/supersedes}` / `canonical_owner_suggestion ∈ {wiki/concepts/, wiki/rules/, wiki/methods/, wiki/people/}`
  - 预期 frontmatter fill 三段（Phase 3）：agent 写 3 字段 + LLM 输出 13 字段 + post derive 3 字段（共 19 字段，对账表见 plan chap 26.7）
  - 写 wiki_events action='ingest' + content_hash 比对 fixture 一致
- [x] **AC-P1-4 · sanitize 5 层防御**（**fixture 锁定**）：5 层全部命中触发 fixture（`tests/fixtures/sanitize/L1-unicode.md` 同形字 / `L2-html.md` HTML 注释 / `L3-fence.md` fence role-token / `L4-base64.md` 高熵段 / `L5-multipass.md` chained-instruction）+ chained_suspect 进 `wiki/concepts/draft/_quarantined/`
- [x] **AC-P1-5 · multi-drop cross-correlation**：7 天滑动窗口内同 series_id drop sim ≥ 0.8 自动归 series；不同 series 但 sim ≥ 0.7 触发 chained_suspect 警告（fixture: `tests/fixtures/multi-drop/series-vs-chained.md`）
- [x] **AC-P1-6 · Agent Wiki Handbook 4 H2 切片 + cross-file dedupe**（**红绿样例锁定**）：
  - sliceHandbookByH2() 返回 4 个独立切片（`## 编译规则` / `## Sanitize 规则` / `## Agent 动作手册` / `## Dev / human 部分`）
  - cross-file dedupe lint 红样例：`tests/fixtures/lint/red-handbook-adds-at-rule.md`（handbook 加"@ 规则"段 → 跟 shared-rules 重叠 → lint 红灯）
  - cross-file dedupe lint 绿样例：`tests/fixtures/lint/green-cross-ref-only.md`（handbook 用 `[shared-rules.md § @ rule]` cross-ref 不复制 → lint 绿）
- [x] **AC-P1-7 · 唯一注入合约**：扩展 F004 `assemblePrompt` 加 7 字段 + 5 注入区段；runtime 内 grep "Iron Laws" = 1（B022 防回归）；harness 端 grep ≤ 2（接受 CLI 边界）
- [x] **AC-P1-8 · agent-sessions ledger**：per-agent S-XXXX.md 写入 + sharding（按 R-XXX 分目录 path: `agent-sessions/R-042/S-001-黄仁勋.md`）+ yearly pack 1/1 03:00 触发；fixture 模拟 100k session 文件归档后 active < 1k
- [x] **AC-P1-9 · 6 类记忆桶物理表**：wiki_memories 5 type + messages 表 1 类 = 6 类全覆盖；canonical_owner 防漂桶 lint 红绿测试（fixture: `tests/fixtures/canonical-owner/red-drift.md` vs `green.md`）
- [x] **AC-P1-10 · viewfinder anti-drift**（**漂移度阈值锁定**）— ⚠️ **月度纠错触发器待武装（残债 C1.5，小孙 2026-06-14 拍下轮专做）**：Phase 1 范围（ledger CRUD + drift jaccard 算法 + fixture）达标；但「挂 Phase 2 P19」的 MonthlySnapshot full-recompile → auto-replace 闭环**生产空转**（2026-06-14 审计实测：`scanRoomViewfindersForSnapshot` MVP 透传 `recompiled===current` → drift 恒 0；未注入 `replaceViewfinder/pushAudit/backup`；活库 room_decisions 247 条全 active / tombstone=0 / superseded=0，纠错一次没跑过）。设计 fork（下轮必读：side-effect-free 探针不能碰 room_decisions 账本）见 `F027/evidence/phase4/F027-RESIDUAL-DEBT.md` C1.5。
  - room_decisions append-only + tombstone 字段 + revoke 纠错（写新行 + UPDATE 旧行 superseded_by）— ledger 原语 ✅；月度自动纠错触发器 ⏸️待武装
  - MonthlySnapshot full recompile 触发 → 漂移度 = `1 - jaccard(old.decisions_summary, new.decisions_summary)` — drift 算法 ✅；真重编探针 ⏸️待武装（现 recompiled===current 恒 0）
  - 漂移度 > 30% 自动 replace + 推审计通知到指定 room — ⏸️待武装（replaceViewfinder/pushAudit 未注入；auto-replace 默认 OFF 设计）
  - fixture: `tests/fixtures/viewfinder-drift/100-iter-telephone-game.json` 模拟 100 次总结迭代，**有 anti-drift 干预条件下**（每 10 iter MonthlySnapshot 检测，drift > 30% auto-replace） 最终 jaccard ≥ 0.7（drift ≤ 30%）；同 fixture 含 raw 100 iter（无干预）drift ≈ 0.6 对照组，证明 anti-drift 必需
  - **验收边界**（小孙 2026-05-13 拍 + 范-r3 CONDITIONAL 修后）：
    - **P12 Phase 1 范围**：决策 ledger CRUD（append/revoke/tombstone/queries）+ 关键词宽召 + HaikuRunner yes/no 精筛 + Coverage Check 三集合（broad/resolved/unresolved）+ viewfinder 6 段 rule-based 模板（small fans 拍：不上 LLM 编 viewfinder）+ jaccard drift 算法纯函数 + AC fixture
    - **挂 Phase 2 P19 调度** — ⏸️ **待武装（残债 C1.5）**：`runMonthlySnapshot(roomId)` 闭环触发（NightlyJob cron 1 号 03:00）+ auto-replace IO（写旧 viewfinder 到 audit + replace 新文件） + 审计通知 push —— cron 已注册但 `recompileAllRooms` 透传 current（drift 恒 0）、未注入 replaceViewfinder/pushAudit/backup，闭环未通；2026-06-14 小孙拍下轮独立做（side-effect-free 探针 + auto-replace 默认 OFF）
    - **挂 Phase 3 P20 前端**：manual confirm decision API (POST /api/rooms/:id/decisions) + Inspector 显示 Coverage warning unresolved 列表入口
    - **Phase 1 fixture 语义**：fixture `with_anti_drift_intervention` 段含 10 个 block intervention_log 模拟 MonthlySnapshot 检测+ reset 闭环；P19 完成后 fixture 应升级为接真 cron 跑（非模拟）
- [x] **AC-P1-11 · memory_preflight 自动召回**（北极星兑现 AC）★：
  - 新 agent 进 R-XXX wake-up 时 runtime 自动跑 memory_preflight
  - 提取 task summary 抽 2-5 query → vectorSearch + BM25 hybrid（chap 15 P15 复用 BM25）
  - Quality Gate：score ≥ 0.75 注入 prompt `[Recall Pack]` 区段 / 0.6-0.75 仅 Inspector 看 / < 0.6 丢
  - **fixture 锁定**：新 agent 桂芬第一次进 R-205 讨论 "F011 drizzle 优化" → 必须命中 `F011-backend-hardening-drizzle.md` (sim ≥ 0.85) + `F021-context-window-resolver.md` (sim ≥ 0.6) + Inspector 区列出至少 3 项中置信
  - **验收边界**（小孙 2026-05-12 拍 B 路径 + 范-r1 P2-4 同步 + 小孙/范-P11.b r1 2026-05-13 拍 Phase 2 依赖）：
    - **P11.a baseline 锁定**：模块骨架 + Quality Gate + Hard Gate + AC 相对排序（F011 > F021 > B022），物理上 cosine baseline 单 vector 顶 ~0.5
    - **P11.b 弱阈值锁定**：HybridSearchProvider 接 BM25 (P14) + cosine (F018 EmbeddingService) + LLM rerank stub (P15 NoopReranker) 框架成立；F011/F021 命中 + F011 排首位 + 总召回 ≥ 2 验证 hybrid 召回功能（`memory-preflight.test.ts:709`）
    - **AC-P1-11 严阈值挂 it.todo 等 Phase 2 真 LLM rerank confidence**：gate confidence ≥ 0.85 + gate confidence ≥ 0.6 + Inspector ≥ 3 物理依赖真 LLM rerank 输出 confidence score（plan chap 12 行 1403 "BM25 + LLM rerank" 原意）。Phase 1 NoopReranker 透传时 hybrid_score = max(bm25_norm, cosine_sim) 同时承担 ranking + gate 双职责，BM25 命中 entity 永远 score=1.0，inspector 中段 (0.6-0.85) 物理不可达。**不改 plan AC 阈值**——范判定"plan 隐含可校准置信度，改 ≥ 1 是验收漂移"。Phase 2 转正路径：接真 LLM rerank（Claude Haiku / Qwen / 本地 cross-encoder）→ 输出 confidence 但**默认未校准**（数字自评、logits、cross-encoder 分都不天然等价概率）→ 必须配 prompt schema + fixture 校准集 + 阈值回归测试，确认 confidence 落 plan 阈值区间后才转正（范-P11.b r2 Q4 修：原"自然落区间"是过度承诺）。同时类型层分离 ranking score vs gate score（范-P11.b r2 Q1：扩 RecallHit 加 rankScore/gateScore，或定义 reranker 覆写 score 后 score === gate confidence）
- [x] **AC-P1-12 · Adaptive Recall 5 级 fallback**（**对齐 V16.5 chap 12 行 1398-1410 阶梯**）：5 级 fallback 全部触发 fixture（Level 1 task_memory_pack / Level 2 search_wiki BM25+rerank / Level 3 query_messages FTS5 / Level 4 read_wiki strict path / Level 5 escalate）+ Hard Gate 命中 escalate Sink 被调用
  - **AC 文字修订**（小孙 2026-05-14 拍 + P13 实施核对 V16.5 chap 12）：原文 "Level 3 LLM rerank" 与 chap 12 行 1402-1406 阶梯对照应为 "Level 3 query_messages FTS5"（LLM rerank 是 Level 2 search_wiki 的一部分，不是独立级）
  - **验收边界**（小孙 2026-05-13 拍 5 个 Open + P13.4 设计核对）：
    - **P13 Phase 1 范围**：AdaptiveRecallExecutor 状态机 + Critique Agent (Sonnet 4.6 LlmCritiqueAgent) + 4 个 Level Backend Adapter（MessagesFtsLevel3Backend / FileSystemLevel4Backend + Level2/5 接口）+ Per-turn Budget 强制 + Judge BLOCKED lint + 防 hallucination 校验（next_level / specific_path）+ 55 单测全绿
    - **挂 Phase 3 P20 wiring**：(a) orchestrator / RoomCompiler 接 executeAdaptiveRecall 调用点；(b) prompt_audit 表 recall_path / recall_satisfied / escalate_reason 等 9 字段真写入；(c) Level5Sink 生产实现（写 wiki_events action='recall_escalate' / 推审计通知 / Inspector UI 显示）— **P13 模块设计上不绑定具体 audit 后端**（避免 library import db/fencing 逻辑），caller 责任
    - **Phase 1 fixture 语义**：P13 单测端到端验证算法正确性（含真 SQLite FTS5 + 真文件 IO + 状态机 + budget 触顶 + critique 防 hallucination），生产 observability（prompt_audit 行数 / wiki_events trace）属 Phase 3 P20 wiring 验收
    - **依赖确认**：P14.b messages_fts + query_messages MCP (f91edf5) 已 done，P13.3 Level 3 直接复用
- [x] **AC-P1-13 · alias-aware capability registry**（**fixture 锁定**）：handoff 中性改写测试——sender alias 黄仁勋 → @桂芬 时，receiver 看到的 prompt 不暴露 sender risks
  - **fixture**: `tests/fixtures/capability-registry/red-leaks-sender-risk.json`（含未脱敏 prompt 含"黄仁勋 unresolved threads / 黄仁勋 token 占比 / sender 内部状态"等 forbidden strings）vs `green-neutralized.json`（中性改写后仅含 `{ task, receiver_capability_digest, collaboration_contract }` required fields）
  - **断言**：red fixture 必须命中 forbidden strings 至少 1 条 → 触发改写；green fixture 必须 0 命中 forbidden strings + 含全部 required fields
- [x] **AC-P1-14 · evidence pack + 双 judge**：每个 AC 配 `docs/features/F027/evidence/phase1/<ac>/` 下 prompt.txt / agent_response.txt / db_dump.sql / wiki_state.tar.gz / config.hash / prod_config_diff.txt / result.json + judges/ 异构双 judge JSON（详见 plan chap 16 行 1680-1704）

### Phase 2 AC（调度）

- [x] **AC-P2-1 · 9 scheduled + 2 event-driven jobs 全部就位**（**对齐 plan chap 17 行 1780-1788 schedule 代码**）：
  - **9 scheduled**：runtime 跑一周内 RoomCompilerTick (5min) / DocsWatcher (实时 watch) / NightlyHealthCheck (4:00) / NightlyVacuum (5:00) / WeeklyDraftDigest (周一 9:00) / DriftDetector (周一 10:00) / MonthlySnapshot (1 号 3:00) / ArchiveYearlySessions (1/1 3:00) / StartupReconciler (启动) 全部命中目标时间窗
  - **2 event-driven**：WikiCompilerDebounce (写 wiki_events 后 5s 触发派生视图重生成) + ChainedAlertNotifier (chained_suspect 命中后实时推 room)
  - evidence pack 含每 job trace log + 触发时间戳
- [x] **AC-P2-2 · DocsWatcher 增量编译**（V16.5.3 D1）：手动 touch `docs/features/F999-test.md` → 60s debounce → ingest pipeline → 落 `wiki/concepts/draft/_auto/2026-XX-XX-F999-test.md` + 写 wiki_events
- [x] **AC-P2-3 · backfill 脚本 dry-run 模式**（V16.5.3 D2）：`pnpm tsx scripts/backfill-docs.ts --dry-run` 输出 `docs/plans/V16.5-backfill-report-<date>.md`，含类型分布 + 高 cross_refs 密度 + 失败文件列表，**不写盘**
- [x] **AC-P2-4 · backfill 正式跑 + resumable**（2026-06-11 全量真跑 55/55 落 `_backfill/`；resumable 子断言未单独实测——dry-run→真跑分两轮完成）：跑全部 docs/* 历史存量 → 落 `_backfill/` + 写 wiki_events；中途 kill -9 + `--resume` 跳过已成功文件（按 ingest_event_id 索引）
- [x] **AC-P2-5 · Leader Lease**：模拟两个 runtime 实例同时跑 RoomCompilerTick，只有一个能 acquire lease，另一个 noop（DB 触发器拒绝 stale leader_term）

### Phase 3 AC（前端）

- [x] **AC-P3-1 · StatusPanel 拖宽**（**性能阈值锁定**）：360-720px 范围内拖动 ≥ 50fps（Chrome DevTools Performance 实测）+ localStorage persist + reload 后宽度保留误差 ≤ 1px
- [x] **AC-P3-2 · 5 个 tab 全部渲染 + 状态保持**（**断言锁定**）：viewfinder / prompt-inspector / draft-approval / warnings / knowledge-base 切换时 tab 内 fetch 状态保留（不重新 loading），用 Playwright 截图 + DOM 断言："切换前 tab 内 list scroll 位置在 reload 时 ±10px 内复现"+ 默认 tab = prompt-inspector
- [x] **AC-P3-3 · prompt-inspector 透明显示**：注入的 part 表（含 token 占比）+ 未注入预期 part + Iron Laws 重复检测 + **自动召回 query 列表（含 Quality Gate 三段：高置信注入 / 中置信仅 Inspector / 低置信 reject）+ Adaptive Recall Policy 状态（recall_required / recall_path Level 1-5 / recall_satisfied）** ★
- [x] **AC-P3-4 · viewfinder §4 a2a 状态人话化**（V16.5.2）：含 `[a2a_call=xxx]` 引用 → 用 F026 `<AtPill>` 渲染 + click pill in-place drawer 展开 mini call tree（不跳 /debug/a2a）
- [x] **AC-P3-5 · prompt-inspector 顶部 wake-up 触发因**（V16.5.2）：显示 `🔔 触发因: [a2a_call=xxx]` + click 同样 in-place drawer
- [x] **AC-P3-6 · IngestModal 3 入口 + sanitize 预扫**：composer 拖文件 / [+ Drop 资料] 按钮 / `/ingest` 命令面板三入口任一触发 → preview 显示 5 层 sanitize + LLM 编译预览 + multi-drop 关联 → 你点 [/ingest 编译] 才落盘（**commit 路径走 AC-P3-10**）
- [x] **AC-P3-7 · 调度器 go-live + Iron Laws 3 边界**（F027 Phase 3 plan v2/v3 新增）：API server 启动 → `SchedulerRuntime` 实例化 + 11 job 注册 + 真 job_trace 落 `.runtime/job-traces/`；**Iron Laws 3 负断言**：不存在/不创建/不写入 `wiki.config.yaml`；fallback config 来源可观测；Gate 2 未批准时真配置路径保持 BLOCKED（集成测试 + 文件系统断言）
- [x] **AC-P3-8 · manual confirm decision API + Inspector unresolved 入口**（F027 Phase 3 plan v3 新增 — 接 AC-P1-10 P20 wiring 挂位）：POST `/api/rooms/:id/decisions` + prompt-inspector Coverage warning unresolved 列表 UI 点击 → manual confirm 写新行；Phase 1 P12 ledger append-only + tombstone 语义不变
- [x] **AC-P3-9 · Adaptive Recall production wiring**（F027 Phase 3 plan v3 新增 — 接 AC-P1-12 P20 wiring 挂位）：(a) orchestrator / RoomCompiler 实际调用 `executeAdaptiveRecall`；(b) `prompt_audit` 表 9 字段真写入（recall_path / recall_satisfied / escalate_reason 等）fixture 验证；(c) Level5Sink 生产实现（写 `wiki_events` action='recall_escalate' + 推审计通知 + Inspector UI 显示）
- [x] **AC-P3-10 · IngestModal commit endpoint 落盘闭环**（F027 Phase 3 plan v3 新增 — 修 AC-P3-6 闭环）：POST `/api/wiki/ingest/commit` endpoint，前端 [/ingest 编译] → 后端复用 Phase 1 `update_wiki`，含 ACL / CAS / lease / fencing；E2E：preview 不落盘 / commit 才落盘 / 失败不产生 `wiki_events`

### Phase 4 AC（审批 UI + 验证）

- [x] **AC-P4-1 · PromoteModal 流程**：选 target + 写 reason → POST `/api/wiki/drafts/<id>/promote` → V14 二次审计通过 → mv 到正式区 + 写 wiki_events action='promote'
- [x] **AC-P4-2 · 审计失败回退**：tainted_source=true draft 二次审计 reject → modal 显示 audit_reason + 不 mv + 不写 promote event + draft 留原位
- [ ] **AC-P4-3 · 命令面板**：composer 输 `/` 弹下拉 → `/ingest` `/promote` `/demote` `/series` `/rollback` 全部可触发对应 modal / 命令
- [x] **AC-P4-4 · 批量审批 UI**（**部分失败语义锁定**）：knowledge-base tab 加 [批量审批] → list view 按 type/mtime 排序 + 一键 promote 选中（共用 reason）；**部分失败行为**：每个 draft 独立 promote（一个失败不阻塞其他），最终弹出报告 modal 显示 `success: N / failed: M (含 audit_reason 列表)`，失败 draft 留原位等下次手动 retry
- [x] **AC-P4-5 · 三层验证套件**（plan P18）：每个 AC 跑双 judge + 仲裁；OAuth quota 用尽 → BLOCKED（不再 SKIP=PASS）；evidence pack 不完整 → INCONCLUSIVE
- [ ] **AC-P4-6 · 手 walk-through**（plan P22）：你（小孙）按场景 1 / 场景 2 / 场景 3（V16.5 walkthrough 三场景）端到端走一遍；每场景独立 evidence

## Phase 拆分 + 工时

| Phase | V16.5 plan 章节 | 工时（单人天）| 依赖 | 多人并行 |
|---|---|---|---|---|
| **Phase 1 · 后端基础设施** | 3-15 + 26 + 27 | 30-45 | 无 | 内部 P0-P15 部分可并行（schema 冻结后）|
| **Phase 2 · 调度** | 17 + V16.5.3 D1/D2 | 5-7 | Phase 1 schema 冻结 | 与 Phase 3 并行 |
| **Phase 3 · 前端 + P20 wiring** | 18 + 25 + P20 wiring（AC-P1-10/12 挂位）| 26-32（v3 修订）| Phase 1 API contract 冻结 + AC-P1-10/12 P20 挂位 | 与 Phase 2 并行 |
| **Phase 4 · 审批 UI + 验证** | 18 PromoteModal + 16 验证 + 22 walkthrough | 11-13 | Phase 3 + Phase 1 evidence 框架 | - |
| **总工时** | | **72-97 单人天**（v3 修订）| | **9-14 周（多 agent 并行）** |

**并行性说明**（修 v1 误判）：plan chap 21 依赖**不是**线性链。Phase 1 schema 冻结后，Phase 2 调度（lease + job harness）和 Phase 3 前端（UI shell + tab 容器 + StatusPanel resize）可同时启动；Phase 4 部分（评审 UI）依赖 Phase 3 前端骨架，但验证套件 P18 可在 Phase 1 evidence 框架冻结后并行准备。

## Phase 2 增补 · P12 walkthrough 后发现（2026-05-13）

P12 收尾真数据 walkthrough（R-201, 50 messages, Sonnet 4.6, 48.6s）暴露 viewfinder 6 段语义跟 V16.5 chap 11 vision example 有偏差。**P12 Phase 1 不修**（测试 109/109 全绿 + AC-P1-10 字面达标 + 范-r6 GO；这是"内容生成质量"问题，不是"防漂移基础设施"问题，跟 P12 anti-drift 主线两个维度）。挂 Phase 2 P12.b：

### P12.b · viewfinder 6 段语义二轮打磨

| 段 | V16.5 vision example | 当前实测 | 根因 | 修法 |
|---|---|---|---|---|
| §1 当前主题 | "V14 plan 推到可立项状态" — 高层主题抽象 | "选方案 A：由黄仁勋手写 worktree-report.md…（D-8）" — spec 决策原文当主题 | rule-based 模板"取最新 spec/fallback 房间标题"过机械 | 上 narrow LLM 提炼一句话主题（不冲突范 r2 否决"全 LLM"——这是 single-purpose LLM 调用不是全链路）|
| §3 下一步 + 谁做 | "派范第 4 轮 verify（黄仁勋 owner）" — 未来动作 + owner | "批准干掉孤儿 preview 进程…（D-10）" — **语义反了**：取最新 commit 当下一步 = 已完成当待办 | 当前 `activeDecisions.filter(type=commit).slice(5)` 算法错位 | 改算法：取 pending/working a2a_calls 配 issuer/convener，或取未被 supersede 的最新 spec 决策 |
| §5 关键决策 | "D-018: V13 升级到 V14" — pivot/spec 级 | D-11 reject + D-10/9/8/7 worktree 清理 commit 平铺 | 没"重要性加权" | decision_type 加权：pivot/spec 优先于 commit/reject；commit 类只在前 5 条空缺时填补 |
| §6 不要再做 | "D-005 [tombstone, msg_180]" — tombstone 永久红线 | "删除某些已完成…（D-11 reject, confidence 0.60）" extractor 自承"上下文不足" | 用 reject decisions 替 tombstone | 严格只取 `tombstone=1`；reject 决策不进 §6（reject 可被 supersede，不是永久红线）|

**P12.b AC**：
- [ ] **AC-P2-6 · §3 下一步算法修复**：fixture 含 pending a2a_call + 未 supersede spec 决策时，§3 输出"等 <issuer> [a2a_call=...]"或"<spec.content>（<owner>）"，不再输出最新 commit
- [ ] **AC-P2-7 · §6 严格 tombstone**：fixture 含 reject decision (tombstone=0) + tombstone decision (tombstone=1)，§6 只渲染 tombstone=1 项
- [ ] **AC-P2-8 · §5 加权排序**：fixture 含 pivot×1 + spec×2 + reject×1 + commit×5，§5 前 5 条按 pivot>spec>reject>commit 排序
- [ ] **AC-P2-9 · §1 主题提炼**（可选 LLM 路径）：Sonnet 4.6 prompt 给最新 spec 决策原文 + 房间 title → 输出 ≤ 30 字主题概括；fallback：纯 rule-based 抽 spec 决策动词宾语

**工时估**：§3/§6 各 1h（算法 + 改 fixture）+ §5 30min（加权排序）+ §1 LLM 2-3h（含 prompt 调优 + 校准）= 4.5-6.5h。

### 其他 Phase 2 增补

| 项 | 来源 | 修法 |
|---|---|---|
| §1 长期 spec 投影 | walkthrough P2 痛点：50 条窗口外 spec 决策不显示 | 扩窗口或 markTombstone(spec_id) 让永久不被换出 |
| §3 time-decay 自动 sweep | V16.5 chap 11 暗含 | commit 决策超 7 天无新 commit 引用则 status='expired'，§3 不再渲染 |

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
| **F027 工期长（72-97 天单人 — Phase 3 v3 plan 修订）→ 期间无法并行其他 feature**| 多 agent 并行（黄/范/桂芬 拆 phase 同时干）→ 9-14 周；中间不允许 hotfix 偷渡（hotfix 走独立 worktree）|

### 中风险

viewfinder LLM 漂移 / lease 死锁 / 多 agent 并发 LLM API / token 超限 / BM25 中文分词 / cross-ref 解析失败 / FTS5 触发器同步漏 / sources 字段循环引用 / agent-capabilities 与实际能力 drift（V16.5 chap 22 兜底）

## 立项材料

- **F-id**: F027
- **优先级**: P0
- **worktree**: `feat/F027-unified-memory-architecture`
- **期间策略**: B022 当前 fix 保留；非紧急 feature 暂缓策略立项时拍
- **工期**: 72-97 单人天 / 9-14 周多 agent 并行（Phase 3 v3 plan 修订 — 加 AC-P1-10/12 P20 wiring 挂位 + AC-P3-6 commit endpoint）
- **SOP**: `feat-lifecycle` skill

## Round 2 Approval（已全部落定 · 历史存档）

> **2026-06-15 收口注**：4 个 Gate 均已在实施过程中落定，checkbox 保留原样作历史——Gate 1 小孙拍 v2 整套立项 GO；Gate 2 以 AC-P3-7 落定（**不创建** `wiki.config.yaml`，Iron Laws 3 负断言 + fallback config；4 个 MCP 工具已上线）；Gate 3 evidence pack 全程双 judge（judge1 Opus / judge2 Codex）+ 仲裁执行完毕；Gate 4 走 F024 port registry。

### Gate 1 · 立项 GO
- [ ] 小孙拍板：F027 整套（V16.5 全 22+ phase 单 F-id）GO + 工时 72-97 接受（v3 修订）
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

## 收尾补丁 · chunk B（wiki_memories 砍表，2026-06-03 小孙拍）

wiring 收尾实测发现 `wiki_memories` 表是**冗余第二存储**——md 文件 frontmatter 已含表绝大部分列 + body=文件本身；**无 MCP 读它**，唯一读者 wiki-story 仪表盘读空表显 0；两个真实 DB 实测均 **0 行**。决策砍表（详见 V16.5 chap 14 PATCH）：

- **记忆 = 文件单一真相源**：删 `wiki_memories` 表（schema.ts + INIT_SQL）+ 死代码 `wiki-memories-repository` / `wiki-memories-lint` / `wiki-memories-types`。
- **召回 = 文件**：`search_wiki` → `wiki_entity_index`（BM25 全文搜，chunk A 已接线）。
- **治理 = 文件夜扫**：`wiki-memories-lint` 的 **R1（重复 canonical）/ R3（死 supersedes）搬入 `NightlyHealthCheck`**（扫 md frontmatter）；R4（TTL）由现有 `draftExpired` 覆盖；R-T（type 前缀）随表的烂 taxonomy 废止。
- **wiki-story 仪表盘**：解除空表依赖——5 个结构化桶恒返 0（诚实反映结构化记忆层未填，待 G11 compile pipeline），conversation（messages）+ decision（room_decisions）保真。
- **wiki-compiler**（chap19 派生视图编译器）：`compileWiki` 零生产调用=造好未接线，已**解耦保留**（脱离死表类型）待小孙拍 删 / 接。
- **物理空表**：既有库由小孙手动 `DROP TABLE wiki_memories`（Iron Law：runtime 不擅自 drop）。

> 影响的历史 AC：**AC-P1-9**（"6 类记忆桶物理表 + 防漂桶 lint 红绿测试"）的"表 + lint"实现被本 patch 取代为"文件 + NHC 治理"；AC 文字保留作历史，实际验收以本 patch 为准。

## 收尾补丁 · chunk C（记忆 MCP 收敛引导，2026-06-03）

原始 goal 的另一半 = 记忆 MCP 收敛成 4 件套（`read_wiki` / `search_wiki` / `query_messages` / `update_wiki`）+ 引导 agent 用它们 + 退役旧散记忆工具。实测：旧 5 工具全暴露、零 deprecation 标记；agent-prompts/shared-rules 零引导。处置（旧工具 dev 真有人用 → **deprecate 引导，不硬删**）：

- **shared-rules.md** 加「记忆工具（4 件套优先）」段（`loadSharedRules` 注入每个 agent prompt）：4 件套为首选 + memory_preflight 自动召回提示 + 旧工具列为 legacy。
- **mcp/server.ts** 5 个旧工具描述加 `⚠️[Legacy · F027 记忆收敛]` 标记 + **准确**指向（德彪 chunk-C-r1 P1 纠错：旧工具≠被 4 件套取代，各自访问 4 件套碰不到的数据）：`search_room_memories`/`get_memory`→读旧 `session_memories` store（4 件套不覆盖，仅需旧 session 摘要时用，优先 `query_messages`/`search_wiki`）；`get_room_summary`→旧滚动摘要（ROOM 上下文优先 viewfinder/`read_wiki`）；`get_room_context`（时序）/`recall_similar_context`（messages 语义，4 件套不做）降为次要。
- **memory_preflight 自动召回只接 A2A 派发路径**（非全 wake-up，message-service:2700）——文案据此修正。
- **prompt 内容同步收敛**（德彪 P2）：context-assembler / burst-context 里主动叫 agent 用旧工具的 3 处 hint 改为「4 件套优先，旧工具作 niche 补充」。
- 不硬删（665/89/87/83 次真实调用 + 读独立 live store），工具仍可调，仅引导不作首选。store 层迁移（session_memories → wiki）+ memory_preflight 全路径接线 = 单独立项。

## 收尾补丁 · 收录体验（编译模型可配 + 同源 draft 收敛，2026-06-12 小孙拍）

小孙原话（2026-06-12 凌晨，审批 55 篇 draft 时）：①「订阅编译的模型 我前端不能选 这里可以优化一下把」②（同源文档多次保存生成多篇 _auto draft）「这个不是bug吗？那我不就审批两次？？」+「不是新功能需求 就在F027里面闭环！正好看一下改动了文档 wiki是否会自动再后台改 然后走体检什么」。

定性：② 是 V16.5 line 2662 留白的 supersedes future feature（设计内留债，体验上等同 bug）；① 是 G11 compile 链的可配置化收尾。两项归 F027 收尾补丁，不立新 F 号。

### AC-W1 · wiki 编译模型可配（前端可选，热生效）

- [x] `runtime-config.ts` 增 `wikiCompile.primaryModel`，白名单 = haiku-runner 既有 4 模型（opus-4-7 默认 / sonnet-4-6 / opus-4-6 / haiku-4-5），PUT 非法值 400
- [x] compile runner 改为每次调用动态读配置（热生效，不重启）；fallback 链固定 Haiku 4.5 不变；降级 log 带真实 primary 模型名（替换硬编码 "Opus primary failed" 文案）
- [x] 前端 runtime config 设置区加「Wiki 编译模型」下拉（沿用 F021 agent 模型选择器模式；挂 claude tab——wiki 编译走 claude CLI）

### AC-W2 · 同源 _auto draft 自动收敛（只审最新）

- [x] 同源 key 推导：frontmatter `sources[0].path` 的 basename 优先（编译产物），否则文件名去 `-<13位unixMs>` 后缀（stub/watcher 版本化名）；两形态互通
- [x] watcher ingest commit 成功后，同 key 旧 `_auto` draft 自动搬 `wiki/concepts/draft/_superseded/`（仍在 /draft/ 下，召回三闸门天然继续排除；fail-soft 搬失败不影响 ingest）
- [x] 审批列表（GET /api/wiki/drafts）每源只见最新一篇；`_superseded` 不入列表
- [x] NHC `isActiveDraftPath` 排除 `_superseded`（不参与 30 天 TTL 二次搬运）

德彪 review 增补（r1→r3 闭环全落地）：时间戳守卫只搬严格更旧 + DocsIngestRunner 同 path 串行化（防慢 ingest 后完成吃新 draft）+ cleanup `then(cleanup,cleanup)` 防 unhandledRejection + promote/preview/batch 三入口拒 `_superseded`（含 `posix.normalize` 防 `./`//`..` 变体绕过）+ session config 拒收 wikiCompile（全局专属）+ 前端 wikiCompile 并入 setGlobalOverride 单次 PUT。

### 收尾补丁 #2 · KB 审批 UX 二连（全选三件套 + 收录设置卡三引擎，2026-06-13 小孙拍）

小孙原话（2026-06-13）：①「审批界面能不能搞个全选 我一个一个点好费劲」②「编译模型 我也要可以自己写 不然有时候新模型出了 你这里不更新的怎么办」③「编译模型放到claude里面不好 就跟我们这个记忆页面放到一起 找个地方设计一下不好吗？你这样写 我这样就只能用claude了」。

#### AC-W3 · 审批列表全选三件套

- [x] drafts 列表拉满：GET /api/wiki/drafts?limit=200（后端上限；>200 篇 header total 可见差额，真到再上分页）
- [x] 表头三态全选 checkbox（全选当前已加载/再点清空/部分 indeterminate）
- [x] 批量审批 >50 自动按 50 切片顺序提交合并 summary；部分分片成功+后续失败 → 报告优先展示已完成 + amber 横幅提示剩余未提交（data/error 双态）

#### AC-W4 · 收录设置卡（三引擎 + 模型自由输入）

- [x] 审批页头部 ⚙ 折叠卡：引擎 radio（claude/codex/gemini）+ 模型 input+datalist 可写可选（留空=引擎默认：claude→Opus 4.7，codex/gemini→CLI 默认）；**AC-W1 的 claude tab 下拉撤除迁移至此**（小孙原话③，单一入口防漂移）
- [x] wikiCompile.primaryModel 白名单降级为前端建议列表，后端只做格式校验：trim 非空 + ≤64 + 字符集 `^[A-Za-z0-9][A-Za-z0-9._:/-]*$`（model 进 spawn argv：cmd 元字符堵命令注入、首字符限字母数字堵 -m 后 flag 注入）
- [x] wiki-compile-cli-runners：codex `exec -s read-only [-m]` / gemini `--approval-mode plan -p 空参 [-m]`，prompt 走 stdin；shell 仅 win32（.cmd shim）超时 taskkill /T /F 树杀，POSIX 直接 exec；gemini -p 空参平台分形（win32 字面 `""` / POSIX 真空串）
- [x] 动态 runner 降级谓词放宽：任何 primary 失败都降级 Haiku 4.5（自由 id 填错是主失败形态；跨引擎 primary 挂≠fallback 挂）；schema 失败仍走管道 3 重试+stub（与原链同义）

德彪 review 增补（r1 1P1+3P2 → r2 4P2 → r3 1P2 → r4 GO）：降级谓词放宽 + 树杀/免壳平台分流 + **前端全量 PUT 严格串行化**（乱序覆盖与脏段携带同灭，双写者失败回滚，r1 的 seq guard 中间态被 r2 串行化取代）+ 收录卡 dirty guard/保存中禁输入/loadFailed 禁保存+重试。自审追加：setWikiCompile 失败回滚、model id 首字符限制。活体冒烟（worktree preview :8802）：limit=200 回显 / codex+自由 id roundtrip / `--yolo`、`a|b` 双 400。

### 收尾补丁 #3 · 审批体验三连（列表并行 + promote 三态 + 强度可选，2026-06-13 小孙活体验证后拍）

小孙原话：①「为啥我点审批 迟迟没有东西出来 等了好久才出来东西 这么卡吗」②「除了gemini无法选择强度 claude 和 codex应该都是可以选择强度的」③「我点了promote前端能有个进度条吗？不然好了没好哦看不懂 而且报错我也不知道」。

#### AC-W5 · 审批列表后端并行加载

- [x] 根因实测：审批列表 62 篇 draft，后端 walkAllDrafts 逐篇串行 readFile+stat+parseFrontmatter（与 limit=200 无关——无论返回 50/200 都 summarize 全部）
- [x] walkInto 拆 collectDraftFiles（递归收 .md 路径，串行 readdir cheap）+ `mapWithConcurrency(16)` 并行 summarize（保序 + FD 上限）；symlink/_superseded 排除、ENOENT fresh-wiki 返空、summarizeDraft 失败 null 过滤 — 语义全不变

#### AC-W6 · 收录卡推理强度可选（claude/codex 有，gemini 无）

- [x] runtime-config `wikiCompile.effort` 按 provider 的 `MODEL_CATALOG.efforts` 白名单校验（claude low/medium/high/max；codex none…xhigh；gemini efforts=[] → 拒 400）；validate + sanitize 同口径
- [x] runner 传参：claude `--effort <v>`（createClaudeModelRunner 第三参）/ codex `--config model_reasoning_effort="<v>"`，复用主 runtime 形态；gemini 不传
- [x] 动态 runner：resolveWikiCompileTarget 带 effort + 缓存键 `label@effort`（热切强度不命中旧 runner）；defaultBuildRunner 透传 — 生产链经动态 runner 自动生效，server.ts 未改
- [x] 前端收录卡：强度 `<select>` 读 store.catalog[provider].efforts，非空才渲染（gemini 隐藏 → 小孙②）；切引擎重置强度（防跨引擎非法值）；保存仅本引擎支持才带 effort

#### AC-W7 · promote 三态 + 批量进度

- [x] PromoteModal 三态：进行中 spinner+「正在提交…勿重复点击」/ ✅成功面板显 finalPath（不再静默关弹窗，父 handlePromoteSuccess 改只 refetch）/ ❌错误红框
- [x] BatchPromoteModal + useBatchPromote：progress {done,total}，submitting 视图「已提交 X/Y」+ 进度条，每片完成累加

德彪 review：r1 = **GO**（P1/P2/P3 全无，"A/B/C 链路与边界处理正确"）。TDD 全程 Red→Green；api 100 + 前端 111 受影响测试 + 双 tsc 零。

### 活体验证（小孙指定）

本补丁落档 commit 本身改动 `docs/features/F027-*.md` → docs-watcher 应自动收录新 draft（验证「改文档 → wiki 后台自动跟」）；合并后 touch 同一文档第二次，旧 draft 应自动进 `_superseded`（验证 AC-W2）；次日 04:00 NHC 首跑出 warnings 报告（验证体检链）。

收尾补丁 #2 增补（主库重启后）：审批列表一键全选 57+ 篇 / 批量 >50 自动分批 / ⚙ 卡切 codex 或 gemini 跑一次 ingest 看降级 log（gemini `-p` 空参形态是唯一未活测假设，失败被降级链兜住）。

收尾补丁 #3 增补（主库重启后）：① 审批列表加载明显变快（62 篇并行）；② 收录卡切 claude/codex 出现强度下拉、切 gemini 消失，选 high/xhigh 保存后跑一次看 log；③ promote 单篇出进度+成功落地路径、批量出「已提交 X/Y」进度条。

## 后续 follow-up（不在 F027 范围）

- **M8**：F026 cleanup 补 ADR-002/003 CI guard（V16.5 chap 0 V16.5 follow-up）
- **F5**：F026 加独立 cascade recovery job（V16.5 chap 0 V16.5.1 follow-up）
- **chunk B 余项**：物理表 `DROP TABLE wiki_memories`（小孙手动）；`wiki-compiler` 删/接（小孙拍）；wiki-story 5 桶真实数据源（等 G11 compile pipeline 接文件）。

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

---

## 收口对账（2026-06-15 · 小孙拍 done）

小孙 2026-06-15 判定「F027 基本已经做完」并拍板收口。历史 AC 勾选滞后于实际交付，本次按实证补勾（证据 = 各 Merge Timeline commit + 双 judge evidence pack + 小孙活体使用）；仍开放项如下，**全部有主、无灰色地带**：

| 项 | 状态 | 去向 |
|---|---|---|
| AC-P1-10 月度纠错触发器（MonthlySnapshot 真探针 + auto-replace）| ⏸️ 待武装 | 残债 C1.5，小孙 2026-06-14 拍下轮专做（side-effect-free 探针设计 fork 已落 RESIDUAL-DEBT C1.5）|
| AC-P2-6~9 · P12.b viewfinder 6 段语义打磨 | ⏸️ 未实施 | 内容质量打磨（非防漂基础设施），随 C1.5 下轮一并评估 |
| AC-P4-3 命令面板 4 写命令（/promote /demote /series /rollback）| ⏸️ 未启用 | 残债 B6；同功能已由 KB tab 按钮 + PromoteModal/DemoteModal 全覆盖，仅命令入口缺 |
| AC-P4-6 正式三场景 walkthrough | 被事实取代 | 小孙自 2026-05 底起连续活体使用核心链路（审批 21+ 篇 / 批量 promote / 收录 / 模型热切换），正式脚本不再补走 |
| 残债 B/C 长尾 | 开放 | 见 [`F027-RESIDUAL-DEBT.md`](F027/evidence/phase4/F027-RESIDUAL-DEBT.md)（2026-06-15 刷新：C1 调度 noop 仅剩 C1.5，其余已全部接通）|

**收口整合动作**（本 commit）：① ROADMAP 补 F027 进「已完成」表（立项期漏登记，活跃/已完成两表此前均无 F027）；② 顶部新增「文档地图」作唯一导航入口；③ 删 9 篇过时过程文档（Phase4 在飞快照 / Phase3 升 PASS 映射矩阵 / P13 评审往来 r1-r3 / P18 派工清单 / Phase2·3 evidence 收稿快照 / Phase3 walkthrough 脚本）+ 1 篇未跟踪 backfill dry-run 报告，git 历史可查；④ RESIDUAL-DEBT 按 `scheduler-bootstrap.ts` 现状刷新。

---

## Merge Timeline

| 日期 | 合并 | 内容 |
|---|---|---|
| 2026-05-23 | dev `dfbe336` | Phase 3 前端容器 + IngestModal + AC 闭环 |
| 2026-06-10 | dev `e80427d` | 收尾全链：全文展开（r1-r3 GO）+ 警告 404 修复（6 轮审 GO-with-residual）+ RuntimeLog 拖高 + #286 自动召回 FU 四件（r2 GO）+ #285 session_memories→wiki 深迁移 + 旧 3 记忆工具后端退役（r3 GO）。quality-gate 愿景自检 6 痛点机制层全闭环。 |
| 2026-06-11 | dev `4be9624` | 续篇五件：ghost previewId 直报 sanitize_blocked + embedded records boot-load（语义召回转正）+ warnings 文件生产链 + wiki-story 5 桶真数据源 + preview 双根修复（德彪 4 轮审 GO）。 |
| 2026-06-12 | dev `81378f6` | 人审豁免 ingest + draft 召回准入闸门（德彪 r1→r5 GO）；12 篇 blocked 文档真跑 `_auto` 43→55。 |
| 2026-06-12 | dev `784b5de` | 收尾补丁·收录体验：AC-W1 编译模型可配（动态 runner 热生效 + claude tab 下拉）+ AC-W2 同源 draft 自动收敛（_superseded 归档 + 串行化 + 三入口闸门）。德彪 r1(1P1+3P2)→r2(1P1+1P2)→r3 GO。**生效需主库重启**（小孙 start-project）。 |
| 2026-06-13 | dev `144b632` | 收尾补丁#2·KB 审批 UX：AC-W3 全选三件套（limit=200 + 三态全选 + 50 切片分批双态）+ AC-W4 收录设置卡（三引擎 + 模型自由输入，claude tab 下拉迁来）。德彪 r1(1P1+3P2)→r2(4P2)→r3(1P2)→r4 GO + 自审 2 件（注入双闸/失败回滚）。**生效需主库重启**（与 784b5de 一起）。 |
| 2026-06-13 | dev `09d7bcf` | 收尾补丁#3·审批体验三连：AC-W5 列表并行加载（mapWithConcurrency 16，62 篇串行→并行）+ AC-W6 收录卡强度可选（claude/codex effort 白名单 + 动态 runner 缓存键含 effort，gemini 隐藏）+ AC-W7 promote 三态（进度/成功显路径/错误）+ 批量「已提交 X/Y」。德彪 r1 GO。**生效需主库重启**（与 784b5de/144b632 一起）。 |
| 2026-06-14 | dev `acfb57b` + `da7aa6b` | 收尾三修：V14 promote 审计改 posture C（LLM 语义判官替换 regex imperative 层，复用 wikiCompile 可配模型，德彪 r1→r5 GO）+ 修1 DriftDetector 真接线 + drift 告警走「警告」tab（残债 C1.4，德彪 r2 GO）；修2 小孙拍下轮专做（C1.5）。`503b017` AC-P1-10 显式标「待武装」。 |
| 2026-06-15 | dev `11a093f` | **收口标 done**：ROADMAP 补登记 + 文档地图/收口对账 + 删 9 篇过时过程文档 + RESIDUAL-DEBT 刷新。运行时冻结根因同日根治（主仓 core.bare 关 + 工作区刷 dev）。 |
| 2026-06-15 | dev `3eb787d` | done 后补丁·promote 归桶三件（小孙拍选项 A + F007 误伤修复）：suggestedDestPath 按 LLM canonical_owner_suggestion 四桶预填（单篇/批量）+ promote 落盘刷 canonical_owner_path（单行标量守卫/CRLF 保真）+ sanitize 裸 "system prompt" 红线改攻击语态共现判定（30+ exfil 动词双向 80 字窗 + 问句 + 折叠文本防跨行拆词，裸模板同口径收口既有缺口）。德彪 r1(1P1+2P2)→r2→r3→r4 GO，PoC 全部逐字入测。**生效需主库重启**。 |
| 2026-07-03 | dev `bb2de55` | done 后补丁·promote 后台化（小孙「promote 把整个网占住」拍方案 1 + 8 篇失败诊断 7 偶发/1 dest_exists）：promote-jobs-store 单/批提交进 store 关弹窗不断 + 行徽标 ⏳/❌/✅ + 批量横幅 + ok 自动 refetch 消行 + 同 src 双路护栏（挡 running\|ok/对账式 GC/hasLoaded 门三轮收口）+ 判官 parse_failed 自动重试一次 + lease TTL 300s。德彪 r1(1P1+2P2+2P3)→r2→r3→r4 GO。**生效需主库重启**。 |
| 2026-07-03 | dev `b63d0a2` | done 后补丁·dest_exists 对比+替换（小孙「失败了都不知道该不该丢弃」）：撞已存在页时弹窗并排对比+标「哪份新」+一键替换（旧页归档 _rejected/ 可恢复）；CAS 闸全链（expectedDestHash 必带/写盘前重验 lease+哈希/存在性双分支）+ 内核级 create-if-absent（linkSync EEXIST）+ 归档事件延迟 commit + ACL 死接线修（新增 methods 规则/rules 小孙 promote）。德彪 r1(2P1+2P2+1P3)→r2→r3→r4→r5 GO，PoC 全逐字入测。**生效需主库重启**。 |

**合并后运维步**：① B3 backfill 55 篇 docs 全量真编译 — ✅ 2026-06-11 完成 ② 存量 session 摘要导出 — ✅ 2026-06-11 完成（#285 深迁移）③ `DROP TABLE wiki_memories` / session_memories 读路径切文件 = 小孙手动，仍 pending（不阻塞收口，Iron Law 1 runtime 不擅自 drop）。
