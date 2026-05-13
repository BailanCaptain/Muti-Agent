---
id: F027-P13-review-r1
title: F027-P13 Adaptive Recall Policy r1 review 请求
reviewer: 范德彪
requester: 黄仁勋
created: 2026-05-14
status: open
round: r1（按小孙 Open #5 拍板 — 5 段一次性提交，r2-r6 视反馈）
---

# F027-P13 Adaptive Recall Policy r1 Review Request

**Feature:** F027 — `docs/features/F027-unified-memory-architecture.md` AC-P1-12
**Plan:** `docs/plans/F027-P13-adaptive-recall-plan.md`
**真相源:** `docs/plans/V16.5-final.md` chap 12 行 1367-1444
**Branch / Worktree:** `feat/F027-unified-memory-architecture` @ `.worktrees/F027`
**HEAD:** `0260b04 docs(F027-P13): AC-P1-12 验收边界 + 5 Open 拍板`

## What Changed

P13 Adaptive Recall Policy + 5 级 fallback + Hard Gate 落地（V16.5 chap 12）：

| 段 | 文件 | 测试 | 内容 |
|---|---|---|---|
| P13.1 | `executor.ts` + `types.ts` | 11/11 | 5 级状态机 + per-turn budget (maxLevels/maxTotalMs/maxCritiqueCalls 三维) + 每级 audit trail (LevelAttempt[]) + escalate 路径 |
| P13.2 | `critique-agent.ts` | 19/19 | LlmCritiqueAgent (Sonnet 4.6 via createSonnetRunner) + buildCritiquePrompt + parseCritiqueJson 5 道防 hallucination 校验 |
| P13.3 | `level3-messages-backend.ts` | 3/3 | MessagesFtsLevel3Backend 适配 P14.b MessagesFtsRepository (f91edf5)；真 SQLite FTS5 + roomId 隔离 |
| P13.4 | `level4-readwiki-backend.ts` + `level5-escalate-sink.ts` | 9/9 | FileSystemLevel4Backend 严格模式 (WIKI_PATH_PREFIX + path traversal 双保险 + ENOENT 返 null) + 3 Sink 实现 (Noop/ConsoleWarn/Recording) |
| P13.5 | `judge-block.ts` | 13/13 | judgeRecallBlock 5 路径决策表 + HISTORY_CLAIM_PATTERNS + cite 检测 ([decision_id=N]/[D-N]/[msg_xxx]/[a2a_call=...]) |

**Diff scope**: 14 files / 2031 insertions / 0 modifications (纯新增 packages/api/src/wiki/adaptive-recall/*).
**0 package.json / pnpm-lock 改动** — 不需要 pnpm install + start-project。

**Commit chain (4):**
```
0260b04 docs(F027-P13): AC-P1-12 验收边界锁定 + 小孙 5 个 Open 拍板记录
7e36e84 feat(F027-P13.3/.4/.5): Level3/4/5 backends + Judge BLOCKED lint
bccf5e1 feat(F027-P13.2): Critique Agent (Sonnet 4.6 LLM judge)
3a5a2a8 feat(F027-P13.1): AdaptiveRecallExecutor 主框架 — 5 级 fallback 状态机
```

## Why

V16.5 chap 12 北极星：**召回失败时不让 agent 编造历史结论**。

P11 已建：
- Hard Gate **第一层 deterministic** (`hard-gate.ts` detectRecallTrigger — a2a_handoff / modify_plan / review keyword 命中即 required)
- `conservativeStubJudge` (默认 required=true 保守 stub)
- prompt_audit schema 9 个 recall_* 字段 (`schema.ts:386-394`)
- HybridSearchProvider (BM25 + cosine + NoopReranker) Level 2 backend

P13 补：
1. **真 Sonnet 4.6 critique LLM** 替换 conservativeStubJudge
2. **召回失败 5 级升级** — L1 task_memory_pack → L2 search_wiki → L3 query_messages FTS5 → L4 read_wiki(strict path) → L5 escalate
3. **Critique Agent 每级评估** — 防 false satisfaction
4. **Per-turn budget 防 5x 延迟** — 3 维 cap 任一触顶强制 escalate
5. **Lint/Judge BLOCKED** — agent 无 cite 引历史结论时拦截

## Original Requirements

**小孙原话**（2026-05-13 / 2026-05-14）：

> "1 A 2 4.6 3严格吧 4 手工可以 5 一次性"

> "推 P13 我去吃饭了"

> "跳过独立验收 进requset"

5 个 Open 拍板对应：
- **#1 范围切法 A** (等 P14) → P14.b 实际已 done (f91edf5)，立即开干
- **#2 Critique LLM = Sonnet 4.6** (同 P12 decision-extractor 准确度优先)
- **#3 L4 严格 exact path** (fuzzy path 不触发)
- **#4 AC L4 fixture 手工** (hand-crafted，不走 critique mock)
- **#5 范 review 一次性 r1** (5 段全做完一次性提，r2-r6 视反馈)

V16.5 chap 12 设计原文（line 1369-1444）：
- Hard Gate 触发规则 + 两层判定（行 1369-1395）
- 5 级 Fallback 阶梯（行 1398-1410）
- Per-turn Recall Budget（行 1412-1422）
- Schema (prompt_audit 9 字段，已 P11 落地)
- Lint / Judge 拦截（行 1440-1444）

## Self-Check Evidence

**quality-gate**: ✅ PASS (2026-05-14)
- Step 0 vision check: 5 痛点 1:1 对照 V16.5 chap 12
- Step 0.5 完整性: P13 = library 完整一刀（同 P11/P12 边界）；wiring 挂 Phase 3 P20
- Step 0.6 observability: P13 不直接写 prompt_audit / wiki_events (library 设计，避免 import db/fencing)
- Step 4 命令输出（本轮真实运行）：
  - `pnpm typecheck` → **exit 0** ✅
  - `pnpm build` → **exit 0** ✅
  - `pnpm run test:api` → **2129/2138 pass, 0 fail** (8 skipped, 1 todo) ✅
  - `pnpm lint` → **exit 0** ✅

**acceptance-guardian**: ⏭️ 跳过（小孙 explicit override 2026-05-14 "跳过独立验收 进requset"）

**P13 模块单测细则 55/55**：
```
executor.test.ts          11 (L1-L5 命中 + L5 escalate + 3 维 budget 触顶 + L4 严格度 + taskMemoryPack 空 + L4 path not found)
critique-agent.test.ts    19 (prompt 构造 5 大要素 + 11 parse case 含 5 道防 hallucination + runner 3 路径)
level3-messages-backend   3 (端到端真 FTS5 + roomId 隔离 + 无命中 fail-soft)
level4-readwiki-backend   6 (exact / not found / 非 wiki / traversal / 非 .md / dir)
level5-escalate-sink      3 (Noop / ConsoleWarn 含 info / Recording)
judge-block.test.ts       13 (5 路径决策表 + 4 种 cite 模式 + HISTORY_CLAIM 5 case 含边界)
```

## Known Risks（5 个值得审）

1. **L1 critique 必调一次**：当前 L1 注入也走 critique 评估（同 chap 12 行 1402 "↓ Critique Agent 评估"原意）。即使 L1 已显然充分仍消耗 1 次 critique budget。是否需要 fast-path 让 L1 score 全 ≥ 某阈值时跳过 critique？

2. **L4 严格 specific_path 校验放宽**：当前接受两类——形如 `wiki/...md` 标准 path 或本级 hits 中已存在的 path（防 critique 编造）。后者放宽了字面"严格 exact wiki path"——比如 L3 输出 `messages/R-201/m-xxx`，critique 给该 path 时也通过。生产里 critique 输出 hits 的 messages path 触发 read_wiki 是否合理？或必须限定 wiki/ 前缀？

3. **Sonnet 4.6 延迟 vs budget**：critique 单次 ~8s（同 P12 extractor）。maxCritiqueCalls=2 默认 → 最坏 16s 远超 maxTotalMs=5000。当前 maxTotalMs 触顶会强制 escalate，但意味着大部分 L3+ 走不到。是否默认 maxTotalMs 调大（15000）+ 加 Haiku 4.5 critique 快速路径选项？

4. **Level5Sink 接口边界 vs LL-030**：P13 模块不绑定 audit 后端（NoopLevel5Sink 默认）。生产 wiring 在 Phase 3 P20——跟 LL-030 风险点重合（library wiring 没真跑过）。是否需要在 P13 范围内提供最小 WikiEventsLevel5Sink 雏形避免 Phase 3 漏接？

5. **AC-P1-12 文字修订是否充分**：原 plan "Level 3 LLM rerank" 跟 chap 12 阶梯不一致已修为 "Level 3 query_messages FTS5"。是否还有其他 AC / spec 文字与 chap 12 实情不一致需要同步修订？

## Review Focus（按 V16.5 chap 12 5 项验证）

1. **5 级 fallback 状态机正确性**（`executor.ts`）
   - L1/L2/L3 路径分支 + budget 检查时序（budgetLeft 先于 critique）
   - L4 触发条件（仅 critique 输出 specificPath 时）+ L4 path not found 后路径
   - escalate 路径覆盖（4 个 escalate call site）+ attempts audit trail 完整性
   - visitedLevels[] 顺序正确性

2. **Critique 防 hallucination 5 道校验**（`critique-agent.ts:parseCritiqueJson`）
   - next_level 越界（!integer || <2 || >5）
   - next_level <= current level（反复推回）
   - next_level=4 缺 specific_path
   - specific_path 非法（既非 wiki/...md 也非 hits 中已存在）
   - 数组 JSON（typeof === "object" 但 Array.isArray）
   - 是否有其他攻击面漏判？

3. **L4 严格度 + 安全攻击面**（`level4-readwiki-backend.ts`）
   - WIKI_PATH_PREFIX 正则 + path.normalize + 拒绝 `..` 段 + path.resolve 仍在 wikiRoot 下 — 是否足够防 path traversal
   - hits 中已存在 path 的放宽：是否引入风险（如 messages/R-201/... 路径触发 fs.readFile 失败 → ENOENT 返 null 安全）
   - 文件 IO 异常处理（ENOENT/EACCES/EISDIR 返 null vs 其他错抛）

4. **BLOCKED lint 决策表 + 召回率/误检率**（`judge-block.ts`）
   - 5 路径决策表（required false / satisfied true / 无历史结论 / 有 cite / BLOCKED）覆盖
   - HISTORY_CLAIM_PATTERNS 4 条：召回率（是否漏判"上次拍了"等变体）vs 误检率（"之前的代码不在了"已显式排除）
   - CITE_PATTERNS 4 条（[msg_xxx] / [decision_id=N] / [D-N] / [a2a_call=...]）是否齐全

5. **AC-P1-12 验收边界 + Phase 3 切分**（`docs/features/F027-unified-memory-architecture.md:152`）
   - P13 library 范围 vs Phase 3 wiring 切分是否同 P11/P12 一致
   - Phase 3 P20 待办列表 (a) orchestrator 调用点 (b) prompt_audit 真写入 (c) Level5Sink 生产实现 是否完整
   - LL-030 风险点处理是否充分

## Out of Scope

- prompt_audit 表真实写入（Phase 3 P20 wiring）
- Inspector UI 显示 recall_path / escalate_reason（Phase 3 P20）
- WikiEventsLevel5Sink 生产实现（Phase 3 P20 — caller 自己接 db lease/fencing context）
- Phase 2 P12.b viewfinder 6 段语义二轮打磨（已挂 F027 Phase 2 增补）
- F026 cleanup / capability registry / docs-watcher / backfill 等不在 P13 范围

## Review 节奏

按 P11/P12 同款 r1-r6 chain。第一轮 r1 不一定 GO，r2+ 视反馈推进。

任何 Q/A 都在本文件下方追加段落，或开 P13-review-r{N}-followup.md 链接到此处。

## 给范德彪的入口指令

```
cd C:\Users\-\Desktop\Multi-Agent\.worktrees\F027
cat docs/plans/F027-P13-review-request-r1.md  # 本文件
git log --oneline -5  # commit chain
pnpm exec tsx --test "packages/api/src/wiki/adaptive-recall/*.test.ts"  # 55 单测复跑（应 0 fail）
```

逐项过 5 个 Review Focus + 给 5 个 Known Risks 判定。
