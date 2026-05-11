---
id: F027-phase1
title: F027 Phase 1 后端基础设施 · 实施 plan
status: spec
parent: F027 (docs/features/F027-unified-memory-architecture.md)
created: 2026-05-11
owner: 黄仁勋
plan_truth_source: docs/plans/V16.5-final.md (chap 21 phase 拆分)
---

# F027 Phase 1 · 后端基础设施实施 plan

> **scope**：V16.5 plan chap 21 P0-P15 + P21（共 19 个 phase）
>
> **目标工时**：30-45 单人天 / 6-9 周（Phase 1 内部 P0-P15 部分可并行）
>
> **此 plan 仅覆盖 Phase 1**。Phase 2 调度 / Phase 3 前端 / Phase 4 审批 UI 各自独立 plan，待 Phase 1 schema 冻结后启动。

## 1. Phase 1 依赖 DAG

```
                                    ┌─ P0 schema 契约（全部依赖）
                                    │
                                    ├─ P1 wiki_events ──────────┬─ P2 WikiCompiler ──── P21 Atomic Manifest
                                    │                           │
                                    │                           └─ P3 update_wiki MCP ── P3.5 lease ── P3.6 Handbook 切片
                                    │
                                    ├─ P10 wiki_memories ──────── P11 memory_preflight ─┐
                                    │                                                   │
                                    ├─ P4 sanitize ── P4.5 multi-drop ── P4.6 LLM 编译 3 阶段
                                    │                                       │           │
                                    │                                       └─ 依赖 P3.6 Handbook
                                    │
                                    ├─ P5 assemblePrompt 扩展 ─────────────────────────┘
                                    │
                                    ├─ P7 RoomCompiler ── P7.5 startup reconciler
                                    │
                                    ├─ P8 agent-sessions ledger ── P11 memory_preflight 用
                                    │
                                    ├─ P9 alias-aware capability registry（独立）
                                    │
                                    ├─ P11 memory_preflight ── P12 viewfinder anti-drift ── P13 Adaptive Recall
                                    │
                                    ├─ P14 FTS5 + query_messages MCP ── P15 BM25 + LLM rerank
                                    │
                                    └─ Critical Path: P0 → P1 → P3 → P3.6 → P4.6 → P6（IngestModal 后端）
                                       ≈ 决定 Phase 1 最早完成时间
```

**并行性**：
- **多 agent 并行**：P0 schema 冻结后，P1/P10/P4/P9 可同时启动（不同 agent 拆领）
- **单人串行 fallback**：按 critical path 走，约 30-45 天

## 2. 每周里程碑（单人 35 天估算 / 多 agent 并行 5 周）

### Week 1 · 架构契约 + schema 落地（基础打桩）

| Day | Phase | 任务 | Commit | Evidence |
|---|---|---|---|---|
| 1-2 | **P0** | 架构契约文档 + 4 张表 schema 定稿（drizzle-orm 风格，对账 F011） | `feat(F027-P0): 4 表 schema + drizzle migration` | schema diff + EXPLAIN 验证 |
| 3 | **P1** | wiki_events event store（append-only + 单一提交协议 + state machine） | `feat(F027-P1): wiki_events event store + 提交协议` | unit test (state transitions) |
| 4 | **P10** | wiki_memories 表（5 type + canonical_owner 字段） | `feat(F027-P10): wiki_memories 1 表多 type` | schema + 防漂桶 lint test |
| 5 | **P21** | Atomic Manifest Protocol（与 P2 集成基础） | `feat(F027-P21): Atomic Manifest write/read 协议` | tmp → swap → cleanup 测试 |

**Week 1 验收**：4 张新表全建 + index/EXPLAIN ≤ 50ms（对应 AC-P1-1）+ commit 4-5 个

---

### Week 2 · WikiCompiler + MCP 框架

| Day | Phase | 任务 | Commit | Evidence |
|---|---|---|---|---|
| 6-7 | **P2** | WikiCompiler 派生视图（5s debounce）+ index/sources/log 5 文件生成 | `feat(F027-P2): WikiCompiler 派生视图 + debounce` | fixture：写 wiki_event → 5s 后派生视图刷新 |
| 8-9 | **P3** | update_wiki MCP 工具（ACL + CAS + lease + fencing）挂 F023 mcp/server.ts | `feat(F027-P3): update_wiki MCP + ACL/CAS/lease/fencing` | fuzz 100 并发写测试（AC-P1-2）|
| 10 | **P3.5** | compiler_leader lease + DB 触发器 + leader_term | `feat(F027-P3.5): compiler_leader lease + DB 触发器` | 双 runtime 实例 lease 抢占测试（AC-P2-5）|

**Week 2 验收**：可以从 MCP 写 wiki_events + 派生视图自动刷新 + lease 防多 runtime 并发

---

### Week 3 · Handbook 切片 + sanitize 5 层

| Day | Phase | 任务 | Commit | Evidence |
|---|---|---|---|---|
| 11 | **P3.6** | Agent Wiki Handbook 文件骨架 + 4 H2 切片 + sliceHandbookByH2() | `feat(F027-P3.6): Handbook 4 H2 切片 + slice 函数` | red/green dedupe lint fixture（AC-P1-6）|
| 12-13 | **P4** | raw drop sanitize 5 层防御（借鉴 F018 sanitizeHandoffBody）+ tainted_source flag | `feat(F027-P4): sanitize 5 层防御` | 5 层 fixture 全命中（AC-P1-4）|
| 14 | **P4.5** | multi-drop cross-correlation（7 天滑动窗口 + embedding similarity） | `feat(F027-P4.5): multi-drop cross-correlation` | series vs chained_suspect fixture（AC-P1-5）|
| 15 | **P9** | alias-aware capability registry + handoff 中性改写 | `feat(F027-P9): alias-aware capability + 中性改写` | red-leaks-sender vs green-neutralized fixture（AC-P1-13）|

**Week 3 验收**：sanitize 全 5 层运行 + 三层防御链（sanitize → multi-drop → alias-aware）+ 8 commit

---

### Week 4 · LLM 编译 3 阶段 + assemblePrompt 扩展

| Day | Phase | 任务 | Commit | Evidence |
|---|---|---|---|---|
| 16-17 | **P4.6** | LLM 编译 3 阶段（pre / compile / post）含 cross_refs / dedup / canonical_owner | `feat(F027-P4.6): LLM 编译 3 阶段` | RAG paper fixture 端到端 PASS（AC-P1-3）|
| 18-19 | **P5** | 扩展 F004 assemblePrompt 加 7 字段 + 5 注入区段 | `feat(F027-P5): assemblePrompt 7 字段 + 5 注入区段` | grep "Iron Laws" = 1 + 5 区段顺序固定（AC-P1-7）|
| 20 | **P7** | RoomCompiler cursor + checkpoint + 二阶段提交 + sealed_at | `feat(F027-P7): RoomCompiler cursor 二阶段提交` | crash recovery test（断点续编）|

**Week 4 验收**：LLM 编译能从 raw drop 编出完整 entity + assemblePrompt 唯一注入合约生效 + B022 防回归通过

---

### Week 5 · 召回层 + agent-sessions ledger（北极星兑现）

| Day | Phase | 任务 | Commit | Evidence |
|---|---|---|---|---|
| 21 | **P7.5** | startup reconciler（wiki_events.state='pending' / room_checkpoints 处理） | `feat(F027-P7.5): startup reconciler` | kill -9 后重启状态恢复 |
| 22 | **P8** | agent-sessions ledger（per-agent S-XXXX.md + sharding + yearly pack） | `feat(F027-P8): agent-sessions ledger + sharding` | 100k session 模拟 + sharding 后 active < 1k（AC-P1-8）|
| 23-24 | **P11** ★ | memory_preflight + Query Quality Gate + Hard Gate | `feat(F027-P11): memory_preflight + Quality Gate` | **北极星 AC-P1-11**：桂芬进 R-205 自动召回 F011 fixture |
| 25 | **P14** | FTS5 + query_messages MCP（中文分词 + 触发器同步） | `feat(F027-P14): FTS5 + query_messages MCP` | 中文 query 命中 messages 表 + FTS5 同步无漏 |

**Week 5 验收（关键里程碑）**：**北极星兑现** — 新 agent 进新 room 自动不白板 + 5 commit

---

### Week 6 · viewfinder anti-drift + Adaptive Recall + BM25

| Day | Phase | 任务 | Commit | Evidence |
|---|---|---|---|---|
| 26-27 | **P12** | Viewfinder anti-drift（room_decisions append-only + tombstone + Decision Coverage Check） | `feat(F027-P12): viewfinder anti-drift + decision ledger` | 100 iter telephone game fixture 漂移度 ≤ 30%（AC-P1-10）|
| 28-29 | **P13** | Adaptive Recall Policy 5 级 fallback + per-turn budget | `feat(F027-P13): Adaptive Recall 5 级 fallback` | 5 级 fixture 全触发 + escalate 写 wiki_events（AC-P1-12）|
| 30 | **P15** | search-bm25 + LLM rerank（复用 OpenHarness reference） | `feat(F027-P15): BM25 + LLM rerank` | hybrid (vectorSearch + BM25) 命中率提升 ≥ 15% vs 单 vector |

**Week 6 验收**：召回质量提升 + 决策不漂移 + Phase 1 全部 19 phase 落盘

---

### Week 7 · evidence pack 收集 + 整合验证 + buffer

| Day | 任务 | Commit |
|---|---|---|
| 31-32 | 14 个 AC 全部 evidence pack 整理（prompt.txt / agent_response.txt / db_dump.sql / wiki_state.tar.gz / config.hash / result.json）落 `docs/features/F027/evidence/phase1/` | `docs(F027-P1): evidence pack 收集` |
| 33-34 | 异构双 judge 跑（judge1 Anthropic Opus + judge2 待小孙拍）+ 仲裁报告 | `docs(F027-P1): 双 judge 报告 + 仲裁` |
| 35 | Phase 1 整体收尾 + 准备 Phase 2 调度 spec | `docs(F027-P1): Phase 1 done + Phase 2 kickoff note` |

**Week 7 验收**：Phase 1 全部 14 个 AC 全绿 + evidence pack 完整 + 进入 Phase 2

---

## 3. 中间检查点（给小孙汇报节奏）

| 时点 | 内容 | 你的动作 |
|---|---|---|
| **Week 1 末** | schema 落地 + EXPLAIN 验证 | 看 commit + 拍 schema 是否需要调整（之后改 schema 代价大）|
| **Week 2 末** | MCP 框架 + lease 全绿 | 看 fuzz 报告 |
| **Week 3 末** | sanitize 5 层 + multi-drop + alias-aware（防御链全建）| 看 fixture 红绿样例 |
| **Week 4 末** | LLM 编译 + assemblePrompt 扩展 | 看 RAG paper 端到端 fixture 输出 |
| **Week 5 末** ★ | **北极星兑现** memory_preflight + sessions ledger | **手动 walk-through**：你新建 R-205 召新 agent，看是否自动召回 |
| **Week 6 末** | 召回 + viewfinder + BM25 全部 | 看决策不漂移 fixture |
| **Week 7 末** | evidence pack + 双 judge + Phase 1 done | 拍是否进 Phase 2 |

## 4. 中间检查点失败的处理

按 V16.5 chap 16 验证矩阵：
- 任意 AC FAIL → 当周不前进，先修
- AC INCONCLUSIVE → 补 evidence 再 judge
- AC BLOCKED（如 OAuth quota）→ 留警示，不当 PASS
- 异构双 judge 分歧 → 第三方仲裁（小孙最终拍）

## 5. 风险 + 兜底

| 风险 | 触发条件 | 兜底 |
|---|---|---|
| **schema 改动期晚到** | Week 4-6 发现 schema 需扩字段 | Phase 1 P0 schema 留 2 个 reserved 字段（`reserved_1` `reserved_2` TEXT NULL）防应急 |
| **LLM 编译质量飘** | Week 4 RAG paper fixture 输出不稳定 | 提前抛锚：固定 fixture 输入 + ±0.05 容差 + Opus 4.7 lock model snapshot |
| **memory_preflight 召回不命中** | Week 5 北极星 fixture 失败 | embedding service 可用性预检（B019 已修，验证一次再依赖）|
| **evidence pack 工时低估** | Week 7 收集时发现遗漏 | 每个 phase commit 时同步落 evidence（不等到 Week 7 集中收）|
| **judge OAuth quota 耗尽** | Week 7 跑双 judge 时 quota 被 squeeze | 提前预约 judge2 provider quota + 留备份 judge3 |

## 6. 中间 commit 节奏 + worktree 管理

按 feedback memory `feedback_feature_completion_before_merge`：
- **Phase 1 全 14 AC 做完前禁合 dev**
- **Phase 级中间 commit 留在 worktree**（不 push dev）
- worktree branch: `feat/F027-unified-memory-architecture`
- F024 port 自动分配（:3100+ 前端 / :8800+ 后端，**不抢主库 :8787**）
- 中间 commit 节奏：每个 phase 1 commit（共 19 commit）+ Week 7 evidence pack 1 commit ≈ 20 commit/Phase 1

## 7. Phase 1 done 定义

全部以下满足才标 Phase 1 = done：
- [ ] 14 个 AC 全部 PASS（不含 BLOCKED / INCONCLUSIVE）
- [ ] evidence pack 完整（每 AC 一份）
- [ ] 异构双 judge 报告 + 仲裁结论
- [ ] worktree :3100/:8800 起服务后小孙手动 walk-through 通过
- [ ] git diff dev..feat/F027 review 过
- [ ] Phase 2 调度 spec kick-off 文档落地

---

## 8. 后续 Phase 2/3/4 plan（待 Phase 1 done 后启动）

| Phase | 工时（单人天）| Plan 文件 |
|---|---|---|
| **Phase 2 · 调度** | 5-7 | `docs/plans/F027-phase2-implementation-plan.md`（Phase 1 done 后写）|
| **Phase 3 · 前端** | 12-15 | `docs/plans/F027-phase3-implementation-plan.md` |
| **Phase 4 · 审批 UI + 验证** | 11-13 | `docs/plans/F027-phase4-implementation-plan.md` |

---

**最终归属**：本 plan 仅 F027 Phase 1。Phase 1 done 后 review 节奏 + 工时实际值 → 调整 Phase 2/3/4 plan。
