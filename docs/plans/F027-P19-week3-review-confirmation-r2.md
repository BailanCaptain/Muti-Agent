---
id: F027-P19-week3-review-r2
title: F027 Phase 2 Week 3 r2 修复确认请求 — 范-r1 6 条 finding 全 close
reviewer: 范德彪
requester: 黄仁勋
created: 2026-05-15
status: open
round: r2（同 Week 1/2 r2 模式：全条 Red→Green 修复 + 派 reviewer 二审）
parent: F027-P19-week3-review-request-r1
---

# F027 P19 Week 3 r2 修复确认请求

**Branch / Worktree:** `feat/F027-unified-memory-architecture` @ `.worktrees/F027`
**HEAD:** Week 3 r2 fix commit
**Parent r1:** `docs/plans/F027-P19-week3-review-request-r1.md`

## r1 → r2 修复清单（6 条全 close；P3-1 集成层 Week 4 跟踪不动）

| # | Severity | r1 Finding（你的原话精简） | r2 修复 | 修复位 |
|---|---|---|---|---|
| **P1-1** | 必须改 | `monthly-snapshot.ts:90` Jan-1/month label 用 `toISOString().slice(0,7)`，但 cron 是 Asia/Shanghai；2027-01-01 03:00 CST = UTC 2026-12-31T19:00Z 会标成 `2026-12` | 加 `formatYearMonthShanghai(d)`：按 UTC+8 偏移算 year-month；run() label 改用它 | `monthly-snapshot.ts:91-93` (run) + `:228-240` (helper) |
| **P1-2** | 必须改 | `monthly-snapshot.ts:93` backup optional；`:122-125` drift>threshold 时可无 backup 直接 replace | run() 头部断言：`replaceViewfinder` 提供时 `backup` 必填，否则 throw；dry-run（不传 replaceViewfinder）仍允许无 backup | `monthly-snapshot.ts:95-101` |
| **P2-1** | 应该改 | `nightly-vacuum.ts:143-148` snapshot "last" 按 `id > prev.lastEventId` 判定，乱序导入选错 | events 已 `ORDER BY ts ASC, id ASC` → 迭代中直接覆盖（last-write-wins），删掉 id 比较 | `nightly-vacuum.ts:143-152` |
| **P2-2** | 应该改 | `drift-detector.ts:81-94` 无 idempotency/dedup，scanner 重复返回重复开 draft | 加 `processedTriggerKeys?: Set<string>` 注入（跨 run 去重）+ run() 内 in-run 去重（同 `kind:ref` 只开 1）；`driftTriggerKey()` helper + `result.skippedDuplicate` | `drift-detector.ts:48-62` (option) + `:97-119` (run dedup) |
| **P2-3** | 应该改 | `monthly-snapshot.ts:190-215` drift word-Jaccard，否定句/语义反转漏判 | 加 negation 测试锁定为"已知限制"；真语义 drift 需 LLM verifier（成本高，Phase 2 不接，留 follow-up） | `monthly-snapshot.test.ts` 新 negation case |
| **P2-4** | 应该改 | `monthly-snapshot.ts:99-101` backup failure 直接 return，跳过 `pushAudit` | backup 失败的 fail report 也走 `pushAudit` best-effort（R-201 收到失败告警） | `monthly-snapshot.ts:113-122` |

P3-1（集成层缺位）按你 r1 判定 Week 4 整合一并补，本轮不动。

## 关键设计决策

### P1-1 时区处理
`formatYearMonthShanghai`：`new Date(d.getTime() + 8*3600*1000)` 偏移后用 `getUTC*` 读"墙上时间"。Asia/Shanghai 固定 UTC+8 无 DST，此法精确。Jan-1 测试改用真实 CST 触发时刻 `2026-12-31T19:00:00.000Z`（= 2027-01-01 03:00 CST）验证 label=`2027-01`。

### P1-2 backup 必填语义
选"硬 throw"而非"warn + 继续"：backup 缺失 = 无回滚兜底，drift>30% replace 是破坏性操作，必须 fail-closed。dry-run（caller 不传 replaceViewfinder）是唯一合法的无 backup 场景。

### P2-2 去重两层
- **跨 run**：`processedTriggerKeys` 注入 — caller 持久化"上周已开过 draft 的 trigger key"
- **in-run**：同次 scan 返回的重复 `kind:ref` 只开第一个
- 本类不自己持久化 processed 状态（无状态存储依赖）；caller 决定持久化策略

### P2-3 word-Jaccard 已知限制
不接 LLM semantic verifier（成本 + 复杂度）。加 negation 测试**显式锁定**此限制：`computeDrift("safe to run", "not safe to run")` drift < 0.2。文档注释说明真语义 drift 留 follow-up。

## Test Result（Red→Green）

```
pnpm --filter @multi-agent/api typecheck → exit 0 ✅
npx tsx --test (3 affected files) → 41/41 pass ✅
pnpm test:api → 2371 tests / 2362 pass / 8 skip / 1 todo / 0 fail ✅
  baseline (Week 3 r1) 2364 → +7 new r2 tests / 0 regression
```

## r2 Verdict 期望

按 Week 1/2 r2 模式，r2 应给 **GO（实质）** / **CONDITIONAL（仍有 followup）** / **NO-GO（核心未 close）**。

## 给范的入口指令

```
cd C:\Users\-\Desktop\Multi-Agent\.worktrees\F027
git log --oneline -3
cat docs/plans/F027-P19-week3-review-confirmation-r2.md
pnpm exec tsx --test packages/api/src/services/scheduler/monthly-snapshot.test.ts
pnpm exec tsx --test packages/api/src/services/scheduler/drift-detector.test.ts
pnpm exec tsx --test packages/api/src/services/scheduler/nightly-vacuum.test.ts
pnpm test:api 2>&1 | tail -10
```

逐项过 6 条修复 + 给 r2 verdict（GO/CONDITIONAL/NO-GO）。
