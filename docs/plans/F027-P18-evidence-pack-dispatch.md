---
id: F027-P18-evidence-pack-dispatch
title: F027 Phase 1 P18 Evidence Pack 派发清单（范德彪 / 桂芬分批）
owner: 黄仁勋 → 派发 范德彪 + 桂芬
created: 2026-05-14
status: dispatch ready
plan_truth_source: docs/plans/V16.5-final.md chap 16 行 1680-1733
ac: AC-P1-14 (Phase 1 收尾)
worktree: .worktrees/F027 (branch feat/F027-unified-memory-architecture)
---

# F027 Phase 1 P18 Evidence Pack 派发清单

## 总目标

完成 F027 Phase 1 最后 1 个 AC（**AC-P1-14**），生成 14 个 AC 的 evidence pack + 异构双 judge 仲裁，让 Phase 1 整体收尾可合 dev。

按 V16.5 chap 16 行 1693-1706 spec：每个 AC 在 `docs/features/F027/evidence/phase1/<ac>/` 落 7 件套：

```
docs/features/F027/evidence/phase1/AC-P1-N/
  prompt.txt                       # assembler 输出 system prompt（如该 AC 涉及）
  agent_response.txt               # agent 完整 response（如涉及 agent 行为）
  db_dump.sql                      # 测试前后 DB 状态 dump
  wiki_state.tar.gz                # 测试前后 wiki/ 文件 tar
  config.hash                      # runtime + LLM provider config 的 hash
  prod_config_diff.txt             # 与生产配置 diff
  result.json                      # PASS / BLOCKED / INCONCLUSIVE / FAIL
  judges/
    judge1_anthropic-opus-4-7.json   # judge1 Anthropic Opus 4.7 (黄仁勋指定)
    judge2_<model>_<provider>.json   # judge2 (待小孙在 room 里拍)
    arbitration.json                 # 双 judge 不一致时的仲裁
```

## 关键决策（小孙 2026-05-14 拍）

1. **分 4 批 × ~3-4 AC** — 每批 commit + checkpoint，避免一刀做完
2. **完整 7 件套** — 按 spec 全要（schema 类 / behavior 类都按 7 件套填）
3. **复用现有单测/集成测提取** — 现有 2149/2154 测试已覆盖大多数 AC，写 evidence runner script 抽取测试输入/输出/状态 dump 当 evidence
4. **judge2 model**：黄仁勋开任务清单 → 小孙在 multi-agent room 里 @范德彪 / @桂芬 分发派工 + judge2 model 由 reviewer 自定（建议范=Codex/gpt-5.4，桂=Gemini）

## 4 批 AC 切分

### Batch 1 · 基础 schema + ACL + sanitize（复用最简单）

| AC | 内容 | 复用测试 | Evidence 来源策略 |
|---|---|---|---|
| **AC-P1-1** | 4 张表 schema + EXPLAIN ≤ 50ms | `drizzle-instance.test.ts` / `schema.test.ts` | 跑 EXPLAIN dump → result.json + db_dump.sql 含 sqlite_master + indices |
| **AC-P1-2** | update_wiki MCP ACL/CAS/lease/fencing fuzz 100 并发 | `wiki-events-repository.test.ts` / `wiki-lease-*.test.ts` | 跑 fuzz 100 → race trace 入 result.json + 重试日志 → agent_response.txt |
| **AC-P1-4** | sanitize 5 层防御 fixture 全命中 | `sanitize-raw-drop.test.ts` + `tests/fixtures/sanitize/*.md` | 5 层 fixture 输入/输出 → prompt.txt + result.json (含 chained_suspect 标记) |
| **AC-P1-9** | 6 类记忆桶 + canonical_owner lint 红绿 | `wiki-memories-repository.test.ts` + `tests/fixtures/canonical-owner/*` | red/green fixture diff → result.json |

**Batch 1 工时估**: 1 单人天
**建议 owner**: **范德彪**（schema/lint/ACL 强项，跟 P11.b/P14.a 同款 review 经验）

---

### Batch 2 · LLM 编译 + Handbook + 注入合约

| AC | 内容 | 复用测试 | Evidence 来源策略 |
|---|---|---|---|
| **AC-P1-3** | LLM 编译 3 阶段端到端 PASS（RAG paper fixture） | `wiki-ingest/*.test.ts` + `tests/fixtures/wiki-ingest/rag-tutorial-input.md` | rag-tutorial 全程：input.md (prompt.txt) + 各阶段 LLM 输出 (agent_response.txt) + frontmatter fill 19 字段对账 (result.json) |
| **AC-P1-5** | multi-drop cross-correlation series vs chained_suspect | `multi-drop-correlation.test.ts` + `tests/fixtures/multi-drop/*` | series fixture / chained fixture 输入 → similarity score → result.json |
| **AC-P1-6** | Handbook 4 H2 切片 + cross-file dedupe lint 红绿 | `slice-handbook.test.ts` + `tests/fixtures/lint/*-handbook-*` | sliceHandbookByH2() 输入/输出 → red/green diff → result.json |
| **AC-P1-7** | 唯一注入合约（grep "Iron Laws" = 1 / harness ≤ 2） | `assemble-prompt-iron-laws.test.ts` (P5) | 跑 assemblePrompt → grep 输出 → prompt.txt + result.json |

**Batch 2 工时估**: 1.5 单人天
**建议 owner**: **桂芬**（前端/F018 SessionBootstrap 7 区段熟，handbook 切片跟 F018 同源）

---

### Batch 3 · sessions + 召回 + viewfinder（北极星）

| AC | 内容 | 复用测试 | Evidence 来源策略 |
|---|---|---|---|
| **AC-P1-8** | agent-sessions ledger 100k session sharding 后 active < 1k | `agent-sessions/*.test.ts` + yearly-pack 测试 | 100k fixture 模拟 → sharding 前后 active count → result.json |
| **AC-P1-10** | viewfinder anti-drift 100 iter telephone game drift ≤ 30% | `viewfinder/100-iter-telephone-game.test.ts` + fixture json | with_intervention drift / without_intervention drift → result.json + jaccard 计算 |
| **AC-P1-11** ★ | memory_preflight 北极星 (桂芬进 R-205 召 F011) | `memory-preflight.test.ts` (P11.b) | 桂芬 fixture room 召回 query → 命中 F011/F021 score → prompt.txt (注入区段) + agent_response.txt (Inspector 显示) + result.json |

**Batch 3 工时估**: 1 单人天
**建议 owner**: **桂芬**（北极星 AC-P1-11 是核心，桂芬测 F018 召回有积累）

---

### Batch 4 · Adaptive Recall + capability + 元

| AC | 内容 | 复用测试 | Evidence 来源策略 |
|---|---|---|---|
| **AC-P1-12** ★ | Adaptive Recall 5 级 fallback fixture 全触发 + escalate | `adaptive-recall/*.test.ts` (P13) | 5 级各跑一个 fixture → recall_path 1-5 → result.json (recall_satisfied / escalate_reason) + Level5Sink trace |
| **AC-P1-13** | alias-aware capability registry handoff 中性改写 fixture 红绿 | `capability-registry/*.test.ts` (P9) + `tests/fixtures/capability-registry/red-leaks-sender-risk.json` vs `green.json` | red 命中 forbidden strings → 触发改写 → green 0 命中 + required fields → result.json |
| **AC-P1-14** | evidence pack + 双 judge 元 AC（本任务自身） | 本派发执行结果 | 14 个 AC 的 evidence pack 完整存在 + 14 × 双 judge JSON + arbitration → meta result.json |

**Batch 4 工时估**: 1 单人天
**建议 owner**: **范德彪**（P9/P12/P13 都是范 r1-r6 review 过，对 spec 边界最熟，AC-P1-14 元 AC 适合范统筹）

---

## 双 Judge 操作规范

### Judge1 — Anthropic Opus 4.7（黄仁勋指定）

```bash
# 通过 Claude API 直接调（建议在 packages/api/scripts/p18-judge.ts 写 wrapper）
node packages/api/scripts/p18-judge.ts \
  --judge anthropic-opus-4-7 \
  --ac AC-P1-N \
  --evidence docs/features/F027/evidence/phase1/AC-P1-N/ \
  --out docs/features/F027/evidence/phase1/AC-P1-N/judges/judge1_anthropic-opus-4-7.json
```

Judge prompt 模板（每 AC 通用）：
```
你是 F027-P18 evidence pack judge。
Spec AC：<AC 原文>
Evidence pack：<7 件套内容>
判定：
  - PASS: 7 件套完整 + result.json verdict=PASS + behavior 与 AC 描述一致
  - BLOCKED: 7 件套不完整 / 依赖未就绪
  - INCONCLUSIVE: 跑完但断言模糊
  - FAIL: 真跑挂 / behavior 不符
返 JSON: {"verdict": "...", "reason": "<≤200 字>", "weak_points": [...]}
```

### Judge2 — 由 reviewer 自定（小孙在 room 里拍）

建议：
- **范德彪 batch (Batch 1+4)** → judge2 = Codex/gpt-5.4 (走 codex:rescue 调用同款风格)
- **桂芬 batch (Batch 2+3)** → judge2 = Gemini CLI (gemini --print)

### Arbitration 规则

```
judge1 PASS + judge2 PASS → 最终 PASS, arbitration.json 记 "double-pass"
judge1 PASS + judge2 FAIL → arbitration.json 记 "split"，挂小孙拍
judge1 FAIL + judge2 PASS → arbitration.json 记 "split"，挂小孙拍
judge1 FAIL + judge2 FAIL → 最终 FAIL, arbitration.json 记 "double-fail"
任一 BLOCKED → arbitration.json 记 "blocked-in-N", 不算 PASS
任一 INCONCLUSIVE → arbitration.json 记 "inconclusive-in-N", 不算 PASS
```

## Batch 完成后 commit 规范

每 batch 完成后单独 commit：
```
docs(F027-P18 batch-N): evidence pack AC-P1-X/Y/Z + 双 judge 仲裁

- AC-P1-X: PASS (judge1 PASS + judge2 PASS)
- AC-P1-Y: PASS
- AC-P1-Z: PASS
batch N 完整 7 件套 + arbitration 全 double-pass
```

batch 4 完成后整体收尾 commit：
```
docs(F027-P18): Phase 1 P18 evidence pack 全 14 AC 收尾 — Phase 1 done

- 14/14 AC 全 PASS
- 双 judge 异构验证全 double-pass / 0 split
- 元 AC-P1-14: evidence pack framework 自身验收

Phase 1 后端基础设施全 done，可启动 Phase 2 调度。
```

## 入口指令（小孙在 room 里 @ 时给 reviewer）

### 给范德彪（Batch 1 + Batch 4）

```
@范德彪 接 F027-P18 evidence pack 派发，你的 batch:

Batch 1 (基础 schema + ACL + sanitize): AC-P1-1 / P1-2 / P1-4 / P1-9 (~1 单人天)
Batch 4 (Adaptive Recall + capability + 元): AC-P1-12 / P1-13 / P1-14 (~1 单人天)

dispatch plan: cat .worktrees/F027/docs/plans/F027-P18-evidence-pack-dispatch.md
真相源: docs/plans/V16.5-final.md chap 16 行 1680-1733
worktree: .worktrees/F027 (branch feat/F027-unified-memory-architecture)

工作:
1. 每个 AC 创建 docs/features/F027/evidence/phase1/AC-P1-N/ 目录
2. 复用现有单测/集成测 (cd packages/api 后跑) 提取 input/output/db state 当 evidence 7 件套素材
3. judge1 = Anthropic Opus 4.7 (你写 packages/api/scripts/p18-judge.ts wrapper 调 Claude API)
4. judge2 = Codex/gpt-5.4 (走 codex:rescue 同款 review chain 风格)
5. arbitration.json 按 dispatch plan 规则
6. batch 完成后 commit + 同步通知

工时估: 2 单人天 (Batch 1 + Batch 4)
有歧义先问黄仁勋 / 小孙拍。
```

### 给桂芬（Batch 2 + Batch 3）

```
@桂芬 接 F027-P18 evidence pack 派发，你的 batch:

Batch 2 (LLM 编译 + Handbook + 注入合约): AC-P1-3 / P1-5 / P1-6 / P1-7 (~1.5 单人天)
Batch 3 (sessions + 召回 + viewfinder 北极星): AC-P1-8 / P1-10 / P1-11 (~1 单人天)

dispatch plan: cat .worktrees/F027/docs/plans/F027-P18-evidence-pack-dispatch.md
真相源: docs/plans/V16.5-final.md chap 16 行 1680-1733
worktree: .worktrees/F027 (branch feat/F027-unified-memory-architecture)

工作:
1. 每个 AC 创建 docs/features/F027/evidence/phase1/AC-P1-N/ 目录
2. 复用现有单测/集成测 (cd packages/api 后跑) 提取 input/output/db state 当 evidence 7 件套素材
3. judge1 = Anthropic Opus 4.7 (复用范德彪写的 packages/api/scripts/p18-judge.ts)
4. judge2 = Gemini CLI (gemini --print 同款风格)
5. arbitration.json 按 dispatch plan 规则
6. batch 完成后 commit + 同步通知

工时估: 2.5 单人天 (Batch 2 + Batch 3)
注意 AC-P1-11 是北极星，重点跑桂芬进 R-205 召 F011 fixture (你自己作为主角的场景)
有歧义先问黄仁勋 / 小孙拍。
```

## 黄仁勋（我）的角色

- ✅ 已做：dispatch plan + 4 批切分 + judge 操作规范 + 入口指令
- 待做：
  - 等 Batch 1 (范) 写完 packages/api/scripts/p18-judge.ts wrapper（其他 batch 复用）
  - 处理任何 reviewer 派发中的歧义 / 跨 AC 边界问题
  - 4 batch 都完成后整体收尾 commit + 申请 Phase 1 GO

## 异常路径

- **某 AC 跑不通**: reviewer 标 FAIL → 写到 result.json → 通知黄仁勋判是 r2 修复还是边界调整
- **judge1 Opus quota 不足**: BLOCKED → 写 arbitration.json (blocked-in-1) → 等 quota 恢复重跑
- **judge2 model 不可用**: 同上
- **AC 描述跟实现有 gap**: 不要硬填 evidence，标 INCONCLUSIVE → 通知小孙拍是改 spec 还是补实现

---

**派发后**：小孙在 multi-agent room 里 @范 + @桂芬，把上面"入口指令"段贴给他们。
