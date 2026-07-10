import assert from "node:assert/strict"
import test from "node:test"
import type { TokenUsageSnapshot } from "@multi-agent/shared"
import type { RunTurnResult, SealDecision } from "../runtime/cli-orchestrator"
import { resolveEffectiveTurnResult, sealedThisTurn, settleTurnUsage } from "./turn-usage-settlement"

// F043 AC4 · turn 收尾 fill/prevUsedTokens 记账（从 message-service seal 段同位提取）。
// 病灶两个：①封存轮把 sealDecision.fillRatio（≥action，常 1.0）落进 threads.last_fill_ratio
// —— 新 session 挂旧 100%；②封存轮照常把 sealed usage 写 F-BLOAT 基线 —— 新 session
// 首轮 token 骤降必误报「CLI 内部压缩」。

const usage = (used: number): TokenUsageSnapshot => ({
  usedTokens: used,
  windowTokens: 200_000,
  source: "exact",
})

const seal = (fillRatio: number, u: TokenUsageSnapshot): SealDecision => ({
  shouldSeal: true,
  reason: "threshold",
  fillRatio,
  usage: u,
})

const warn = (fillRatio: number, u: TokenUsageSnapshot): SealDecision => ({
  shouldSeal: false,
  reason: "warn",
  fillRatio,
  usage: u,
})

function harness() {
  const prevUsedTokens = new Map<string, number>()
  const emitted: string[] = []
  let invalidated = 0
  const args = (u: TokenUsageSnapshot | null, d: SealDecision | null) => ({
    threadId: "t1",
    alias: "黄仁勋",
    sessionGroupId: "g1",
    usage: u,
    sealDecision: d,
    prevUsedTokens,
    emit: (ev: { payload: { message: string } }) => emitted.push(ev.payload.message),
    invalidateSummary: () => {
      invalidated++
    },
  })
  return { prevUsedTokens, emitted, invalidated: () => invalidated, args }
}

test("AC4: 封存轮 → lastFillRatio=null + F-BLOAT 基线清零 + 不做用量记账", () => {
  const h = harness()
  h.prevUsedTokens.set("t1", 180_000)
  const u = usage(190_000)
  const r = settleTurnUsage(h.args(u, seal(0.95, u)))
  assert.equal(r.lastFillRatio, null, "封存必须复位 fill，不许把 95%/100% 挂到新 session 上")
  assert.equal(r.threadUsage, null, "AC5：真值三列随 fill 一起清（面板不残留旧 token 数）")
  assert.equal(h.prevUsedTokens.has("t1"), false, "F-BLOAT 基线必须清零")
  assert.equal(r.fBloatDetected, false)
  assert.deepEqual(h.emitted, [], "封存轮不发 F-BLOAT status")
})

test("AC5: 正常轮 threadUsage = usage 真值三元组；无 usage 轮 = undefined 不动列", () => {
  const h = harness()
  const u = usage(28_904)
  const r = settleTurnUsage(h.args(u, null))
  assert.deepEqual(r.threadUsage, { usedTokens: 28_904, windowTokens: 200_000, source: "exact" })

  const r2 = settleTurnUsage(h.args(null, null))
  assert.equal(r2.threadUsage, undefined, "undefined = updateThread 跳过三列，保 DB 旧值")
})

test("AC4 回归: 封存后首轮小用量不误报 F-BLOAT（旧代码必误报的场景）", () => {
  const h = harness()
  // 轮 1：大用量 + 封存
  const u1 = usage(190_000)
  settleTurnUsage(h.args(u1, seal(0.95, u1)))
  // 轮 2：新 session 首轮小用量（骤降 97%——旧代码 detectFBloat(190k, 5k) 必报）
  const u2 = usage(5_000)
  const r2 = settleTurnUsage(h.args(u2, null))
  assert.equal(r2.fBloatDetected, false, "新 session 首轮无基线，不得误报 CLI 自压缩")
  assert.deepEqual(h.emitted, [])
  assert.equal(h.prevUsedTokens.get("t1"), 5_000, "新基线从本轮重新建立")
})

test("warn 轮 → fillRatio 照常落库 + 基线照常记账", () => {
  const h = harness()
  const u = usage(150_000)
  const r = settleTurnUsage(h.args(u, warn(0.75, u)))
  assert.equal(r.lastFillRatio, 0.75)
  assert.equal(h.prevUsedTokens.get("t1"), 150_000)
})

test("无 sealDecision（无 usage 快照的轮）→ lastFillRatio=undefined（updateThread 不动列）", () => {
  const h = harness()
  h.prevUsedTokens.set("t1", 42_000)
  const r = settleTurnUsage(h.args(null, null))
  assert.equal(r.lastFillRatio, undefined, "undefined = 保持 DB 旧值，与 null（清列）语义不同")
  assert.equal(h.prevUsedTokens.get("t1"), 42_000, "无 usage 不动基线")
})

test("F-BLOAT 真阳性保持：同 session 内 token 骤降 → 检出 + status + invalidateSummary", () => {
  const h = harness()
  const u1 = usage(100_000)
  settleTurnUsage(h.args(u1, null))
  const u2 = usage(30_000)
  const r2 = settleTurnUsage(h.args(u2, null))
  assert.equal(r2.fBloatDetected, true)
  assert.equal(h.emitted.length, 1)
  assert.match(h.emitted[0], /CLI 内部压缩检测到（token 突降 70%）/)
  assert.equal(h.invalidated(), 1)
  assert.equal(h.prevUsedTokens.get("t1"), 30_000)
})

test("正常轮（低于 warn）→ fillRatio 照落 + 基线更新", () => {
  const h = harness()
  const u = usage(50_000)
  const r = settleTurnUsage(
    h.args(u, { shouldSeal: false, reason: null, fillRatio: 0.25, usage: u }),
  )
  assert.equal(r.lastFillRatio, 0.25)
  assert.equal(h.prevUsedTokens.get("t1"), 50_000)
})

// ── P1-3（德彪 r1）：派发协议 retry 后，settlement/落库必须消费最终生效的
// RunTurnResult —— 上下文足迹/seal/session 取末次成功尝试；turnTotals（计费）
// 聚合所有实际尝试（失败尝试的 token 真实花掉了，只算末次会低报成本）。

const turnResult = (over: Partial<RunTurnResult>): RunTurnResult => ({
  content: "c",
  nativeSessionId: "s-base",
  currentModel: "m-base",
  stopped: false,
  rawStdout: "",
  rawStderr: "",
  exitCode: 0,
  usage: null,
  turnTotals: null,
  sealDecision: null,
  stopReason: null,
  toolEvents: [],
  ...over,
})

test("P1-3: 无 retry → 原对象直返（common path 与提取前 1:1）", () => {
  const base = turnResult({})
  assert.equal(resolveEffectiveTurnResult(base, []), base)
})

test("P1-3: retry 后足迹/seal/session 全部取末次成功尝试（漏封存病灶）", () => {
  const base = turnResult({
    usage: usage(150_000),
    sealDecision: warn(0.75, usage(150_000)),
    nativeSessionId: "s-attempt-1",
  })
  // retry 轮把上下文推过阈值 —— 旧代码丢弃 retryResult.sealDecision → 本该封存的轮漏封
  const retryUsage = usage(190_000)
  const retry = turnResult({
    usage: retryUsage,
    sealDecision: seal(0.95, retryUsage),
    nativeSessionId: "s-attempt-2",
    currentModel: "m-retry",
  })
  const effective = resolveEffectiveTurnResult(base, [retry])
  assert.equal(effective.usage?.usedTokens, 190_000, "上下文足迹 = 末次尝试")
  assert.equal(effective.sealDecision?.shouldSeal, true, "seal 判定 = 末次尝试（不许漏封）")
  assert.equal(effective.nativeSessionId, "s-attempt-2")
  assert.equal(effective.currentModel, "m-retry")
})

test("P1-3: turnTotals 跨尝试聚合（计费 = 所有实际尝试之和）", () => {
  const base = turnResult({
    turnTotals: {
      totalTokens: 57_820,
      detail: { inputTokens: 18, outputTokens: 348, cacheReadTokens: 49_814, cacheCreationTokens: 7_640 },
    },
  })
  const retry = turnResult({
    turnTotals: {
      totalTokens: 30_000,
      detail: { inputTokens: 10, outputTokens: 90, cacheReadTokens: 25_000, cacheCreationTokens: 4_900 },
    },
  })
  const effective = resolveEffectiveTurnResult(base, [retry])
  assert.deepEqual(effective.turnTotals, {
    totalTokens: 87_820,
    detail: { inputTokens: 28, outputTokens: 438, cacheReadTokens: 74_814, cacheCreationTokens: 12_540 },
  })
})

test("P1-3: turnTotals 单侧缺失 null-safe（不丢已知计费）", () => {
  const totals = {
    totalTokens: 40_000,
    detail: { inputTokens: 5, outputTokens: 95, cacheReadTokens: 30_000, cacheCreationTokens: 9_900 },
  }
  // base 无 totals（如首跑早夭）+ retry 有 → 取 retry
  const a = resolveEffectiveTurnResult(turnResult({}), [turnResult({ turnTotals: totals })])
  assert.deepEqual(a.turnTotals, totals)
  // base 有 + retry 无（如 retry run 没收到 result 事件）→ 保留 base 的计费
  const b = resolveEffectiveTurnResult(turnResult({ turnTotals: totals }), [turnResult({})])
  assert.deepEqual(b.turnTotals, totals)
  // 双侧皆无 → null 语义保持（落库不写列）
  const c = resolveEffectiveTurnResult(turnResult({}), [turnResult({})])
  assert.equal(c.turnTotals ?? null, null)
})

// ── 修2（德彪 r2 残留）：seal 生命周期钩子（digest/ThreadMemory/sessionChain/
// auto-resume）原判 loopResult.stoppedReason==="sealed" —— 该值定格在 retry 前
// （continuation-loop.ts:52 与末次 sealDecision 同源），retry 越阈时仍是 "complete"，
// 钩子被跳过而 seal 事件+session 清空照发 → 脑裂。统一谓词 sealedThisTurn(生效结果)。

test("修2: sealedThisTurn —— retry 越阈补封存（r2 病灶场景）", () => {
  const u = usage(190_000)
  // 原尝试未封存（loop stoppedReason="complete"）+ retry 越阈 → 钩子必须运行
  const effective = resolveEffectiveTurnResult(
    turnResult({ sealDecision: warn(0.75, usage(150_000)) }),
    [turnResult({ sealDecision: seal(0.95, u) })],
  )
  assert.equal(sealedThisTurn(effective), true, "retry 越阈 → digest/ThreadMemory 钩子必须触发")
})

test("修2: sealedThisTurn —— 以生效结果为唯一真相源（双向）", () => {
  const u = usage(190_000)
  // 反向：原封存 + retry 后判不封（如 rollout 回读出更小足迹）→ 钩子不跑，
  // 与 seal 事件/settlement（都吃生效结果）保持同一真相，不产生反向脑裂
  const effective = resolveEffectiveTurnResult(
    turnResult({ sealDecision: seal(0.95, u) }),
    [turnResult({ sealDecision: warn(0.6, usage(120_000)) })],
  )
  assert.equal(sealedThisTurn(effective), false)
  // 无 retry 常路：与 continuation-loop stoppedReason==="sealed" 谓词严格等价（1:1）
  assert.equal(sealedThisTurn(turnResult({ sealDecision: seal(0.95, u) })), true)
  assert.equal(sealedThisTurn(turnResult({ sealDecision: warn(0.5, u) })), false)
  assert.equal(sealedThisTurn(turnResult({ sealDecision: null })), false)
})

test("P1-3: 多次 retry 折叠 —— 身份字段取最末，计费三段全加", () => {
  const base = turnResult({
    usage: usage(100_000),
    nativeSessionId: "s-1",
    turnTotals: { totalTokens: 10_000 },
  })
  const r1 = turnResult({
    usage: usage(120_000),
    nativeSessionId: "s-2",
    turnTotals: { totalTokens: 8_000 },
  })
  const r2 = turnResult({
    usage: usage(130_000),
    nativeSessionId: "s-3",
    turnTotals: { totalTokens: 7_000 },
  })
  const effective = resolveEffectiveTurnResult(base, [r1, r2])
  assert.equal(effective.usage?.usedTokens, 130_000)
  assert.equal(effective.nativeSessionId, "s-3")
  assert.equal(effective.turnTotals?.totalTokens, 25_000)
})
