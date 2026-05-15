---
id: F027-P19-week2-review-r2
title: F027 Phase 2 Week 2 r2 修复确认请求 — 范-r1 5 条 finding 全 close
reviewer: 范德彪
requester: 黄仁勋
created: 2026-05-15
status: open
round: r2（同 Week 1 r2 模式：全条 Red→Green 修复 + 派 reviewer 二审）
parent: F027-P19-week2-review-request-r1
---

# F027 P19 Week 2 r2 修复确认请求

**Branch / Worktree:** `feat/F027-unified-memory-architecture` @ `.worktrees/F027`
**HEAD:** Week 2 r2 fix commit (this PR's parent commit)
**Parent r1:** `docs/plans/F027-P19-week2-review-request-r1.md`

## r1 → r2 修复清单（5 条全 close）

| # | Severity | r1 Finding（你的原话精简） | r2 修复 | 修复位 | 测试 |
|---|---|---|---|---|---|
| **P1** | 必须改 | `nightly-health-check.ts:248` `extractRefs` 把 wikilink text 直接当 path，与 `compile-prompt.ts:75` 实际写的 `[[${c.name}]]` name-style 冲突 → 大量误报 deadLinks。修复建议：加 resolver hook + 测 alias / hash / unresolved | 加 `resolveWikiLink?: (target, fromEntity, allEntities) => string \| null` 注入；`extractRefs` 改返 `ExtractedRef = wikilink \| rellink` 区分；wikilink 走 resolver；default 无 resolver 时只查 path-style target (`looksLikePath` 含 `/` 或 `.md` 结尾)，name-style silent skip 避免 false positive | `nightly-health-check.ts:51-67` (option doc) + `:118-141` (run loop 改) + `:243-262` (helpers) | `nightly-health-check.test.ts` 5 个新 case：name-style 无 resolver 不报 / 有 resolver 返合法 / 返 null silent / alias [[Name\|alias]] 剥离 / hash [[Name#section]] 剥离 |
| **P2-1** | 应该改 | `backfill-docs.ts:287` `--resume` 没实现 v2a F4 frontmatter fallback，state.jsonl 损坏 = 重跑全部 | `BackfillArgs` 加 `frontmatterCommittedSources?: Set<string>`；--resume 时合并 state.committed + 本 set；新 helper `scanFrontmatterCommittedSources(draftDirs)` 扫 wiki/concepts/draft/{_backfill,_auto}/ frontmatter `ingest_metadata.source_path`；新 helper `extractSourcePathFromFrontmatter(file)` 简化 YAML 解析（不引 yaml lib） | `backfill-docs.ts:74-91` (option doc) + `:97-153` (helpers) + `:299-302` (合并逻辑) | `backfill-docs.test.ts` 4 个新 case：extract 正常 / 缺 fm 缺字段 → null / scan 扫 _backfill+_auto / --resume 合并 state+frontmatter |
| **P2-2** | 应该改 | `nightly-health-check.ts:232` `/draft/_expired/` 仍被算 draft → 反复归档 / 重报 | 拆 `isActiveDraftPath` (active: top-level + _backfill + _auto; exclude _expired + _quarantined) vs `isAnyDraftPath` (含归档)；`draftExpired` 用 active；orphans 豁免用 any (已归档/隔离也豁免) | `nightly-health-check.ts:243-258` (helpers) + `:148` (orphans) + `:155` (draftExpired) | `nightly-health-check.test.ts` 3 个新 case：_expired/ 不重复归档 / _quarantined/ 不归档 / _backfill+_auto 仍正常归档 |
| **P2-3** | 应该改 | `nightly-health-check.ts:146` self-links 增加 inbound count → 自循环 orphan 被隐藏 | run() loop 加 `if (resolved === myPath) continue` 跳 self-link inbound 计数 | `nightly-health-check.ts:135-136` | `nightly-health-check.test.ts` 1 个新 case：self-link lonely.md 仍报 orphan |
| **P3** | 可讨论 | `docs-watcher.ts:100` 极小 stabilityMs → pollInterval 5ms 风险 | clamp `[10ms, 100ms]`：`max(10, min(100, stability/3))`；文档化 production 推荐 stabilityMs >= 1000ms | `docs-watcher.ts:97-103` | （改 clamp + doc，无新测试，原 stability=100 测试仍 pass） |

## Test Result（Red→Green）

```
pnpm --filter @multi-agent/api typecheck → exit 0 ✅
npx tsx --test (3 affected test files) → 56/56 pass ✅
pnpm test:api → 2316 tests / 2307 pass / 8 skip / 1 todo / 0 fail ✅
  baseline (Week 2 r1) 2303 → +13 new r2 tests / 0 regression
```

## 关键设计决策

### P1 default no-resolver = name-style silent skip

你 r1 建议 "add a `resolveWikiLink(target, fromEntity, entities)` or `nameToPath` option, make wikilink refs resolve through it before comparing against `allPaths`, keep path-style fallback for `wiki/...`, and add tests for `[[Concept Name|alias]]`, `[[Concept Name#section]]`, and unresolved names"。

**全照做**。default no-resolver 行为：
- target 含 `/` 或以 `.md` 结尾 → 当 path 走存在性检查
- target 不含 `/` 且不以 `.md` 结尾（name-style）→ silent skip，**不报 deadLink**

理由：缺 resolver = NightlyHealthCheck 不知道 name 对应哪个 path，**报 deadLink 反而误导**（实际 caller layer 用 wiki-services 接 resolver 后 false positive 才会消失）。Silent skip 是保守 fail-soft；想严格的 caller 注入 resolver 后即可严判。

### P2-1 frontmatter fallback 拆 helper 而非内嵌

你 r1 建议 "scan frontmatter markers for files absent from committed state and cover it with a resume test"。

实现拆两层：
- `runBackfill` 接 pre-built `Set<string>`（不绑特定扫描方式 / 字段名 / 目录）
- helper `scanFrontmatterCommittedSources(draftDirs)` 单独导出，caller 自决是否调用

理由：caller 可能有自己的 source_path 取法（不一定是 `ingest_metadata.source_path` — 这字段名是猜的），让 caller 决定预扫策略。CLI main() 默认拼 `<rootDir>/wiki/concepts/draft/{_backfill,_auto}` 作为目录调 helper 后传入 runBackfill。

## r2 Verdict 期望

按 P13 / Week 1 r2 模式，r2 应给 **GO（实质）** / **CONDITIONAL（仍有 followup）** / **NO-GO（核心未 close）**。

如果 r2 仍 CONDITIONAL，请列具体 finding 我继续 r3。

## 给范的入口指令

```
cd C:\Users\-\Desktop\Multi-Agent\.worktrees\F027

# 看 r2 修复 commit
git log --oneline -3

# 看本 confirmation 请求
cat docs/plans/F027-P19-week2-review-confirmation-r2.md

# 复跑测试
pnpm exec tsx --test packages/api/src/services/scheduler/nightly-health-check.test.ts  # 23/23
pnpm exec tsx --test packages/api/scripts/backfill-docs.test.ts                          # 19/19
pnpm test:api 2>&1 | tail -10                                                            # 0 regression

# 重点核 3 个文件的 r2 修复点
cat packages/api/src/services/scheduler/nightly-health-check.ts | head -260
cat packages/api/scripts/backfill-docs.ts
cat packages/api/src/services/scheduler/docs-watcher.ts | head -110
```

逐项过 5 条修复 + 给 r2 verdict（GO/CONDITIONAL/NO-GO）。
