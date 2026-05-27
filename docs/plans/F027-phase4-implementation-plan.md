---
id: F027-phase4-implementation-plan
title: F027 Phase 4 实施 plan — 审批 UI + 记忆生产 go-live + 验证收口
status: v5 final（范-r3 CONDITIONAL P2×6 全接受 + 小孙拍节奏 20-22 + Day 23-24 buffer + r4 self-review GO 含 2 P3 已 inline；codex CLI 2 轮卡 → 小孙拍接 self-review）
created: 2026-05-23
feature: docs/features/F027-unified-memory-architecture.md
phase: Phase 4 · 审批 UI + 验证（V16.5 P20 + P18 + P22）— **F027 最后一个 phase**
parent: docs/plans/F027-phase3-evidence-summary.md（Phase 3 收稿 4 PASS / 6 CONDITIONAL_PASS / 0 FAIL）
---

# F027 Phase 4 实施 plan — 审批 UI + 记忆生产 go-live + 验证收口

## 0. 修订摘要

| 版本 | 变更 |
|---|---|
| v1 | 首稿。基于 feature.md Phase 4 立项 6 AC + Phase 3 推 go-live 3 件。小孙拍 scope = 9 AC，节奏 4 周 / 16-20 天，worktree 沿用 `.worktrees/F027`。待范-r1。 |
| v2 | 范-r1 CONDITIONAL（P1×2 + P2×4 + P3×3 + 8 Open 全意见）小孙拍 3 方向全接受：① 节奏 16-20 → 20-24 天 / 4-5 周 ② AC-P4-3 重设计右侧面板为主 ③ AC-P4-9 自带 fixture seed。加附录 §10/§11/§12。AC-P4-7 改 copy/dry-run/atomic swap。AC-P4-8 删 Level 2 占位 + 拆 5 子项。风险表 +6 项。 |
| v3 final | 范-r2 CONDITIONAL (P1×1 + P2×2) + 黄 verify 3 dependency gap 全接受：WAL 安全协议 / §11 矩阵 / AC-P4-8 依赖明细 / V14 audit service 新实现 / IngestModal 系列字段必补 / 节奏 20-24 → 22-26 天。commit `2829776`。 |
| **v5** | **范-r3 CONDITIONAL P2×6 全接受**（范实测 sqlite3 验证 v4 前提全对——不重蹈 v3 翻车）：① **AC-P4-9 d 重写**：per-table idempotent（每表 `COUNT(*)=0` 才 seed）+ 单事务 INSERT/rollback + 明示不做 DB 文件 copy/swap/checkpoint + prompt_audit 永不 fixture seed ② **d3 删 released row**（wiki_leases schema 无 status/released_at 字段，drizzle-instance.ts:386-395 实证）+ 改 seed active/expired 2 种 ③ **WORKTREE_PREVIEW gate 来源明示**（修 scripts/worktree-preview.ts 加 env，SQLITE_PATH 路径作 second guard，不改 .env） ④ **Week 1 GO 加真 R-001 recall stimulus** 验 d4（prompt_audit 9 字段写入） ⑤ **§10 场景 1 前置改 d1-d3 非空** + prompt_audit 非空移到 step 1.5 后置 evidence（修 d4 vs 前置内部冲突） ⑥ **节奏 18-22 → 20-22 天 + Day 23-24 buffer**（吸 v3 翻车 + 不乐观） ⑦ 全文 9 AC → 8 AC（grep verify 9 处）。小孙拍节奏 + 走 r4 review 不跳。 |
| v4 | v3 commit 5min 后实测翻车 — plan 全员（v1/v2/v3 + 范 r1/r2 + 小孙）基于错误前提"worktree DB 缺 6 张表"。实测 `sqlite3 .tables`：5 张已有（`prompt_audit`/`wiki_events`/`wiki_leases`/`room_decisions` + `session_groups` 是真房间表非 `rooms`）+ 1 张（`viewfinder_cache`）在 codebase **从不存在**（viewfinder 实时计算不用 cache）；真问题是 **4 张表 0 rows**（数据缺，不是表缺）。**根因**：Phase 3 evidence summary line 121-124 写错 → 我 plan v1 沿用未 verify → 范 r1/r2 也未 verify（feedback `measure_before_assert` 又一次教训）。**v4 改动**：① **AC-P4-7 整个取消**（DB 已自动 migrate via `CREATE TABLE IF NOT EXISTS` 模式，drizzle-instance.ts:91 INIT_SQL 25 张表）② **AC-P4-9 扩范围** — 从 "warnings + KB fixture" 扩到 "warnings + KB + 4 张 Phase 1 空表 data seed"（prompt_audit/wiki_events/room_decisions/wiki_leases） ③ **节奏 22-26 → 18-22 天**（-4d AC-P4-7 + 2d AC-P4-9 扩 = 净 -2 ~ -4d）④ AC 数 9 → 8 ⑤ §10 walkthrough / §11 矩阵 引用 AC-P4-7 → AC-P4-9 ⑥ §6 风险表删 DB 半迁移/空库（已不适用） ⑦ §7 依赖删 AC-P4-7 相关。待范-r3 review。 |

## 1. 范围

Phase 4 = **F027 最后一个 phase**（feature.md:199-205 工期表 4 个 phase 末位）。两条主线：

- **主线 A · 审批 UI**（feature.md 原立项 6 AC）：让 ingest / promote / demote / rollback 端到端可用，**右侧面板按钮为主入口**（小孙拍 Q2），关闭 Phase 3 留下的 placeholder
- **主线 B · 记忆生产 go-live**（Phase 3 推 3 件）：把 Phase 1 后端引擎 + Phase 3 前端面板**真接通跑活数据**——worktree DB schema 升级 + AdaptiveRecallCoordinator boot wiring + warnings/kb 派生数据源（fixture seed）

收口目标：Phase 3 留下的 6 CONDITIONAL_PASS（浏览器实测 BLOCKED）全升 PASS，F027 整体进入生产可用状态。

### 1.1 交付物（8 AC）

**主线 A · 审批 UI（6 AC，feature.md AC-P4-1 ~ AC-P4-6 原立项）**

1. **AC-P4-1 PromoteModal 流程**（v3 修：V14 audit service Phase 4 新实现）— composer/KB tab 触发 → 选 target wiki 路径 + 写 reason → POST `/api/wiki/drafts/<id>/promote` → **新实现 V14 二次审计 service**（V16.5 line 838-846 3 步检测：命令式语句 / prompt 结构 / tainted_source 直引）→ 复用 Phase 1 `update_wiki` mv 到正式区 + 写 `wiki_events` action='promote' + 推审计通知。**v3 verify**：V16.5 line 838-846 仅 spec 定义，grep 0 production matches，Phase 4 必新实现（+1d）
2. **AC-P4-2 审计失败回退** — `tainted_source=true` draft 二次审计 reject → modal 显示 `audit_reason` + 不 mv + 不写 promote event + draft 留原位 + Inspector 显示 reject 历史
3. **AC-P4-3 审批操作入口（v2 重设计 — 小孙拍 Q2）** — **右侧面板按钮为主**：
   - draft-approval tab list item 加 [Promote]/[Demote]/[Rollback] 按钮（取代 `/promote`/`/demote`/`/rollback` 命令）
   - KB tab list item 加同样按钮（+ 批量审批 AC-P4-4）
   - composer slash menu 5 items 保留：仅 `/ingest` enabled，`/promote`/`/demote`/`/series`/`/rollback` **disabled 留 F028**（V16.5 line 2539-2545 命令面板原意不变，但 Phase 4 优先做更直观的按钮入口）
   - Series 标记走 IngestModal "加入系列"字段（V16.5 line 2563-2564 设计）— **v3 verify**：Phase 3 ingest-modal.tsx:37 注释明示 "backend Phase 4 才接 series_id"，UI + backend 全缺，Phase 4 **必补**（+0.5d）
4. **AC-P4-4 批量审批 UI（部分失败语义锁定）** — knowledge-base tab 加 [批量审批] 按钮 → list view 按 type/mtime 排序 + 多选 + 一键 promote 共用 reason；**部分失败行为**：每个 draft 独立 promote → 最终弹报告 modal `success: N / failed: M`（含 audit_reason 列表），失败 draft 留原位等手动 retry
5. **AC-P4-5 三层验证套件（P18 — 复用 Phase 2/3 evidence runner + artifact schema 锁，见 §12）** — 每个 AC 跑双 judge（claude-opus-4-7 j1 + codex-gpt-5.4 j2） + 仲裁；OAuth quota 用尽 → **BLOCKED 不是 SKIP=PASS**（feedback `codex_judge2_finds_real_gaps` 锁死）；evidence pack 不完整 → INCONCLUSIVE
6. **AC-P4-6 手 walkthrough 三场景（P22 — 脚本附录见 §10）** — 小孙按 V16.5 walkthrough（场景 1+2 V16.5 line 150 定义 / 场景 3 v2 新增基于 P12 anti-drift 端到端需求）端到端走一遍；每场景独立 evidence

**主线 B · go-live（3 AC，Phase 3 推过来）**

7. ~~**AC-P4-7 worktree DB schema 升 Phase 1 migration**~~ — **v4 取消**：实测 `sqlite3 .tables` 显示 worktree DB 5 张 Phase 1 表已全有（drizzle-instance.ts:91 INIT_SQL `CREATE TABLE IF NOT EXISTS` 25 张表 boot 自动跑）。原立项前提"缺 6 张表"是 Phase 3 evidence summary line 121-124 写错（`rooms` 是命名错——真表名 `session_groups` 含 `room_id` 列；`viewfinder_cache` 在 codebase 从不存在——viewfinder 实时计算不缓存）。真问题是 **4 张表 0 rows** 数据缺，归 AC-P4-9 扩范围处理。
8. **AC-P4-8 AdaptiveRecallCoordinator production boot（v2 拆 5 子项 — 范 P1-1）** — `packages/api/src/server.ts:239` 当前用 `createNoopAdaptiveRecallCoordinator()`。Phase 4 必须完整 wire：
   - (a) **critique LLM**: `new LlmCritiqueAgent({model: 'claude-sonnet-4-6'})`（feature.md:155 指定）+ OAuth quota 用尽 fallback Haiku 4.5（不等价 PASS，记 BLOCKED）
   - (b) **Level 2 search_wiki backend**（**v3 verify：必新写 adapter**）: `Level2Backend` interface 在 `packages/api/src/wiki/adaptive-recall/types.ts:68` 已定义但 **无 production 实现**（注释 "P13.3+ 接真 backend"，grep 0 implements + 全 test stub）。Phase 4 必新写 thin adapter `class Level2HybridSearchBackend implements Level2Backend` wrap 现有 `HybridSearchProvider`（`packages/api/src/wiki/memory-preflight/hybrid-search-provider.ts:63` Phase 1 P11 已完成 BM25 + cosine + LLM rerank stub）。Day 3 gate：adapter 完成 + 单测 + 接通才能开 Day 4；缺则阻塞 AC-P4-8 BLOCKED
   - (c) **Level 3 messages FTS backend**: 接现有 `MessagesFtsLevel3Backend`（Phase 1 P14 已完成 f91edf5）
   - (d) **Level 4 file read backend**: 接现有 `FileSystemLevel4Backend`（Phase 1 P13 已完成 ea773d9）
   - (e) **Level 5 sink 生产实现**（拆 3 子件，evidence 分别证明 — v3 加依赖明细）:
     - e1: `WikiEventsPersist` — 写 `wiki_events` action='recall_escalate'（依赖 `wiki_events` repo Phase 1 已完成）
     - e2: `NotificationBroadcast` — 推审计通知到 R-001 房间（**依赖**：`AuditBroadcaster` service or WS pub/sub channel — 核对 Phase 1/2 是否已有；缺则 Day 4-5 新写 thin pub/sub wrapper）
     - e3: `InspectorProjection` — Inspector UI hook 显示 escalate（**依赖**：Inspector pull endpoint or realtime projection — 当前 prompt-inspector-tab 7 块靠 pull `/api/rooms/:id/prompt-inspector`，escalate 进第 8 块 Coverage section 走相同 pull 模式即可）
   - 验收：`server.ts:239` 改 `new AdaptiveRecallCoordinator({enabled: true, executorDeps: {critiqueAgent, levelBackends: {level2, level3, level4, level5}}})` + boot log `enabled=true, levels=[2,3,4,5]` + 真房间 recall 触发 → `prompt_audit` 9 字段真写入
9. **AC-P4-9 warnings + KB + 4 张 Phase 1 表真数据 + Inspector Coverage UI（v4 扩范围 — 吃 AC-P4-7 取消后 data seed 责任）** —
   - (a) **warnings tab 真数据**：派生数据源读 `wiki/warnings/*.md` + `wiki_events` action='warning_raised' → tab 列表显示；**fixture seed**：`tests/fixtures/wiki/warnings/*.md` 造 5-10 份（含 chained_suspect / acl_violation / drift_detected 类），boot 时拷到 `.runtime/worktree-preview/data/wiki/warnings/`
   - (b) **knowledge-base tab 真数据**：派生视图读 `wiki/index/*.md`（V16.5 chap 18 line 1953-1954）→ tab 列表显示；**fixture seed**：`tests/fixtures/wiki/index/*.md` 造 5-10 份（含 concepts/rules/methods/people 4 大类索引）
   - (c) **Inspector Coverage section UI**（AC-P3-8 b 接）：prompt-inspector 加第 8 块 unresolved 列表（GET `/api/rooms/:id/decisions/coverage`）+ click → PromoteModal trigger（接 AC-P4-1）
   - **(d) v4 新增 · Phase 1 表 data seed**：worktree DB 实测 4 张 Phase 1 表 0 rows（`prompt_audit` / `wiki_events` / `room_decisions` / `wiki_leases`），browser 实测 viewfinder/inspector 显示 placeholder 的真原因
     - d1: `room_decisions` seed — `tests/fixtures/db-seed/room-decisions.json` 造 5-10 行（R-001 房间含 spec/pivot/commit/reject 4 种 type，含 1 个用于场景 3 drift 触发的核心 spec）
     - d2: `wiki_events` seed — `tests/fixtures/db-seed/wiki-events.json` 造 5-10 行（含 action='ingest_commit'/'promote'/'warning_raised'）
     - d3: `wiki_leases` seed — 2-3 行覆盖典型 lease 状态（active / expired / released）
     - d4: `prompt_audit` 不预 seed — 等 AC-P4-8 enabled 后真房间对话自然写入（fixture seed 与 production write 路径冲突）
     - d5: seed loader — boot 时检测 `seed.json` 存在 + 表 0 rows → 自动 seed；含 rows 跳过（不覆盖真数据）
   - **不污染生产**：fixture 在 `tests/fixtures/` commit + runtime 在 `.runtime/` .gitignore + seed loader 仅 worktree-preview 模式启用（生产 boot 不跑）

### 1.2 plan 追加交付物

- **Phase 3 6 CONDITIONAL_PASS → PASS 升级映射矩阵（v2 新增附录 §11 — 范 P3-2）**：AC-P3-1/2/3/6/10/P3-8 分别由哪个 P4 AC、哪条 walkthrough step、哪份截图/log/judge artifact 升 PASS
- **evidence pack 收稿（artifact schema 锁，见 §12）**：Phase 4 8 AC 双 judge + arbitration（Phase 2/3 evidence pack runner 复用，不重建框架）

### 1.3 不做（明确划走）

- **F028 范围**：V16.5 已划走的 promote-only memory_preflight / sessions ledger / Adaptive Recall Level 6 / Prompt Inspector 升级 5 项
- **写型 rollback（v2 新增 — 范 P2-1）**：真改 wiki 文件的 rollback 需 CAS / lease / fencing / 二次审计 / `wiki_events action='rollback'` / 并发 promote 拒绝测试 — Phase 4 仅做 **read-only preview**（显示历史 + 生成 rollback 草稿不写盘），真写型推 F028
- **Composer slash menu 4 写命令启用（v2 新增 — 小孙拍 Q2）**：`/promote` `/demote` `/series` `/rollback` Phase 4 disabled 保留，UX 优先做右侧面板按钮入口；命令面板原意（V16.5 line 2539-2545 "像 Discord"）推 F028 evaluate（用户实际是否更喜欢键盘流命令）
- **Playwright E2E 全面引入**：Phase 4 仍用 walkthrough script + frontend unit + backend integration；Playwright 全面引入推 F024 worktree preview 配套独立立项
- **多房间并行 ingest 压测**：Phase 4 单 R-001 房间走完三场景，多房间扩展 Phase 5/F028
- **digest 三段 / L0-DIGEST**：Phase 1/2 已完成 fixture 验证，Phase 4 走真数据但不重做 fixture
- **wiki/warnings 写盘 trigger 逻辑本身**：Phase 4 只读已 raise 的 warnings + 自带 fixture seed；写盘 trigger（什么时候 raise warning）走 Phase 1 已有逻辑；如发现写盘逻辑缺，归 B-xxx 不在 Phase 4 scope

### 1.4 主线 A / 主线 B 耦合关系（v2 反映 Q2 重设计）

| 主线 A AC | 依赖主线 B | 说明 |
|---|---|---|
| AC-P4-1 PromoteModal | AC-P4-9 d | PromoteModal 需要 wiki_events 写入流通；seed 后端到端可验 |
| AC-P4-2 审计回退 | AC-P4-9 d | 同上 |
| AC-P4-3 右侧面板按钮（v2 重设计）| AC-P4-1（[Promote] 复用）| 按钮 trigger PromoteModal/DemoteModal/RollbackPreviewModal；不依赖 composer slash menu |
| AC-P4-4 批量审批 | AC-P4-1 | 复用 PromoteModal 的 promote 调用 |
| AC-P4-5 三层验证 | - | 验证框架本身无依赖 |
| AC-P4-6 walkthrough | **全部** | 端到端三场景必须 8 AC 全 done |
| AC-P4-9 c Inspector Coverage | AC-P4-1（PromoteModal）| Coverage section click → manual confirm 复用 PromoteModal 流程 |

**v4 关键耦合**：AC-P4-9 d Phase 1 表 data seed 是所有端到端验证前置（替代原 AC-P4-7 角色）。worktree DB schema 已 OK（boot 自动 migrate），只需 seed 数据，Week 1 Day 1 先做。

## 2. 现状盘点

### 2.1 Phase 3 留下的 Phase 4 起点（v2 反映 Q2 重设计）

| 组件 | 现状（Phase 3 done） | Phase 4 动作 |
|---|---|---|
| composer-slash-menu | 5 items 已加（`/ingest` enabled，`/promote` `/demote` `/series` `/rollback` disabled） | **保持 4 disabled 留 F028**（v2 — 小孙拍 Q2）；不启用 |
| draft-approval tab | 只读 list（Phase 3 done） | 加 [Promote]/[Demote]/[Rollback] 按钮（AC-P4-3）|
| knowledge-base tab | [+ Drop] enabled + placeholder list | 加 [Promote]/[Demote]/[Rollback] 按钮 + multi-select 批量（AC-P4-3 + AC-P4-4）+ 接派生真数据（AC-P4-9 b）|
| IngestModal "加入系列"字段 | V16.5 line 2563-2564 设计 | **核对 Phase 3 是否实现**；如缺补（属 AC-P4-3 子项）|
| PromoteModal / DemoteModal / RollbackPreviewModal | 不存在 | 从零（AC-P4-1 / AC-P4-3）|
| 审计回退 UI | 不存在 | 从零（AC-P4-2）|
| Inspector Coverage section | prompt-inspector 7 块，无第 8 块 | 加 unresolved 列表 + click（AC-P4-9 c）|
| worktree DB | **v4 修**：schema 已全 OK（drizzle-instance.ts:91 INIT_SQL 25 张表 boot 自动 `CREATE TABLE IF NOT EXISTS`）；4 张 Phase 1 表 0 rows 数据缺 | data seed 而非 migration（AC-P4-9 d）|
| AdaptiveRecallCoordinator boot | `server.ts:239` noop | production wiring 5 子项（AC-P4-8）|
| warnings tab | placeholder | 接 fixture seed 派生（AC-P4-9 a）|
| Phase 2 evidence pack runner | 已用于 Phase 3 双 judge | 复用 + artifact schema 锁（AC-P4-5 + §12）|

### 2.2 关键代码 anchor（v1 起手需 grep 验证未漂移）

- `components/chat/composer-slash-menu.tsx` — 5 slash items（Phase 4 不动）
- `components/chat/right-panel/runtime-log/tabs/draft-approval-tab.tsx` — 加 [Promote]/[Demote]/[Rollback] 按钮
- `components/chat/right-panel/runtime-log/tabs/knowledge-base-tab.tsx` — KB tab + [+ Drop]
- `components/chat/right-panel/runtime-log/tabs/prompt-inspector-tab.tsx` — 7 块（加第 8 块 Coverage）
- `components/chat/right-panel/runtime-log/tabs/warnings-tab.tsx` — placeholder
- `components/chat/right-panel/runtime-log/ingest-modal/ingest-modal.tsx` — 核对"加入系列"字段是否实现
- `packages/api/src/server.ts:239` — AdaptiveRecallCoordinator boot wire（核心 change point）
- `packages/api/src/runtime/worktree-preview.ts:37` — worktree DB 路径（migration 入口）
- `packages/api/src/routes/phase3/` — drafts / viewfinder / prompt-inspector / ingest-preview / ingest-commit / decisions（已有 6 个 endpoint，Phase 4 加 promote/demote/rollback-preview）
- `packages/api/src/wiki/levels/level2-search-wiki.ts` — Level 2 backend（AC-P4-8 b 接入）— **r2 写完需 grep 确认存在**

技术栈：Next.js 16 + React 19 + Zustand + Tailwind + vitest 4.1.4（同 Phase 3）。

## 3. 里程碑（4-5 周 / 20-22 单人天 + Day 23-24 buffer — v5 修订）

> v1 16-20；v2 20-24；v3 22-26；v4 18-22；**v5 20-22 天 implementation + Day 23-24 merge/final buffer**（范-r3 P2-6 修：吸 v3 翻车教训 + Week 5 evidence pack 收稿不乐观；总口径 22-24 天含 merge/final）。如 implementation 超 24 天小孙强制 review 是否裁 AC-P4-9 a/b。

### Week 1 · go-live 后端基础设施（4 天 — v4 -1d 因 AC-P4-7 取消）

| Day | 任务 | 工日估 |
|---|---|---|
| 1 | **AC-P4-9 d Phase 1 表 data seed (v4 新)**: tests/fixtures/db-seed/ 造 room-decisions.json / wiki-events.json / wiki-leases.json（10-15 rows）+ seed loader（boot 检测 4 表 0 rows → 自动 seed；含 rows 跳过；仅 worktree-preview 模式启用，生产不跑）+ 单测 | 1d |
| 2 | **AC-P4-8 a/b (v3+v4)**: critique LLM (Sonnet 4.6) + **新写 Level 2 thin adapter `Level2HybridSearchBackend`** wrap HybridSearchProvider + 单测 + boot 接通（Day 2 gate：adapter 完成才能开 Day 3） | 1.5d |
| 3 | **AC-P4-8 c/d**: Level 3 messages FTS + Level 4 file read backend wire（复用 Phase 1 P13/P14 已有） | 1d |
| 4 | **AC-P4-8 e1/e2/e3**: Level5Sink 3 子件 + `server.ts:239` 切 `enabled: true` + Week 1 r1 review | 1d |

**Week 1 r1 review GO 条件（v5 + 范-r3 P2-5）**：
1. worktree-preview 启动后 R-001 房间 viewfinder/inspector tab 渲染真数据（非 placeholder，得益于 d1-d3 seed）
2. AdaptiveRecallCoordinator boot log 显示 `enabled=true, levels=[2,3,4,5]`
3. **真 R-001 recall stimulus**（小孙在 R-001 房间发 **冻结 query**: "RAG 论文里如何处理 long context?"（同场景 1 step 1.5 — r4 self P3-2 冻结，保 Week 1 GO 测试可复现））→ `prompt_audit` 表写入新行 + 9 字段（recall_path / recall_satisfied / escalate_reason / budget_consumed 等）齐全；缺这步不得宣称 d4 完成
4. seed loader 单测 4 项全过（preview gate on/off / 已有 rows 跳过 / 事务 rollback）

### Week 2 · 审批 UI 核心（5 天）

| Day | 任务 | 工日估 |
|---|---|---|
| 6-7 | **AC-P4-1 (v3)**: PromoteModal 组件 + POST `/api/wiki/drafts/<id>/promote` endpoint + **新实现 V14 二次审计 service**（V16.5 line 838-846 3 步检测）+ 复用 Phase 1 `update_wiki` | 3d |
| 8 | **AC-P4-2**: 审计 reject 路径 UI + audit_reason 显示 + draft 留原位 + Inspector reject 历史 | 1d |
| 9 | **AC-P4-3 (1)**: draft-approval tab + KB tab 加 [Promote]/[Demote]/[Rollback] 按钮 + DemoteModal + RollbackPreviewModal（仅 read-only：history list + 生成草稿不写盘） | 1d |
| 10-11 | **AC-P4-3 (2) (v3)**: IngestModal "加入系列"字段 **必补**（UI form 控件 + backend `series_id` 持久化 + 与 multi-drop cross-correlation 对齐 chained 误检 skip） + Week 2 r1 review | 1.5d |

**Week 2 r1 review GO 条件**：右侧面板 [Promote] 按钮 → PromoteModal → 选 target + reason → V14 通过 → wiki 落盘 + event 写入；反例：tainted draft promote → reject 显示；Rollback 按钮 → preview history + 草稿（不写盘）。

### Week 3 · 批量 + Inspector Coverage + 验证套件（5 天）

| Day | 任务 | 工日估 |
|---|---|---|
| 11-12 | **AC-P4-4**: 批量审批 UI（KB tab multi-select + 共用 reason input + 部分失败报告 modal） | 2d |
| 13 | **AC-P4-9 c**: Inspector Coverage section UI（prompt-inspector 第 8 块 unresolved 列表 + click → PromoteModal trigger） | 1d |
| 14-15 | **AC-P4-5**: 三层验证套件（双 judge runner 复用 + artifact schema 锁 §12 + BLOCKED/INCONCLUSIVE 语义） + Week 3 r1 review | 2d |

### Week 4 · warnings/KB fixture + walkthrough 三场景（5 天）

| Day | 任务 | 工日估 |
|---|---|---|
| 16 | **AC-P4-9 a/b**: warnings + KB tab fixture seed（`tests/fixtures/wiki/{warnings,index}/*.md` 造 10-20 份）+ boot 时拷到 `.runtime/worktree-preview/data/wiki/`（v4 改：复用 Week 1 Day 1 已建的 seed loader 走相同 gate） | 1d |
| 17 | **AC-P4-9 a/b**: 派生 API 接通 + browser 验非空 rows | 1d |
| 18-20 | **AC-P4-6**: 小孙手动走 walkthrough 三场景（脚本 §10）+ 截图 evidence + Phase 3 6 CONDITIONAL_PASS 升 PASS（按映射矩阵 §11） | 2-3d |

### Week 5 · 收稿（3-4 天 — buffer）

| Day | 任务 | 工日估 |
|---|---|---|
| 21-22 | **evidence pack 收稿**：Phase 4 8 AC 双 judge + arbitration（artifact schema §12）+ Phase 3 升 PASS 矩阵 mapping | 1-2d |
| 23 | **合 dev gate**：merge-gate check + 合 dev + push origin | 1d |
| 24 | **F027 整体收稿** + Phase 5/F028 follow-up 立项 backlog 整理 | 1d |

**Week 5 r1 review GO 条件 = Phase 4 终结条件**：8 AC 全 PASS（或明示推 F028 的 CONDITIONAL_PASS）+ Phase 3 6 CONDITIONAL_PASS 全升 PASS（按 §11 矩阵）+ walkthrough 三场景小孙签字 + evidence pack 完整。

## 4. AC 列表（8 AC 详）

### 主线 A · 审批 UI（6 AC）

#### AC-P4-1 · PromoteModal 流程（v3 改 V14 新实现）
- **Given** R-001 房间有 1 份 `wiki/_drafts/example.md` draft（非 tainted）
- **When** 用户从 draft-approval tab [Promote] 按钮触发 PromoteModal → 选 target = `wiki/concepts/example.md` + reason "首批整理"
- **Then** POST `/api/wiki/drafts/example/promote` → **新实现 V14 二次审计 service**（V16.5 line 838-846 3 步：① body 含命令式语句（"必须"/"必需"/"忽略"/"覆盖" + context）② body 含 prompt 结构（`system:` 等）③ body 引用 tainted_source 字段必须改写为陈述句不直引）→ 全过 → 复用 `update_wiki` mv 到 target + `wiki_events` 写入 `action='promote', target='wiki/concepts/example.md', reason='首批整理', audit_passed_by='小孙'` + 推审计通知 + UI 显示成功 toast

#### AC-P4-2 · 审计失败回退
- **Given** draft `tainted_source=true`
- **When** 同上触发 promote
- **Then** V14 reject → modal 显示 `audit_reason` 详情（含 5 层 sanitize 哪一层失败 + 命中 pattern）+ 不 mv + 不写 promote event + draft 留 `_drafts/` + Inspector 第 8 块 Coverage 显示 reject 历史

#### AC-P4-3 · 审批操作入口（v2 重设计 — 小孙拍 Q2）
- **Given** Phase 3 已实现 draft-approval tab list 只读 + composer slash menu 5 items（`/ingest` enabled 其余 disabled）
- **When** Phase 4 改造
- **Then**
  - (a) draft-approval tab list item 行加 [Promote] [Demote] [Rollback] 3 按钮（hover 显示），点击 trigger 对应 modal
  - (b) KB tab list item 行加同 3 按钮 + multi-select checkbox（接 AC-P4-4）
  - (c) RollbackPreviewModal **只显示历史 + 生成草稿不写盘**（真写推 F028）
  - (d) DemoteModal: 选 reason → POST `/api/wiki/<path>/demote` → mv 回 `_drafts/` + 写 `wiki_events` action='demote'
  - (e) IngestModal "加入系列"字段 **必补**（V16.5 line 2563-2564 设计；v3 verify Phase 3 ingest-modal.tsx:37 未实现，UI form 控件 + backend `series_id` 持久化 + multi-drop cross-correlation 对齐 chained 误检 skip）
  - (f) composer slash menu `/promote` `/demote` `/series` `/rollback` **保持 disabled 状态不变**（推 F028 evaluate）

#### AC-P4-4 · 批量审批（部分失败语义锁定）
- **Given** KB tab 有 N 份 draft list
- **When** 多选 M 份 + [批量审批] + 共用 reason → 提交
- **Then** 后端串行/并行 promote 每份（一份失败不阻塞其他）→ 最终弹报告 modal `success: N / failed: M (列 audit_reason)`，失败 draft 留原位等手动 retry；成功 draft 已 mv 到正式区

#### AC-P4-5 · 三层验证套件（P18 + artifact schema §12）
- **Given** Phase 4 8 AC 走双 judge 验证
- **When** 任一 judge 跑
- **Then** judge1 (claude-opus-4-7) + judge2 (codex-gpt-5.4) + arbitration（黄）；j2 OAuth quota 用尽 → 标 **BLOCKED 不是 SKIP=PASS**（feedback `codex_judge2_finds_real_gaps` 锁死）；evidence pack 不完整（缺 §12 任一字段）→ INCONCLUSIVE 不通过

#### AC-P4-6 · 手 walkthrough 三场景（P22 — 脚本附录 §10）
- **Given** 8 AC 全 done + worktree DB 真数据 + AdaptiveRecallCoordinator enabled + fixture seed 拷贝完成
- **When** 小孙按 §10 三场景脚本端到端走（场景 1+2 V16.5 line 150 + 154-156；场景 3 v2 新增基于 P12 anti-drift 端到端需求）
- **Then** 每场景独立 evidence（截图 + 操作步骤 + 后端 log），三场景全 PASS

### 主线 B · go-live（3 AC）

#### ~~AC-P4-7 · worktree DB schema 升 Phase 1 migration~~ — **v4 取消（归 AC-P4-9 d）**
- **取消原因**：v3 commit 5min 后实测 `sqlite3 .tables` 显示 worktree DB schema 已全 OK（drizzle-instance.ts:91 INIT_SQL `CREATE TABLE IF NOT EXISTS` 25 表 boot 自动跑覆盖所有 Phase 1 表）
- 原立项前提（"缺 6 张表"）= Phase 3 evidence summary line 121-124 写错：`rooms` 是命名错（真表 `session_groups` 含 `room_id` 列）；`viewfinder_cache` 在 codebase 从不存在（viewfinder 实时计算不缓存）
- 真问题（4 张表 0 rows 数据缺）转 **AC-P4-9 d** 处理
- **教训**：plan/review/decision 三方未实测 → 写入 memory `feedback-measure-before-assert` 续案（v3 review chain 全员翻车的具体 case）

#### AC-P4-8 · AdaptiveRecallCoordinator production boot（v2 拆 5 子项）
- **Given** `packages/api/src/server.ts:239` 用 `createNoopAdaptiveRecallCoordinator()`
- **When** Phase 4 改 production wiring
- **Then**
  - (a) **critique LLM**: `new LlmCritiqueAgent({model: 'claude-sonnet-4-6'})` + Haiku 4.5 fallback（fallback 不等价 PASS，记 BLOCKED）
  - (b) **Level 2 search_wiki backend** wire（feature.md:152 定义 BM25+rerank）— **v3 verify**：`types.ts:68` interface 已定义但 0 production class，**Phase 4 Day 3 必新写 thin adapter** `class Level2HybridSearchBackend implements Level2Backend` wrap `HybridSearchProvider`（`hybrid-search-provider.ts:63` Phase 1 P11 已完成）；adapter 未就绪 → AC-P4-8 BLOCKED 不可 PASS
  - (c) **Level 3 messages FTS backend** wire（复用 `MessagesFtsLevel3Backend`，Phase 1 f91edf5）
  - (d) **Level 4 file read backend** wire（复用 `FileSystemLevel4Backend`，Phase 1 P13）
  - (e) **Level 5 sink** 拆 3 子件，各自独立 evidence + 依赖明示（v3）：
    - e1 `WikiEventsPersist` — 写 `wiki_events` action='recall_escalate'（依赖：`wiki_events` repo Phase 1 已有）
    - e2 `NotificationBroadcast` — 推审计通知到 R-001 房间（依赖：`AuditBroadcaster` service or WS pub/sub channel；核对 Phase 1/2 是否已有，缺则 Day 4-5 新写 thin pub/sub wrapper）
    - e3 `InspectorProjection` — Inspector UI hook 显示 escalate（依赖：Inspector pull endpoint，当前 prompt-inspector-tab 7 块靠 pull `/api/rooms/:id/prompt-inspector`，escalate 进第 8 块 Coverage section 走相同 pull 模式）
  - 验收：`server.ts:239` 改 `new AdaptiveRecallCoordinator({enabled: true, executorDeps: {critiqueAgent, levelBackends: {level2, level3, level4, level5}}})` + boot log `enabled=true, levels=[2,3,4,5]` + 真房间 recall 触发 → `prompt_audit` 9 字段真写入

#### AC-P4-9 · warnings + KB + 4 张 Phase 1 表真数据 + Inspector Coverage UI（v4 扩范围 — 吃 AC-P4-7 取消后 data seed 责任）
- **(a) warnings tab**：派生数据源读 `wiki/warnings/*.md` + `wiki_events` action='warning_raised' → tab 列表显示（type/severity/source/mtime）；**fixture seed**：`tests/fixtures/wiki/warnings/*.md` 造 5-10 份（含 chained_suspect / acl_violation / drift_detected / tainted_source / quota_exhausted），boot 时拷到 `.runtime/worktree-preview/data/wiki/warnings/`
- **(b) knowledge-base tab**：派生视图读 `wiki/index/*.md`（V16.5 chap 18 line 1953-1954）→ tab 列表显示（type/path/owner/mtime）+ multi-select hook（接 AC-P4-4）；**fixture seed**：`tests/fixtures/wiki/index/*.md` 造 5-10 份（4 大类）
- **(c) Inspector Coverage section UI**（AC-P3-8 b 接）：prompt-inspector 加第 8 块 unresolved 列表（GET `/api/rooms/:id/decisions/coverage`）+ click → PromoteModal trigger（接 AC-P4-1）
- **(d) v5 重写 · Phase 1 表 data seed**（范-r3 P2-1/2/3/4 修）：
  - **背景**：实测 worktree DB 4 表 0 rows（prompt_audit / wiki_events / room_decisions / wiki_leases），browser placeholder 真根因
  - **d1 `room_decisions` seed**：`tests/fixtures/db-seed/room-decisions.json` 5-10 行覆盖 R-001 房间 spec/pivot/commit/reject 4 种 type，含 1 个**场景 3 drift 触发用的核心 spec**
  - **d2 `wiki_events` seed**：`tests/fixtures/db-seed/wiki-events.json` 5-10 行（含 action='ingest_commit'/'promote'/'warning_raised'）
  - **d3 `wiki_leases` seed（v5 改）**：seed `active` + `expired` 2 类 rows（删 `released`，schema 不支持 status/released_at，drizzle-instance.ts:386-395 实证）；released 状态走 absence（该 path 不存在 lease row）或 acquire/release API 集成测试证明，不作静态 row seed
  - **d4 `prompt_audit` 永不 fixture seed**：fixture vs production write 路径冲突避免；只在 AC-P4-8 真房间 recall stimulus 后**真实**写入（Week 1 GO 条件验非空 + 含 recall_path/recall_satisfied/budget_consumed/escalate_reason 等 9 字段）
  - **d5 seed loader（v5 重写）**：
    - **per-table idempotent**：仅 seed 3 表（room_decisions / wiki_events / wiki_leases）— `prompt_audit` 永不触；每表独立 `COUNT(*)=0` 才 seed，有 rows 跳过（不覆盖真数据）
    - **单事务**：3 表 INSERT 在单个 `BEGIN IMMEDIATE` 事务内，失败 rollback 不留半 seed
    - **不做 DB 文件操作**：仅 INSERT，不 copy/swap/checkpoint/rename（不是 r2 P1 WAL 协议路径，纯单事务写）
    - **gate 来源（v5 明示 — 范 P2-4）**：双重 guard：
      - **primary**: `scripts/worktree-preview.ts` 生成 process env 加 `WORKTREE_PREVIEW=1`（Week 1 Day 1 实施时修 scripts/worktree-preview.ts 加这个 env，不改 .env 不碰 Iron Law 3）
      - **secondary**: SQLITE_PATH 路径包含 `.runtime/worktree-preview/` 作 second defense（防 env 误删后误触生产）
    - **单测（v5 final + r4 self P3-1）**：(1) preview gate on + 3 表空 → seed；(2) preview gate off → 不 seed；(3) 任一表已有 rows → 整事务跳过；(4) 事务中 INSERT 失败 → rollback 验 0 rows；(5) fixture JSON schema invalid → fail-closed 整事务不 INSERT 半数据 + log alert
- **不污染生产**：fixture 在 `tests/fixtures/` commit + runtime 在 `.runtime/` .gitignore + WORKTREE_PREVIEW=1 + SQLITE_PATH 路径 double guard + `prompt_audit` 0 接触 fixture（write 路径只有 production recall）

## 5. Open 拍板（8 个 — 小孙 2026-05-23 全过）

| # | 问题 | 拍板 |
|---|---|---|
| O1 | critique LLM 模型选 | ✅ **A** — Sonnet 4.6（feature.md:155 指定）+ Haiku fallback（fallback 不等价 PASS） |
| O2 | worktree DB migration 策略 | ~~A+约束 v2~~ → **v4 整个作废**：实测 schema 已 OK 不需 migration，AC-P4-7 取消归 AC-P4-9 d data seed |
| O3 | warnings 派生 job | ✅ **B** — 复用 `wiki_events` 查询不新增第 12 job + fixture seed 验真数据 |
| O4 | walkthrough 三场景原文 | ✅ **C** — v2 附录 §10 inline 三场景脚本（场景 1+2 V16.5 line 150/154-156；场景 3 v2 新增） |
| O5 | series/rollback modal 范围 | ✅ **C** — Series 复用 IngestModal "加入系列"字段（V16.5 line 2563-2564）；Rollback read-only preview；写型 rollback 推 F028 |
| O6 | 三层验证套件 | ✅ **B** — 复用 Phase 2/3 evidence runner + 锁 artifact schema §12 + INCONCLUSIVE 语义 |
| O7 | Phase 3 升 PASS 时机 | ✅ **B+矩阵** — walkthrough 时顺带 + §11 映射矩阵逐项证据升级，不可 blanket PASS |
| O8 | F028 边界 | ✅ **A** — 严守不做；命令面板 4 写命令 + 写型 rollback + memory_preflight / sessions ledger / Level 6 / Prompt Inspector 升级全部 F028 |

## 6. 风险（v2 加 6 项 — 范 P2-4）

| 风险 | 影响 | 缓解 |
|---|---|---|
| ~~worktree DB migration 翻车~~ | **v4 删**：AC-P4-7 取消，schema 已 OK 无 migration | — |
| **🆕 v4 AC-P4-9 d seed loader 误触生产** | seed 覆盖生产真 wiki_events/room_decisions | `WORKTREE_PREVIEW=1` 环境变量 gate + boot 检测 4 表 0 rows 才 seed（含 rows 跳过）+ 单测 |
| **AdaptiveRecallCoordinator critique LLM OAuth quota 用尽** | AC-P4-8 BLOCKED / AC-P4-5 验证连锁 BLOCKED | Sonnet 4.6 切 Haiku 4.5 fallback；critique 不命中走 rule-based |
| **工期超 26 天**（Phase 3 教训：估 26-32 实际 30+）| Phase 4 滑到 6-7 周 | Week 3 r1 review 强制裁 AC（AC-P4-9 a/b 可降为 empty-state 接通，go-live 目标显式降级）|
| **F028 边界扯不清** | AC scope 蔓延 | O8 严守 + 任何"顺手"PR 必须升级小孙 |
| **walkthrough 三场景小孙手工时间** | Week 4 阻塞 | Day 18-20 预约小孙 2-3 单时段 + 详细脚本 §10 |
| **AC-P4-4 批量审批部分失败 UX** | 报告 modal 不易读 | 单测 + 范-r1 重点 review UI 文案 |
| **PromoteModal target 路径选择 UX** | 用户填错路径 → audit reject 多 | 提供 wiki/{concepts,rules,methods,people}/ 下拉 + path validator + recently used |
| **Inspector Coverage section UI 与 PromoteModal 耦合**（AC-P4-9 c 依赖 AC-P4-1）| Week 3 Day 13 阻塞 if AC-P4-1 未完 | Week 2 必须 Day 6-7 完成 AC-P4-1 |
| **🆕 Level 2 placeholder 假 go-live**（范 P2-4 + P1-1）| AC-P4-8 误判 PASS / 真 wiki 召回失效 / prompt_audit recall_path 错记 | r2 AC-P4-8 写 "Level 2 未就绪 → BLOCKED 不可 PASS"；boot 时核对 `Level2Backend.searchWiki()` 存在 |
| ~~DB 半迁移 / 空库 / 运行路径丢失~~ | **v4 删**：AC-P4-7 取消，无 migration 步骤 | — |
| **🆕 API origin 误连 Next server / worktree port 未分配 / Iron Law 4** | 浏览器实测打错端口 / Iron Law 4 违规 | 统一 API base helper (`getApiBaseUrl()`) + 只用 `pnpm worktree:preview` 输出 URL + Iron Law 4 lint |
| **🆕 AC-P4-9 无非空派生数据** | tab API 接通但显示空白 / 不能验"真数据 go-live" | fixture seed 5-10 份（v2 加）+ AC 要求 browser 截图显示非空 rows |
| **🆕 manual browser evidence 不足** | walkthrough 截图丢失 / 后端 log artifact 缺 | §12 artifact schema 锁定 screenshots/logs 必字段 + AC-P4-5 INCONCLUSIVE 规则 |
| **🆕 fallback 模型质量漂移** | Haiku 4.5 fallback 时 critique 误判 / recall 命中率降 | fallback 路径标 BLOCKED 不等价 PASS + 单测覆盖 fallback 行为 |

## 7. 依赖

### Phase 1 依赖（v3 加 3 dependency gap 明示）
- `prompt_audit` schema 9 字段（recall_path / recall_satisfied / escalate_reason / budget_consumed 等）— Phase 1 已有
- `wiki_events` schema + action enum（含 'promote' / 'demote' / 'recall_escalate' / 'warning_raised'）— Phase 1 已有
- `room_decisions` ledger（AC-P4-9 c Coverage section 数据源）— Phase 1 已有
- `update_wiki` core（AC-P4-1 promote 落盘复用）— Phase 1 已有
- AdaptiveRecallExecutor 状态机 + Critique Agent（LlmCritiqueAgent）+ MessagesFtsLevel3Backend + FileSystemLevel4Backend（AC-P4-8 wire 复用）— Phase 1 已有
- `HybridSearchProvider`（P11 完成 BM25+cosine+LLM rerank stub）— Phase 1 已有，但 wrap 它的 `Level2Backend` adapter Phase 4 新写
- 5 层 sanitize（AC-P4-2 audit_reason 显示复用）— Phase 1 已有
- **🆕 Phase 4 新写 (3 dependency gap)**：
  1. **`Level2HybridSearchBackend implements Level2Backend`**（adapter，wrap HybridSearchProvider；types.ts:68 interface 已定 production 缺）— AC-P4-8 b
  2. **V14 二次审计 service**（V16.5 line 838-846 3 步检测 + reject reason format）— AC-P4-1 b
  3. **IngestModal "加入系列"字段 + backend `series_id` 持久化**（V16.5 line 2563-2564；ingest-modal.tsx:37 注释明示 backend Phase 4 才接）— AC-P4-3 e

### Phase 2 依赖
- 11 jobs runtime（warning_raised job 触发点 — AC-P4-9 a 数据源）
- SchedulerRuntime + lease + fencing（已 go-live Phase 3）
- DocsWatcher（walkthrough 场景 2 触发）
- WikiCompilerDebounce（warnings/index 派生触发）

### Phase 3 依赖
- 全部前端面板（StatusPanel 拖宽 + RuntimeLog 5-tab + composer slash + IngestModal + viewfinder/wake drawer）
- 6 个 endpoint（drafts / viewfinder / prompt-inspector / ingest-preview / ingest-commit / decisions）
- a2a-drawer-store / layout-store / runtime-log-store

### 外部依赖
- Anthropic API OAuth quota（critique LLM + 双 judge）
- Codex CLI（j2 异构 reviewer）
- 小孙手工 walkthrough（AC-P4-6 — 2-3 时段）

## 8. 下一步（v3 final）

1. ✅ **v1 → 范-r1 CONDITIONAL** (P1×2 + P2×4 + P3×3 + 8 Open)
2. ✅ **v2 修订**（9 项 r1 建议全接受 + 小孙拍 3 方向 Q1/Q2/Q3）
3. ✅ **v2 → 范-r2 CONDITIONAL** (P1×1 + P2×2)
4. ✅ **v3 final**（范-r2 全接受 + 黄 verify 3 dependency gap + 小孙拍跳 r3 review）
5. **commit plan** 到 `docs/plans/F027-phase4-implementation-plan.md` + `docs(F027-P4): Phase 4 立项 plan v1 → v3 final（范 r1+r2 review chain + 3 gap verify）`
6. **Week 1 Day 1 开干**：AC-P4-9 d Phase 1 表 data seed（v5：scripts/worktree-preview.ts 加 WORKTREE_PREVIEW=1 env + 写 seed loader 单事务 INSERT 3 表 + 单测 4 项）

## 9. 实施流程约定

每 Day / Week 走：
1. 实施 → 自检（quality-gate）→ requesting-review
2. 范德彪 r1 review → r2 修复（receiving-review）→ GO
3. Week 收尾 → merge-gate 检查 → 进下 Week
4. Phase 收口 → evidence pack 双 judge + arbitration → 合 dev gate → 小孙拍 → 合 + push

worktree 沿用 `.worktrees/F027` branch `feat/F027-unified-memory-architecture`（不开新；Phase 4 commit 接 63e69f9 之后）。

review scratch（review-request / confirmation md）写 `.runtime/reviews/`，**不 commit**（feedback `no_commit_review_docs`）。

evidence pack（result.json + judges/* + arbitration + screenshots）落 `docs/features/F027/evidence/phase4/AC-P4-<N>/`，**可 commit**（产物不是 scratch）+ 符合 §12 artifact schema。

---

## 10. 附录 · walkthrough 三场景脚本（v2 新增 — 范 P3-1）

> **范 P3-1 反馈**：v1 O4 "walkthrough 三场景原文待找"不能留到实施期。v2 inline 三场景脚本到 plan 附录，walkthrough 期间小孙照此执行不需现场解释。
>
> **场景 1+2 出处**：V16.5-final.md line 150 + 154-156（V16.5.3 修订记录小孙端到端 walkthrough）
> **场景 3 出处**：v2 新增，基于 Phase 1 P12 anti-drift 端到端需求 + Phase 4 AC-P4-9 c Inspector Coverage UI 验证

### 场景 1 · 外部资料 drop → 召回命中端到端

**前置（v5 + 范-r3 P2-5）**：worktree-preview 启动（schema 已自动 OK 无需 migration）；AC-P4-9 d seed loader 跑过（**d1-d3 = `room_decisions`/`wiki_events`/`wiki_leases` 非 0 rows**；`prompt_audit` 允许为 0，等 step 1.5 后必须变非空）；AC-P4-9 a/b fixture wiki 拷贝；R-001 房间已存（worktree DB 实测 5 rows session_groups）；AC-P4-8 AdaptiveRecallCoordinator enabled。

| Step | 操作 | 期望结果 | Evidence |
|---|---|---|---|
| 1.1 | 小孙 R-001 房间 composer 拖一份 `tests/fixtures/wiki/rag-paper.md`（含 RAG 论文摘要） | composer 区域显示 [📎 rag-paper.md] 附件 chip | screenshot composer 含 chip |
| 1.2 | IngestModal 自动弹出，5 层 sanitize 预扫 | modal 显示类型猜测（external-ref/concept/method）+ 系列字段 + tainted_source flag | screenshot ingest-modal |
| 1.3 | 小孙选类型 = concept + reason 编辑 + [编译]（preview） | 后端 `/api/wiki/ingest/preview` 返 LLM 编译结果 schema 完整 | screenshot preview 区域 + backend log preview endpoint |
| 1.4 | 小孙 [Commit 入库] | `/api/wiki/ingest/commit` 落盘 `wiki/concepts/draft/_auto/rag-paper.md` + `wiki_events action='ingest_commit'` | screenshot success toast + DB query `wiki_events` 新行 |
| 1.5 | 小孙在 chat 输入 "RAG 论文里如何处理 long context?" | agent (sonnet) 触发 Adaptive Recall Level 2 search_wiki BM25+rerank | screenshot agent response（含 wiki 内容）+ `prompt_audit.recall_path='level2'` + `recall_satisfied=true` |
| 1.6 | KB tab 打开 | rag-paper.md 出现在 draft list（_auto/ 子目录）+ [Promote] 按钮可点 | screenshot KB tab list |
| 1.7 | 小孙点 [Promote] | PromoteModal 弹出 + 选 target = `wiki/concepts/rag-overview.md` + reason | screenshot PromoteModal |
| 1.8 | V14 二次审计 PASS → mv | wiki 落正式区 + `wiki_events action='promote'` + toast | screenshot success + `wiki_events` 行 |

**验收**：1.1-1.8 全步骤截图 + log + DB query 三套 evidence。

### 场景 2 · docs/* backfill → KB tab 真数据

**前置**：DocsWatcher 已启用（Phase 2 done）；KB tab fixture seed 已加（AC-P4-9 b）。

| Step | 操作 | 期望结果 | Evidence |
|---|---|---|---|
| 2.1 | 小孙在 worktree 新建 `docs/features/F999-test.md`（测试用） | DocsWatcher 60s 内检测 + 自动 ingest（V16.5 chap 17 line 2661 锁定 60s debounce 真相源；final-vision P1-2 r2 拍板 amend：原 5s SLA 与 V16.5 矛盾，统一改 60s） | log DocsWatcher trigger + ingest_event |
| 2.2 | 自动 sanitize + 编译 | 落 `wiki/concepts/draft/_auto/2026-05-23-F999-test.md` + `wiki_events action='ingest_auto'` | DB query + 文件存在 |
| 2.3 | KB tab 刷新 | F999-test.md 出现在 _auto 子目录 list（区别于 _drafts 主流） | screenshot KB tab |
| 2.4 | warnings tab 打开 | 显示 fixture seed 5-10 份 warnings（chained_suspect / acl_violation 等）+ 真 mtime | screenshot warnings tab |
| 2.5 | 小孙在 KB tab 多选 3 份 + [批量审批] + 共用 reason | AC-P4-4 部分失败语义：成功 N + 失败 M（含 audit_reason） | screenshot 报告 modal + DB query |
| 2.6 | 删除测试文件 `rm docs/features/F999-test.md` | DocsWatcher 检测 + 不删 wiki（draft 留原位等手动 demote） | log + 文件仍在 |

**验收**：2.1-2.6 全步骤 evidence。

### 场景 3 · viewfinder 防漂移触发（v2 新增）

**前置**：Phase 1 P12 viewfinder anti-drift 已 done；jaccard drift 算法 ready；Inspector Coverage section UI 已上（AC-P4-9 c）。

| Step | 操作 | 期望结果 | Evidence |
|---|---|---|---|
| 3.1 | R-001 房间已有 5+ decision（含 1 个 type=spec/pivot 的核心共识，例如 "F027 走 V16.5 5 级 recall"） | viewfinder §5 关键决策段含该 spec | screenshot viewfinder + DB `room_decisions` query |
| 3.2 | 小孙在 chat 注入与该共识冲突的 decision："F027 改走 3 级 recall（去掉 Level 4-5）" | decision extractor 写入 `room_decisions` | DB 新行 |
| 3.3 | viewfinder anti-drift 算法触发（jaccard 算法跑） | 检测 drift（新 decision tokens vs 老 spec tokens jaccard < threshold） | log viewfinder drift detect + `wiki_events action='drift_detected'` |
| 3.4 | 推审计通知到 R-001 房间 | UI 显示通知 + Inspector Coverage section unresolved 列表多 1 行 | screenshot Coverage section + 通知 toast |
| 3.5 | 小孙点 Coverage section 的 unresolved item | PromoteModal 弹出（AC-P4-9 c 接 AC-P4-1）→ 小孙选 [supersede 旧 spec] 还是 [reject 新 decision] | screenshot PromoteModal |
| 3.6 | 选 [supersede] → V14 二次审计 → 写新 ledger 行 | `room_decisions` 加新行 `supersede_id=旧 spec id` + viewfinder §5 更新为新 decision | DB query + viewfinder 刷新 screenshot |

**验收**：3.1-3.6 全步骤 evidence；场景 3 是 Phase 1 P12 + Phase 4 AC-P4-9 c 端到端闭环验证。

---

## 11. 附录 · Phase 3 升 PASS 映射矩阵（v2 新增 — 范 P3-2）

> **范 P3-2 反馈**：v1 "Week 4 一句顺带升级" 6 个 CONDITIONAL_PASS 不够。v2 加映射矩阵：每条 P3 CONDITIONAL_PASS 绑定 P4 AC、walkthrough step、截图/log/judge artifact。

| Phase 3 AC | 原 verdict | 升级路径 P4 AC | walkthrough step | evidence 收集 |
|---|---|---|---|---|
| AC-P3-1 拖宽 | CONDITIONAL_PASS (browser fps + reload 像素 BLOCKED) | 间接 | Week 4 Day 18 walkthrough 启动时手测拖宽 | screenshot 拖宽 360→1200 reload 后像素一致 |
| AC-P3-2 5-tab 切换 | CONDITIONAL_PASS (browser scroll ±10px BLOCKED) | 间接 | walkthrough 三场景全程 tab 切换 | screenshot tab 切换前后 scroll position 一致 |
| AC-P3-3 inspector 7 块 | CONDITIONAL_PASS (真数据依赖 P3-9 + DB schema) | AC-P4-9 d + AC-P4-8 | 场景 1 step 1.5 + 场景 3 step 3.3-3.4 | screenshot inspector 7 块非空（含 recall_path 真数据） |
| AC-P3-6 IngestModal 3 入口 | CONDITIONAL_PASS (3 入口 browser modal BLOCKED) | AC-P4-9 d（DB seed 后真数据）| 场景 1 step 1.1-1.4 走入口 A（拖）+ 入口 B（[+ Drop]）+ 入口 C（`/ingest`） | screenshot 3 入口分别触发 IngestModal |
| AC-P3-8 b Inspector unresolved UI | CONDITIONAL_PASS (推 Phase 4) | **AC-P4-9 c** | 场景 3 step 3.4-3.5 | screenshot Coverage section 非空 + click trigger PromoteModal |
| AC-P3-9 Adaptive Recall wiring（v3 补 — 范-r2 P2-2）| CONDITIONAL_PASS (server.ts:239 noop; ready-for-Phase-4 wiring) | **AC-P4-8** | 场景 1 step 1.5 真房间 recall 触发 | screenshot inspector recall_path + DB `prompt_audit` 9 字段真写入 + boot log `enabled=true, levels=[2,3,4,5]` + double-judge artifact `evidence/phase4/AC-P4-8/` |

**评判规则**：每条 P3 AC 6 项 evidence 全集齐 → 升 PASS；任一 evidence 缺 → 保持 CONDITIONAL_PASS（不可 blanket）。

---

## 12. 附录 · AC-P4-5 evidence pack artifact schema（v2 新增 — 范 P3-3）

> **范 P3-3 反馈**：复用 Phase 2/3 runner OK 但 artifact schema 要锁，缺字段必须 INCONCLUSIVE 不可 PASS。

### 每个 AC 必须的最小 artifact

`docs/features/F027/evidence/phase4/AC-P4-<N>/` 下：

```
AC-P4-<N>/
├── result.json                        # AC 元数据 + final verdict
├── judges/
│   ├── judge1_claude-opus-4-7.json   # j1 verdict + reasoning + cited code/log lines
│   ├── judge2_codex-gpt-5.4.json     # j2 verdict + reasoning + cited code/log lines
│   └── arbitration.json              # 黄仲裁（j1 vs j2 不一致时）+ final verdict
├── screenshots/                       # browser 实测截图（如有）
│   ├── step-N.png                    # 每 walkthrough step 一张
│   └── ...
└── logs/                              # 后端 log 摘录
    ├── api-server.log                # API server 关键 log（migration / recall / promote）
    ├── job-trace.json                # 调度器 job trace
    └── db-query-*.json               # DB query 结果（wiki_events / prompt_audit / room_decisions）
```

### `result.json` 最小字段

```json
{
  "ac_id": "AC-P4-X",
  "title": "...",
  "phase": "phase4",
  "verdict": "PASS | CONDITIONAL_PASS | FAIL | BLOCKED | INCONCLUSIVE",
  "double_pass": {
    "judge1_verdict": "...",
    "judge2_verdict": "...",
    "arbitration_verdict": "...",
    "consensus": true
  },
  "evidence_paths": {
    "screenshots": ["screenshots/step-1.png", ...],
    "logs": ["logs/api-server.log", ...],
    "code_anchors": ["packages/api/src/server.ts:239", ...]
  },
  "blocked_reason": "...",  // verdict=BLOCKED 时必填
  "inconclusive_reason": "..."  // verdict=INCONCLUSIVE 时必填
}
```

### `judges/*.json` 最小字段

```json
{
  "judge_id": "claude-opus-4-7 | codex-gpt-5.4",
  "ac_id": "AC-P4-X",
  "verdict": "...",
  "reasoning": "...",  // 包含 file:line 实证
  "cited_evidence": ["screenshots/step-1.png", "logs/api-server.log#L123", ...],
  "spec_gate": "PASS | FAIL",
  "mechanism_gate": "PASS | FAIL",
  "feature_gate": "PASS | FAIL",
  "p1_findings": [...],
  "p2_findings": [...],
  "p3_findings": [...]
}
```

### INCONCLUSIVE 规则（强制）

- `result.json` 缺任一必字段 → INCONCLUSIVE
- `judges/judge1.json` 或 `judge2.json` 缺 → INCONCLUSIVE
- `judges/arbitration.json` 缺（且 j1/j2 不一致时）→ INCONCLUSIVE
- screenshots/ 空 + AC 需要 browser 实测 → INCONCLUSIVE
- logs/ 空 + AC 需要后端验证 → INCONCLUSIVE

**INCONCLUSIVE 不等价 BLOCKED**：BLOCKED 是"外部因素阻塞"（如 quota 用尽），INCONCLUSIVE 是"evidence 没收齐"。两者都不可合 dev。

---

**v5 由黄仁勋（Claude opus-4-7）2026-05-23 修订；v3 翻车 → v4 重设计 → 范-r3 CONDITIONAL P2×6 全接受 → v5 修；待范-r4 review 后小孙拍 final。Week 1 Day 1 开干 AC-P4-9 d Phase 1 表 data seed（单事务 + per-table idempotent + double gate）。**
