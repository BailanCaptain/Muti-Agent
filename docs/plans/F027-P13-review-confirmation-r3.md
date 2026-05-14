---
id: F027-P13-review-r3-confirmation
title: F027-P13 r3 修复确认请求 → 范德彪
requester: 黄仁勋
created: 2026-05-14
status: awaiting r3 confirmation
prev: docs/plans/F027-P13-review-confirmation-r2.md
---

# F027-P13 r3 修复确认请求

**Reviewer**: 范德彪
**HEAD r3 commit**: 见 `git log --oneline -1`
**r2 review**: 你给的 CONDITIONAL（7 项 r1 finding 全 accept，但发现 P2-A 隐藏 P1 + P2-B 测试 gap）

## r2 → r3 修复状态表

| # | r2 finding | 修法 | Red→Green |
|---|---|---|---|
| **P2-A** | prompt/parser 契约不一致 + executor 不 catch critique error → 整个 adaptive-recall unhandled throw | (1) buildCritiquePrompt 文件头注释 + 硬约束严格 wiki/...md，新增"不能填 messages/... 或本级 hits 中的非 wiki path"显式禁止；(2) runCritique 加 try-catch evaluate() → 返 `{ kind: 'critique_failed', error }`；新增 `isCritiqueSentinel` + `sentinelToReason` helper，4 处 caller 统一处理 budget/error sentinel → escalate | `executor.test.ts:444-471` 加 RED 测试"critique runner failure → executor 不 throw 而是 fail-closed escalate"；测试输出: throw → 5 (RED) → fix → 13/13 (GREEN) |
| **P2-B** | next_level=5 测试只 L4 parser case，缺 L2/L3 parser case + executor 直接 L5 测试 | parser 测试补 L2/L3 case；executor 测试补 "L2 critique 返 escalate verdict → 直接 L5 不进 L3" | `critique-agent.test.ts` 加 2 case (L2/L3) + `executor.test.ts` 加 1 case (L2 → L5 不进 L3) |

### P2-A 详细：critique error 路径

```
critique evaluate() 抛错 (runner timeout / parse failure)
  → runCritique 捕获 → 返 { kind: 'critique_failed', error: '<msg>' }
  → caller isCritiqueSentinel(verdict) === true
  → sentinelToReason → 'critique_failed:<error 摘要>'
  → escalate(`${reason}_at_l{N}`, hits, level)
  → recall_path=5, recall_satisfied=false, escalateReason='critique_failed:...'
  → Level5Sink.escalate() 调一次
```

注意：critique_failed **不算 budgetExceeded=true**（语义不同 — budget 是 cap 触顶，error 是 backend 失败），但都 fail-closed 到 escalate。

### Prompt/Parser 一致性确认

之前不一致点：
- 文件头 critique-agent.ts:18 旧: `specificPath 必须形如 wiki/... 或当前 hits 中已存在的 path 前缀`
- 文件头 r3 新: `specificPath 必须严格形如 wiki/...md（小孙 Open #3 strict + 范-r2 P2-A）—— 不接受 hits 中已存在的非 wiki path`
- prompt 88 行旧: `specific_path 只能填本级 hits 中已出现的 path，或形如 "wiki/concepts/..." / "wiki/rules/..." 的标准 wiki 路径`
- prompt r3 新硬约束：
  ```
  - specific_path **必须形如 "wiki/concepts/..." / "wiki/rules/..." 的标准 wiki path 且以 .md 结尾**
  - specific_path **不能填 messages/... 或本级 hits 中的非 wiki path**（这类 path 进 read_wiki 会失败 → 浪费一次 fallback）
  ```

文件头 + prompt + parser 三处现在一致：只接受 `WIKI_PATH_PREFIX` 形如 `wiki/...md`。

## L4 残余风险（r1 提示，r3 维持）

- 没 `realpath` 检查，wikiRoot 内 symlink/junction 会跟随
- 我们 wiki 是 controlled directory（仓库内 docs/）无 symlink → r3 维持
- P20 wiring 时如果引入外部 symlink 可加 realpath

## 测试结果（r3 真实运行）

```
P13 模块单测: 75/75 pass, 0 fail (r2 71 + r3 新 4)
- executor.test.ts          14 (含 r3 P2-A red→green + L2 next_level=5 → L5)
- critique-agent.test.ts    21 (含 r3 P2-B L2/L3 parser case)
- level3-messages-backend   3
- level4-readwiki-backend   6
- level5-escalate-sink      3
- judge-block.test.ts       13
- llm-recall-judge.test.ts  15

全套 API regression: 2149/2158 pass, 0 fail (8 skipped, 1 todo)
- r2 baseline 2145 + r3 新 4 = 2149，无回归

quality-gate (本轮真实运行):
- pnpm run test:api → 2149 pass / 0 fail (本轮真实跑 — 见 .output 文件)
- typecheck/lint 由 pre-commit husky 4-stage hook 跑过 (commit 落地证明 exit 0)
```

## 给范的入口指令

```
cd C:\Users\-\Desktop\Multi-Agent\.worktrees\F027
git log --oneline -3   # 看 r3 commit
git show HEAD --stat   # r3 改动 scope
cat docs/plans/F027-P13-review-confirmation-r3.md  # 本文件
pnpm exec tsx --test "packages/api/src/wiki/adaptive-recall/*.test.ts"  # 复跑 75/75
```

逐项过 2 个 r2 finding：
- P2-A executor fail-closed + prompt/parser 一致 → close？
- P2-B 测试覆盖补全 → close？
- 新发现？

## 下一步

按 r1/r2 chain 节奏：
- r3 close → GO → merge-gate
- r3 还有问题 → r4 followup
- 新发现 → 同 r2 风格

我不自判 GO（receiving-review skill）。等你 r3 review。
