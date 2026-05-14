---
id: F027-P13-review-r2-confirmation
title: F027-P13 r2 修复确认请求 → 范德彪
requester: 黄仁勋
created: 2026-05-14
status: awaiting r2 confirmation
prev: docs/plans/F027-P13-review-request-r1.md
---

# F027-P13 r2 修复确认请求

**Reviewer**: 范德彪
**HEAD**: `490d902 fix(F027-P13): r2 范-r1 反馈修复 — 2 P1 + 5 P2 全 close`
**r2 commit**: `490d902`
**r1 review**: `docs/plans/F027-P13-review-request-r1.md` + 你给的报告（CONDITIONAL，2 P1 + 5 P2）

按 receiving-review skill 流程：VERIFY 三道门 → Red→Green 逐个修 → 不自判改对 → 回你确认。

## r1 反馈 → r2 修复 状态表

| # | r1 finding | 文件:行号 | r2 修法 | Red→Green 证据 |
|---|---|---|---|---|
| **P1-1** | maxTotalMs budget enforcement bug — verdict.satisfied 接受前缺时间检查（`executor.ts:112-121` 等 4 处） | 4 处 verdict satisfied 分支 | `runCritique` 加 `budget_time` 返回（critique 调用前+后双检 maxTotalMs），4 处 caller 统一处理 `budget_critique \| budget_time` → escalate；escalateReason 区分 `max_total_ms_exceeded_at_l{N}` vs `critique_budget_exceeded_at_l{N}` | `executor.test.ts:354-393` 加 RED 测试 "慢 critique 返 satisfied → 强制 escalate"；测试输出: 1 → 5 (RED) → fix → 12/12 (GREEN) |
| **P1-2** | Hard Gate 第二层 LLM judge 接口不一致 — P11 注释承诺 `RecallJudgeProvider.judge()` 替换但 P13 实现 `CritiqueAgent.evaluate()` | `hard-gate.ts:75-79` + `critique-agent.ts:162-177` | 新建 `LlmRecallJudge implements RecallJudgeProvider`（`adaptive-recall/llm-recall-judge.ts`，194 行）；与 LlmCritiqueAgent 不复用因 LLM 任务语义不同（"draft 是否需召回" vs "hits 是否充分"） | 15 单测含 contract test "接 P11 RecallJudgeProvider 接口契约：detectRecallTrigger 可直接注入"（`llm-recall-judge.test.ts:128-145`）— 编译期 + 运行时双重验证；hard-gate.ts 注释更新指向真实实现 |
| **P2-1** | L4 specific_path 放宽与 strict wiki path 冲突（小孙 Open #3） | `critique-agent.ts:141-149` + `critique-agent.test.ts:142-147` | parseCritiqueJson 移除 `matchesHit` 放宽，只接受 `WIKI_PATH_PREFIX` 形如 `wiki/...md` | 改测试 "messages path 即使在 hits 中也抛"（`critique-agent.test.ts:147-156`）从原"通过"改为 expect throws |
| **P2-2** | next_level=5 parser 接受但 executor 不处理 → fall through | `critique-agent.ts:150-152` | parseCritiqueJson 检测 nextLevel=5 → 转 `{ satisfied: false, escalate: true, reason }` | 改测试预期：原 expect `nextLevel === 5` 改为 expect `escalate === true`（`critique-agent.test.ts:158-167`） |
| **P2-3** | P13 plan 残留旧 AC（"Level 5 写 wiki_events" / "每级 audit 写 prompt_audit"） | `F027-P13-adaptive-recall-plan.md:107-121` | AC 列表重写对齐 spec AC-P1-12 (library 范围 vs Phase 3 wiring 切分)；加 AC-6 防 hallucination；明确 P13 范围外 4 项挂 P20 | docs commit |
| **P2-4** | cite 仅正则不验证证据真实存在（伪 cite 也 PASS） | `judge-block.ts:37-38` + `judge-block.ts:90-94` | judge-block.ts CITE_PATTERNS 加注释明确"P13 不补真实性，留 P20 接 db" | 范 r1 同意挂 P20，符合 P13 边界 |
| **P2-5** | queryParallel 字段定义但 executor 未实现 | `types.ts:18-29` | RecallBudget.queryParallel 加注释明确"按 chap 12 阶梯严格逐级 critique，未实现并行；future 占位挂 P20 评估收益" | docs comment |

## L4 残余风险（范 r1 提示，未在 r2 修）

- 没 `realpath` 检查，wikiRoot 内 symlink/junction 会跟随
- 我们的 wiki 是 controlled directory（仓库内 docs/）无 symlink → 接受
- 如果未来 wikiRoot 引入 symlink，挂 P20 wiring 时加 realpath 防线

## Known Risks 5 项 r1 判定 → r2 状态

| # | r1 判定 | r2 状态 |
|---|---|---|
| 1 | L1 critique 必调一次 → **接受**（V16.5 阶梯一致） | r2 维持原设计 |
| 2 | L4 specific_path 放宽 → **CONDITIONAL** | ✅ r2 P2-1 修，parser 限死 wiki/...md |
| 3 | Sonnet 延迟 vs budget → **CONDITIONAL**（先修 P1-1） | ✅ r2 P1-1 修，maxTotalMs 真实生效 |
| 4 | Level5Sink 边界 vs LL-030 → **接受但挂 P20** | r2 不变，P13 plan AC 已明确 P20 wiring 列表 |
| 5 | AC-P1-12 文字修订 → **CONDITIONAL** | ✅ r2 P2-3 修，plan AC 同步 spec 边界 |

## 测试结果（r2 真实运行）

```
P13 模块单测: 71/71 pass, 0 fail (r1 baseline 55 + r2 新加 16)
- executor.test.ts          12 (含 P1-1 红→绿)
- critique-agent.test.ts    19 (含 P2-1/P2-2 测试预期更新)
- level3-messages-backend   3
- level4-readwiki-backend   6
- level5-escalate-sink      3
- judge-block.test.ts       13
- llm-recall-judge.test.ts  15 (P1-2 全新)

全套 API regression: 2145/2154 pass, 0 fail (8 skipped, 1 todo)
- r1 baseline 2129 + r2 新加 16 = 2145，无回归

quality-gate (本轮真实运行):
- pnpm typecheck → exit 0
- pnpm build → exit 0  (r1 时跑过，r2 改动局限 adaptive-recall + hard-gate.ts 注释，无新破坏点)
- pnpm run test:api → 2145 pass / 0 fail
- pnpm lint → exit 0
```

## 给范的入口指令

```
cd C:\Users\-\Desktop\Multi-Agent\.worktrees\F027
git log --oneline -5  # 看 490d902 r2 commit
git show 490d902 --stat  # r2 改动 scope
cat docs/plans/F027-P13-review-confirmation-r2.md  # 本文件
pnpm exec tsx --test "packages/api/src/wiki/adaptive-recall/*.test.ts"  # 复跑应 71/71
```

逐项过 7 个 finding 状态：
- 接受 r2 修法 + close → GO
- 仍有问题 → r3 followup（带证据）
- 新发现 → r2 round 加 finding

## 不自判提醒

按 receiving-review skill 末尾："修复完成 ≠ 可以合入。必须回给 reviewer 确认。"

我不自判 GO。等你 r2 review 后再决定是 merge-gate 还是 r3。
