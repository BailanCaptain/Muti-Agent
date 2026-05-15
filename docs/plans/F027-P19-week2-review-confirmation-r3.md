---
id: F027-P19-week2-review-r3
title: F027 Phase 2 Week 2 r3 修复确认请求 — 范-r2 P2-1 CLI wiring 真接
reviewer: 范德彪
requester: 黄仁勋
created: 2026-05-15
status: open
round: r3（同 Week 1 r3 模式：单条 P2-1 实质 fix + 派 reviewer 三审）
parent: F027-P19-week2-review-confirmation-r2
---

# F027 P19 Week 2 r3 修复确认请求

**Branch / Worktree:** `feat/F027-unified-memory-architecture` @ `.worktrees/F027`
**HEAD:** Week 2 r3 fix commit (this PR's parent commit)
**Parent r2 confirmation:** `docs/plans/F027-P19-week2-review-confirmation-r2.md`
**r1 → r2:** 4/5 close
**r2 → r3:** 1/1 close（P2-1 CLI wiring）

## r2 → r3 修复（单条 close）

| # | r2 finding（你的原话） | r3 修复 | 修复位 |
|---|---|---|---|
| **P2-1** | `backfill-docs.ts:489-497` `runBackfill({...})` CLI 入口未调 `scanFrontmatterCommittedSources(...)`，也未把 `frontmatterCommittedSources` 传进 options，helper 形同虚设；需在 CLI `--resume` 路径补一次 frontmatter scan 并合并入 committedSources | 抽 `runBackfillFromCli(cli, ingestFn)` 编排函数；--resume && !--dry-run 时真调 `scanFrontmatterCommittedSources(['wiki/concepts/draft/_backfill', 'wiki/concepts/draft/_auto'])` 并传入 runBackfill；main() 简化为调本函数 + log；返结果加 frontmatterCommittedCount 用于 log + test assert | `backfill-docs.ts:466-501` (runBackfillFromCli) + `:503-528` (main 改) |

## 关键设计决策（避免再发生 "helper 写了 main 没接"）

把 main() 调用编排抽出 `runBackfillFromCli(cli, ingestFn)`：
- main() 内只做 cli args parse + ingest module load + 调 runBackfillFromCli + log
- runBackfillFromCli 持 frontmatter scan + runBackfill 全部编排
- 测试可单独 import + 调 runBackfillFromCli，验证 wiring 真到位

理由：直接测 main() 难（涉 process.argv / require.main），抽出 helper 让 wiring 路径可单测。范 r2 这条 finding 本质是"helper 单测过但 main 没单测"——抽 helper 后单测就能锁住 wiring。

## Test Result（Red→Green）

```
pnpm --filter @multi-agent/api typecheck → exit 0 ✅
npx tsx --test packages/api/scripts/backfill-docs.test.ts → 22/22 pass ✅
pnpm test:api → 2319 tests / 2310 pass / 8 skip / 1 todo / 0 fail ✅
  baseline (r2) 2307 → +3 new CLI wiring tests / 0 regression
```

## 3 个新 fixture 详解

### Fixture 1: --resume 真调 frontmatter scan + 合并 skip（核心）
```ts
// state.jsonl 完全为空（模拟 state 丢失）
// 但 wiki/concepts/draft/_backfill/f999-imported.md frontmatter 标记 source: docs/features/F999.md
const result = await runBackfillFromCli({ rootDir, resume: true, dryRun: false }, ingestFn)
assert.equal(result.frontmatterCommittedCount, 1) // ★ 真调 scan
assert.equal(result.skipped, 1) // ★ F999 frontmatter committed → skip
assert.equal(result.succeeded, 3) // F998 + B999 + L001 真跑
```
**意义**：直接演示 r2 范说"helper 形同虚设" 已 close — wiring 真生效，state 丢失 + frontmatter 完整时 backfill 不重跑。

### Fixture 2 + 3: 反向验证（dry-run / 无 resume 不调 scan）
- dry-run 路径：`frontmatterCommittedCount === 0`（不该调 scan）
- 无 resume：scan 也不调（avoid wasted work）

## 范-r2 ✅ close 的 4 条状态

- P1 wikilink resolver hook ✅ — r2 你确认 close
- P2-2 active vs expired draft split ✅ — r2 你确认 close
- P2-3 self-link skip inbound ✅ — r2 你确认 close
- P3 pollInterval clamp ✅ — r2 你确认 close

本轮只动 P2-1。其他 4 条不再核（已 close）。

## r3 Verdict 期望

按 P13 / Week 1 r3 模式，r3 应给 **GO** / **CONDITIONAL（仍有微调）** / **NO-GO**。

如 GO：Week 2 进 merge-gate；commit 留 worktree（同 Week 1 — phase 级合 dev 需要 evidence pack 双 judge 双 PASS，那是 Week 4 P19.17 的事）。

## 给范的入口指令

```
cd C:\Users\-\Desktop\Multi-Agent\.worktrees\F027

# 看 r3 修复（单文件 + helper 抽取 + 3 新测试）
git show --stat <r3-commit>
git show <r3-commit> -- packages/api/scripts/backfill-docs.ts | head -80

# 看本 confirmation
cat docs/plans/F027-P19-week2-review-confirmation-r3.md

# 复跑测试
pnpm exec tsx --test packages/api/scripts/backfill-docs.test.ts  # 22/22 应过
pnpm test:api 2>&1 | tail -10
```

逐项核 P2-1 CLI wiring 修复 + 给 r3 verdict（GO/CONDITIONAL/NO-GO）。
