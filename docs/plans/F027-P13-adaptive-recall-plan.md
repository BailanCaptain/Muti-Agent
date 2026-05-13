---
id: F027-P13
title: Adaptive Recall Policy 5 级 fallback + Hard Gate（V16.5 chap 12 落地）
status: confirmed（小孙 2026-05-13 拍 5 个 Open · 开干）
owner: 黄仁勋
created: 2026-05-13
plan_truth_source: docs/plans/V16.5-final.md chap 12（行 1367-1444）
feature: F027 统一记忆架构
phase: Phase 1（Week 6 Day 28-29）
ac: AC-P1-12
depends_on:
  - P11 memory_preflight（✅ done — hard-gate.ts + HybridSearchProvider + conservativeStubJudge）
  - P12 viewfinder anti-drift（✅ done — 9a1c7b3）
  - P14.b messages_fts + query_messages MCP（✅ done — f91edf5；Level 3 后端就位，无需等待）
  - P15 LLM rerank（❌ 未做但不阻塞 — Level 2 Critique 走独立 Sonnet 4.6 调用）

## 拍板记录（小孙 2026-05-13）

1. **范围切法 = A（等 P14）** → P14.b 实际已 done (f91edf5)，Level 3 query_messages repo 就位，**等同立即开干**
2. **Critique LLM = Sonnet 4.6**（同 P12 extractor，准确度优先；延迟靠 budget cap 控）
3. **Level 4 严格度 = 严格** — 仅 exact path 触发 read_wiki，fuzzy path 不触发
4. **AC L4 fixture = 手工** — hand-crafted room，不走 critique mock
5. **范 review 节奏 = 一次性 r1** — P13.1-.5 全做完 + AC 全绿后一次性提交范
---

# F027-P13 — Adaptive Recall Policy 5 级 fallback + Hard Gate

## Why

V16.5 chap 12 北极星 AC-P1-12：**召回失败时不让 agent 编造历史结论**。

P11 已建 Hard Gate 第一层 detectRecallTrigger（deterministic：a2a_handoff / modify_plan / review keyword 等命中即 required）+ 第二层 LLM judge 接口（conservativeStubJudge 默认 required=true）。**P11 baseline 等于"卡得过紧"——任何含"之前/上次/已决定/一直以来"的 draft 都强制召回，无 critique 评估召回结果是否充分**。

P13 要解决的是：
1. **Hard Gate 第二层真 LLM judge**（替换 conservativeStubJudge）
2. **召回失败时升级 fallback**（Level 1 注入 → Level 2 search_wiki → Level 3 query_messages → Level 4 read_wiki → Level 5 escalate）
3. **Critique Agent 每级评估是否继续 fallback**（防 false satisfaction）
4. **Per-turn budget 防 5x 延迟**（max_levels 3 / max_total_ms 5000 / max_critique_calls 2）
5. **Lint/Judge 拦截**：recall_required=true & recall_satisfied=false & agent 输出历史结论 → BLOCKED

## 现状 baseline（P11 已完成）

- ✅ `packages/api/src/wiki/memory-preflight/hard-gate.ts` — detectRecallTrigger 两层判定 + conservativeStubJudge
- ✅ `packages/api/src/wiki/memory-preflight/hybrid-search-provider.ts` — BM25 + cosine + NoopReranker
- ✅ `packages/api/src/wiki/memory-preflight/memory-preflight.ts` — loadTaskMemoryPack 主入口（已是 Level 1 注入侧）
- ✅ `packages/api/src/db/schema.ts:386-394` — prompt_audit 9 个 recall_* 字段全部就位
- ✅ Quality Gate 三段（高置信注入 / 中置信 Inspector / 低置信丢）+ token budget cap

## 范围切分（P13.a / P13.b）

工期上 P13 在 Day 28-29，P14 在 Day 30 — **Level 3 query_messages 依赖 P14 messages FTS5**。两种切法：

| 切法 | 描述 | 优劣 |
|---|---|---|
| **A. P13 等 P14（推荐）** | P14 调到 Day 28，P13 顺延到 Day 29-30 | 单线推进无 stub；评估 P14 是否独立可立项 |
| **B. P13 分 P13.a/P13.b** | P13.a (Day 28): Level 1+2+5 + budget + Critique stub. P13.b (Day 29，依赖 P14): Level 3+4 + 真 Critique LLM + Judge BLOCKED | 并行 P14 + P13.a，但 P13.a 出非完整版需复测 |
| C. P13 一刀做完，Level 3 用 LIKE %% stub | 临时实现，P14 后回头替换 | stub 翻车风险（LIKE 跟 FTS5 召回行为差异大）|

**建议 A**。理由：
- P14 BM25 是 P15 LLM rerank 的依赖，**也是 P11.b 转正（HybridSearchProvider 真 BM25 backend）依赖**——P14 本身价值独立
- P11/P12 review 历史看，P13 5 级 fallback + critique LLM 是 60-80% 范 review 焦点；分两批做需两轮 r1-r6，效率低
- P14 工期估 1 天（messages FTS5 触发器 + indexer + 测试），不会显著推迟 P13

## V16.5 chap 12 关键设计点

### Hard Gate 触发规则（chap 12 行 1369-1379）

P11 已实现 deterministic 第一层。P13 要：
- **接真 LLM judge 替换 conservativeStubJudge** — edge case "之前/上次/已决定" 但无 cite 时判
- **judge 选型**（待小孙拍）：Sonnet 4.6（P12 已拍这条线，决策识别准确度优先）vs Haiku 4.5（轻量，judge 任务相对窄）

### 5 级 Fallback 阶梯（chap 12 行 1398-1410）

```
Level 1: tail / viewfinder           ← 常驻注入（P11 loadTaskMemoryPack 已是入口）
   ↓ Critique Agent 评估
Level 2: search_wiki                 ← BM25 + LLM rerank（依赖 P14 + P15）
   ↓
Level 3: query_messages              ← FTS5 全文搜（依赖 P14）
   ↓
Level 4: read_wiki(具体 path)        ← 仅 critique 给 specific path 时触发
   ↓ 仍冲突
Level 5: 提示不确定 / 请求人工裁决   ← 不许编造
```

### Per-turn Recall Budget（chap 12 行 1412-1422）

```ts
const RECALL_BUDGET = {
  max_levels: 3,              // 默认最多走 Level 3
  max_total_ms: 5000,         // 总耗时 cap 5s
  max_critique_calls: 2,      // critique LLM 调用 cap 2
  query_parallel: true,       // search_wiki / query_messages 并行
  reuse_task_memory_pack: true // memory_preflight 已召回的复用
}
```

### Lint / Judge 拦截（chap 12 行 1440-1444）

- `recall_required=true` 但 `recall_satisfied=false` 且 agent 输出了历史结论 → judge 标 **BLOCKED**
- 提示 agent 重做（escalate or 主动召回）

## P13 实施切片（建议 5 段）

| 段 | 文件 | 工作 |
|---|---|---|
| **P13.1 · AdaptiveRecallExecutor 主框架** | `wiki/adaptive-recall/executor.ts`（新） | 5 级 fallback 状态机 + budget 强制 + 每级 audit 写 prompt_audit |
| **P13.2 · 真 LLM critique-agent** | `wiki/adaptive-recall/critique-agent.ts`（新） | 输入：query + level N hits → 输出：satisfied / continue-to-level-M / specific-path-hint / escalate；用 createSonnetRunner（同 P12 决策 extractor）|
| **P13.3 · Level 3 query_messages 真后端** | `wiki/adaptive-recall/level3-messages.ts`（新，依赖 P14 FTS5）| 用 FTS5 全文搜 messages，limit 20，过滤本房间 |
| **P13.4 · Level 4 read_wiki + Level 5 escalate** | `wiki/adaptive-recall/level4-readwiki.ts` + `level5-escalate.ts` | Level 4 读 specific path（critique 必须给）；Level 5 写 wiki_events action='recall_escalate' + audit |
| **P13.5 · Judge BLOCKED lint** | `wiki/adaptive-recall/judge-block.ts` | input: prompt_audit row + agent output → detect"历史结论"模式 → 若 recall_required=true & recall_satisfied=false → BLOCKED |

## AC（对应 AC-P1-12）

- [ ] **AC-1 · 5 级 fallback fixture 全触发**：
  - L1 命中 fixture：tail 已含证据 → 不进 fallback（recall_path=1, recall_satisfied=1）
  - L2 命中 fixture：search_wiki hybrid 命中 score ≥ 0.75 → critique satisfied（recall_path=2）
  - L3 命中 fixture：search_wiki 0 命中但 query_messages 命中 → critique satisfied（recall_path=3）
  - L4 命中 fixture：critique 输出 specific path → read_wiki 取原文 → satisfied（recall_path=4）
  - L5 命中 fixture：L1-L4 全部未 satisfied → escalate to user + 写 wiki_events（recall_path=5, recall_satisfied=0, escalate_reason 非空）
- [ ] **AC-2 · Hard Gate escalate 写 wiki_events**：fixture L5 触发后查 wiki_events 表存在 action='recall_escalate' 行 + payload 含 trigger / draft 摘录
- [ ] **AC-3 · Budget cap**：构造 critique 慢响应 fixture，max_total_ms=5000 触发 → 强制 escalate（recall_budget_exceeded=1）
- [ ] **AC-4 · BLOCKED lint**：fixture agent output 含"之前我们决定 X"无 cite + recall_required=true & recall_satisfied=false → judge 输出 BLOCKED + 不许通过
- [ ] **AC-5 · 现 P11 边界保留**：detectRecallTrigger deterministic 第一层不变（a2a_handoff / modify_wiki / review keyword 仍判 required）

## 5 个 Open 问题（请小孙拍）

1. **范围切法**：A（等 P14）/ B（拆 P13.a/.b）/ C（LIKE stub）？建议 A。
2. **Critique LLM 选型**：Sonnet 4.6（同 P12 extractor，~8s/call）vs Haiku 4.5（更快但 P11 stub 阶段就预留这线）？预算考虑：每 turn 最多 2 次 critique × 5000ms cap，订阅模式不算 token 但卡延迟，Haiku 占优；准确度 Sonnet 占优。
3. **Level 4 read_wiki 触发严格度**：plan 写"仅 critique 给 specific path 时触发"——是否 critique 输出 fuzzy path（如 "F011-related"）也触发？建议严格要求 exact path 或路径前缀。
4. **AC-1 fixture 怎么造 L4 命中**：需构造 critique 必输出 specific path 的场景，可能要 critique prompt mock 或 hand-crafted fixture room。
5. **范 review 节奏**：P11/P12 历史是 r1-r6 走完才 GO；P13 5 段 + 4 个 AC 是否一次性提交 review，还是 P13.1-P13.2 先 r1 baseline，P13.3-P13.5 后续 r2+？

## 工时估

| 段 | 工时 |
|---|---|
| P13.1 主框架 | 3-4h |
| P13.2 critique LLM | 3-4h（含 prompt 调优 + 校准） |
| P13.3 Level 3（依赖 P14）| 2h |
| P13.4 Level 4/5 | 2-3h |
| P13.5 BLOCKED lint | 2h |
| AC fixture + 测试 | 4-6h（5 个 fixture room + critique mock + budget fixture）|
| 范 r1-r6 review chain | 6-10h（按 P12 历史） |
| **总计** | **22-31h ≈ 3-4 单人天** |

V16.5 plan 估 P13 是 2 天（Day 28-29），叠加 review chain 实际偏紧。

## 范 review 入口（kickoff 前）

- [ ] 5 个 Open 问题小孙拍后
- [ ] 范 r1 baseline review（聚焦：切法 A/B/C 边界 + budget 算法 + L4/L5 fixture 可构造性）
- [ ] 范 r2+ followups（按 P12 同款 r1-r6 chain）

## 不在 P13 范围

- ~~MonthlySnapshot 自动 cron~~ → Phase 2 P19
- ~~viewfinder 6 段语义二轮打磨~~ → Phase 2 P12.b（见 F027 spec Phase 2 增补章节）
- ~~Inspector UI 显示 recall_path~~ → Phase 3 P20
- ~~manual confirm decision API~~ → Phase 3 P20
