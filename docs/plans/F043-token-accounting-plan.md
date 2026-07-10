# F043 Token 用量口径修复 + 上下文可观测 Implementation Plan

**Feature:** F043 — `docs/features/F043-token-accounting-fix.md`
**Goal:** 封存假阳性根治（usedTokens 从累计计费值翻正为真实上下文足迹 + 窗口分母修正 + 封存后复位）+ per-call token 可见（明细持久化 → MessageMeta → 面板真值直传 → 轮中实时）。
**Acceptance Criteria:**
- AC0 CLI 事件结构实测前置（✅ 已闭环，探针档案 `.agents/acceptance/F043/probes/`，字段引用回指 PROBE-NOTES.md）
- AC1 claude 口径分离：footprint = 末次 message_start（delta fallback）的 in+cache_read+cache_creation；result 累计不进 seal
- AC2 codex 口径修复：rollout 回读 `last_token_usage` + `model_context_window`；退化 = input_tokens 单值标 approx
- AC3 窗口解析：claude modelUsage exact；兜底表 opus-4-8→1M / gemini-2.5→1,048,576 / gpt-5.5→258,400（实测值）；gemini warn-only fail-open
- AC4 封存后复位：last_fill_ratio→null + prevUsedTokens 清零 + 面板 sealed 态"待重启"
- AC5 usage 明细持久化（messages token 列 + threads 真值列，additive migration 双清单）
- AC6 MessageMeta 点亮（inputTokens/outputTokens/cachedPercent 透传）
- AC7 面板真值直传（ProviderThreadView + usedTokens/windowTokens/usageSource；approx 标注；无数据显示"无数据"）
- AC8 轮中实时更新（onUsageSnapshot → 节流 WS → 面板）
- AC9 测试口径翻正（错误断言重写 + 真实事件序列回归重放）

**Architecture:** parseUsage 契约扩为 `ParsedUsage {scope: 'context'|'turn_total', exact, detail, modelWindows}`；orchestrator 做 scope 路由（只 context 进 latestUsage/seal，turn_total 存 turnTotals 供 P1）；新增 `resolveUsage` post-run hook（同族 afterRun 模式），codex 覆写做 rollout tail 回读并覆盖流内 approx 值；seal 判定移到 resolveUsage 合并之后。数据流：adapter → orchestrator snapshot → message-service 落库（threads 真值列 + assistant 消息 token 列）→ ProviderThreadView/TimelineMessage 直传 → 前端渲染真值。

**Tech Stack:** TypeScript monorepo（shared/api/Next 前端）、node:test + vitest、better-sqlite3 additive migration、探针 ndjson 作 fixture。

**锚点文件**（写码前必读）：`.agents/acceptance/F043/probes/PROBE-NOTES.md`（字段真相源）+ `PLAN-SEED.md`（代码锚点表）。

---

## Task 0: AC0 证据登记（无代码）

探针已闭环。仅确认：`.agents/acceptance/F043/probes/` 含 claude-2.1.206-multicall.ndjson / claude-2.1.206-opus48.ndjson / codex-0.144.1-multicall.ndjson / gemini-0.49.0.err / PROBE-NOTES.md。AC0 四项在 feature doc 打勾（探针档案归档 ✓）。

## Task 1: shared 类型扩展 + 窗口兜底表翻正（AC3 表部分）

**Files:**
- Modify: `packages/shared/src/constants.ts:100-137`
- Test: `packages/shared/src/constants.test.ts`（如无则新建；先 `ls packages/shared/src/*.test.ts` 确认）

**Step 1.1 失败测试**（窗口表）：

```typescript
// constants.test.ts 追加
test("window fallbacks: opus-4-8 resolves to 1M (F043 AC0 measured)", () => {
  assert.equal(getContextWindowForModel("claude-opus-4-8"), 1_000_000)
  assert.equal(getContextWindowForModel("claude-opus-4-8-20260115"), 1_000_000)
})
test("window fallbacks: gemini-2.5 family mapped", () => {
  assert.equal(getContextWindowForModel("gemini-2.5-pro"), 1_048_576)
})
test("window fallbacks: gpt-5.5 uses CLI-reported 258400 not 1M", () => {
  assert.equal(getContextWindowForModel("gpt-5.5"), 258_400)
})
test("window fallbacks: gpt-5.6 family mapped to measured 353400", () => {
  assert.equal(getContextWindowForModel("gpt-5.6-sol"), 353_400)
})
```

**Step 1.2 跑测确认失败** → `pnpm --filter @multi-agent/shared test`

**Step 1.3 实现**：CONTEXT_WINDOW_FALLBACKS 改为（顺序敏感，特例在前）：

```typescript
const CONTEXT_WINDOW_FALLBACKS: ReadonlyArray<{ match: RegExp; window: number }> = [
  { match: /^gemini-3/i, window: 1_048_576 },
  // F043 AC0 实测（07-10）：gemini-2.5 家族 1M
  { match: /^gemini-2\.5/i, window: 1_048_576 },
  // F043 AC0 实测（07-10）：opus-4-8 账户生效窗口 1M（modelUsage.contextWindow 探针实证）；4-7 沿革值
  { match: /^claude-opus-4-[78]/i, window: 1_000_000 },
  { match: /^claude-(opus|sonnet|haiku)-4/i, window: 200_000 },
  { match: /^claude-/i, window: 200_000 },
  // F043 AC0 实测（07-10）：codex rollout model_context_window 自报值。
  // 兜底表仅在 rollout 回读失败时使用；数值随 CLI 换代漂移（07-06 gpt-5.5=258,400 / 07-10 gpt-5.6-sol=353,400），
  // 以回读为主、表为快照。
  { match: /^gpt-5\.6/i, window: 353_400 },
  { match: /^gpt-5\.5/i, window: 258_400 },
  { match: /^gpt-5/i, window: 400_000 },
  { match: /^gpt-4/i, window: 128_000 },
  { match: /^o3/i, window: 200_000 },
]
```

**Step 1.4 类型扩展**（同文件，TokenUsageSnapshot 处）：

```typescript
/** 单轮 token 明细（P1 展示 + 落库用）。字段语义 = Anthropic/OpenAI usage 原字段。 */
export type UsageDetail = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

/**
 * F043：usedTokens = 当前上下文真实足迹（claude=末次 message_start in+cr+cc；codex=rollout
 * last_token_usage.total_tokens；gemini=CLI 累计值，仅 approx）。
 * source 语义升级：整体快照质量 —— exact 仅当分子为真足迹且窗口来自 CLI 自报；
 * 任一为兜底/估计 → approx（AC7 前端据此标注）。
 */
export type TokenUsageSnapshot = {
  usedTokens: number
  windowTokens: number
  source: "exact" | "approx"
  detail?: UsageDetail
}
```

**Step 1.5 跑测通过 + build** → `pnpm --filter @multi-agent/shared test && pnpm --filter @multi-agent/shared build`

**Step 1.6 Commit** → `git commit packages/shared -m "feat(F043): 窗口兜底表翻正（opus-4-8→1M 实测/gemini-2.5/gpt-5.x）+ TokenUsageSnapshot 明细扩展 [黄仁勋/Fable-5 🐾]"`

## Task 2: ParsedUsage 契约 + claude 口径分离（AC1 + AC3 modelUsage）

**Files:**
- Modify: `packages/api/src/runtime/base-runtime.ts:588-602`（parseUsage 签名 + 新类型 + resolveUsage 默认实现）
- Modify: `packages/api/src/runtime/claude-runtime.ts:235-282`
- Test: `packages/api/src/runtime/context-seal.test.ts`（claude 段重写）
- Fixture: `packages/api/src/runtime/__fixtures__/f043/claude-multicall.ndjson`（从探针档案拷贝）

**Step 2.1 类型定义**（base-runtime.ts，或独立 `runtime-usage-types.ts` 若 base 已过长）：

```typescript
/** F043：parseUsage/resolveUsage 统一返回形。scope 区分两种语义，orchestrator 据此路由。 */
export type ParsedUsage = {
  /** context=当前上下文足迹（进 seal 判定）；turn_total=整轮累计计费值（仅 P1 统计） */
  scope: "context" | "turn_total"
  totalTokens: number
  contextWindow: number | null
  /** 分子是否精确足迹。claude message_start=true；codex 流内退化=false；gemini=false */
  exact: boolean
  detail?: UsageDetail
  /** claude result.modelUsage 提炼：完整模型名 → contextWindow。orchestrator 按 currentModel 匹配。 */
  modelWindows?: Record<string, number>
}
```

parseUsage 签名 → `ParsedUsage | null`；新增：

```typescript
/**
 * F043：post-run usage 回读 hook（同族 afterRun 模式）。CLI 流内拿不到真足迹的 runtime
 * （codex：足迹只在 rollout 文件里）覆写此方法；返回非空则覆盖流内快照。默认 null。
 */
async resolveUsage(_ctx: { sessionId: string | null }): Promise<ParsedUsage | null> {
  return null
}
```

**Step 2.2 失败测试**（claude 段重写 context-seal.test.ts；数值全部回指 PROBE-NOTES.md 表）：

```typescript
// message_start → context footprint（in+cr+cc，不含 output）
test("claude message_start yields context-scope footprint (in+cache_read+cache_creation)", () => {
  const usage = claude.parseUsage({
    type: "stream_event",
    event: { type: "message_start", message: { id: "m1", model: "claude-haiku-4-5-20251001",
      usage: { input_tokens: 10, cache_creation_input_tokens: 7302, cache_read_input_tokens: 21256, output_tokens: 1 } } },
  })
  assert.deepEqual(usage, {
    scope: "context", totalTokens: 28_568, contextWindow: null, exact: true,
    detail: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 21_256, cacheCreationTokens: 7302 },
  })
})
// message_delta → context fallback（同口径）
// result → turn_total + modelWindows（不产 context snapshot）
test("claude result yields turn_total scope with modelWindows, never context", () => {
  const usage = claude.parseUsage({
    type: "result",
    usage: { input_tokens: 18, cache_creation_input_tokens: 7640, cache_read_input_tokens: 49_814, output_tokens: 100 },
    modelUsage: { "claude-haiku-4-5-20251001": { inputTokens: 18, outputTokens: 100,
      cacheReadInputTokens: 49_814, cacheCreationInputTokens: 7640, contextWindow: 200_000, costUSD: 0.01 } },
  })
  assert.equal(usage?.scope, "turn_total")   // totalTokens 含 output：fixture 实测 57,820
  assert.deepEqual(usage?.modelWindows, { "claude-haiku-4-5-20251001": 200_000 })
})
```

**Step 2.3 跑测确认失败**（tsc 也会红——parseUsage 返回形变了，codex/gemini 同步编译错：本 Task 一并把三 adapter 签名迁到 ParsedUsage，codex/gemini 行为暂按现状直译 + 标 scope/exact，语义修复在 Task 3/5）。

**Step 2.4 claude 实现**：readUsage 拆两个提取器：

```typescript
const readDetail = (raw: unknown): UsageDetail | null => { /* 四字段各自 typeof 守卫，全 0 → null */ }
const footprintOf = (d: UsageDetail) => d.inputTokens + d.cacheReadTokens + d.cacheCreationTokens
const totalOf = (d: UsageDetail) => footprintOf(d) + d.outputTokens
```

- message_start / message_delta（含 unwrap 与非 unwrap 两路径）→ `{ scope: "context", totalTokens: footprintOf(d), exact: true, detail: d, contextWindow: null }`
- result → `{ scope: "turn_total", totalTokens: totalOf(d), exact: true, detail: d, contextWindow: null, modelWindows }`，modelWindows 从 `event.modelUsage` 遍历 Object.entries 提炼 `{ [fullModelName]: entry.contextWindow }`（number 守卫；**禁短名索引**）。

**Step 2.5 fixture 重放测试**：拷 `claude-2.1.206-multicall.ndjson` 到 `__fixtures__/f043/`；测试逐行 JSON.parse → parseUsage，断言：最后一个 context-scope 结果 totalTokens=28,904（末次调用足迹）；turn_total 结果 totalTokens=57,472（整轮求和）；两值不同即口径分离实证。

**Step 2.6 跑测通过** → `pnpm --filter @multi-agent/api test -- --test-name-pattern claude`（以实际 runner 语法为准）

**Step 2.7 Commit**

## Task 3: codex 口径修复 + rollout 回读（AC2）

**Files:**
- Modify: `packages/api/src/runtime/codex-runtime.ts:219-240`（parseUsage）+ 新增 resolveUsage
- Test: `packages/api/src/runtime/context-seal.test.ts`（codex 段重写）+ `codex-rollout-usage.test.ts`（新建）
- Fixture: `__fixtures__/f043/codex-rollout-tail.jsonl`（探针 rollout 末段 token_count 行）

**Step 3.1 失败测试**（流内退化路径）：

```typescript
// AC9：删除旧断言 "sums input + cached"（:50，实测双计）
test("codex parseUsage: input_tokens only (no cached double-count), approx context", () => {
  const usage = codex.parseUsage({ type: "turn.completed",
    usage: { input_tokens: 39_727, cached_input_tokens: 37_120, output_tokens: 213 } })
  assert.equal(usage?.scope, "context")   // 退化估计仍要喂 seal（否则 codex 无保护）
  assert.equal(usage?.exact, false)        // 但必须标 approx
  assert.equal(usage?.totalTokens, 39_727) // 不加 cached
})
```

**Step 3.2 rollout 回读失败测试**（fixture 行结构照抄探针 `{payload:{type:"token_count",info:{last_token_usage:{...},total_token_usage:{...},model_context_window:353400}}}`）：

```typescript
test("codex resolveUsage tail-reads rollout: last_token_usage + model_context_window", async () => {
  // temp dir 铺 sessions/2026/07/10/rollout-xxx-<sid>.jsonl（fixture 内容）
  const usage = await runtime.resolveUsage({ sessionId: "<sid>" })
  assert.equal(usage?.scope, "context")
  assert.equal(usage?.exact, true)
  assert.equal(usage?.totalTokens, 13_400 /* 末条 last_token_usage.total_tokens（in 13,384 + out 16） */)
  assert.equal(usage?.contextWindow, 353_400)
})
test("codex resolveUsage returns null when rollout missing (degraded path keeps stream approx)", async () => {
  assert.equal(await runtime.resolveUsage({ sessionId: "no-such" }), null)
})
test("codex resolveUsage returns null for null sessionId", async () => { ... })
test("codex resolveUsage tolerates malformed tail lines (skip non-JSON, find last token_count)", async () => { ... })
```

**Step 3.3 实现 resolveUsage**（对标 clowder `codex-session-context-snapshot.ts`，架构不抄数值）：

```typescript
// 构造注入：constructor(deps) 里可选 sessionsDir 覆盖（默认 path.join(os.homedir(), ".codex", "sessions")），测试注 temp dir。
async resolveUsage(ctx: { sessionId: string | null }): Promise<ParsedUsage | null> {
  if (!ctx.sessionId) return null
  try {
    const file = this.findRolloutFile(ctx.sessionId) // 今天/昨天日期目录优先，兜底全量 walk；文件名含 sessionId
    if (!file) return null
    // 逐行读取（文件 ≤ 数 MB，readFileSync + split 足够；行倒序找最后一条 token_count）
    const info = lastTokenCountInfo(file)
    if (!info?.last_token_usage) return null
    const last = info.last_token_usage
    const window = typeof info.model_context_window === "number" ? info.model_context_window : null
    return {
      scope: "context", exact: true,
      totalTokens: last.total_tokens ?? (last.input_tokens + last.output_tokens),
      contextWindow: window,
      detail: { inputTokens: last.input_tokens ?? 0, outputTokens: last.output_tokens ?? 0,
        cacheReadTokens: last.cached_input_tokens ?? 0, cacheCreationTokens: 0 },
    }
  } catch { return null } // 回读永不 fail turn
}
```

**Step 3.4 跑测通过 → Commit**

## Task 4: orchestrator scope 路由 + resolveUsage 接线 + seal 时序（AC1/AC2 集成）

**Files:**
- Modify: `packages/api/src/runtime/cli-orchestrator.ts:221-237`（事件路径）+ `:256-280`（.then 收尾）+ `RunTurnResult` 加 `turnTotals`
- Test: `context-seal.test.ts`（computeSealDecision 段保留）+ `cli-orchestrator-usage.test.ts`（新建，RuntimeDependencies.spawn 注入假进程喂 fixture ndjson 走真 runTurn）

**Step 4.1 失败测试**（关键行为四条）：

1. context 快照域内 latest-wins：喂 claude multicall fixture 全序列 → `result.usage.usedTokens === 28_904`（非 57,472 非 989k 族）。
2. turn_total 不进 seal：只发 result 事件（无 message_start）→ `result.usage === null`（无 context 快照）且 `result.turnTotals?.totalTokens === 57_472`。
3. 窗口升级：message_start（context, window null → 兜底表）后 result 带 modelWindows{完整名:200_000} 且 currentModel 前缀匹配 → 最终 `usage.windowTokens === 200_000` 且 `source === "exact"`（分子 exact + 窗口 exact）。
4. resolveUsage 覆盖：fake runtime resolveUsage 返回 exact context → 最终 usage 被覆盖 + sealDecision 按覆盖后值计算（喂一个流内假高值+回读真低值，断言 shouldSeal=false）。

**Step 4.2 实现**：

```typescript
// 事件路径（:221）——scope 路由：
let latestUsage: TokenUsageSnapshot | null = null
let latestExactWindow: number | null = null     // CLI 自报窗口（含 modelWindows 匹配值），跨事件保持
let latestContextParsed: ParsedUsage | null = null
let turnTotals: ParsedUsage | null = null

if (usageRaw) {
  if (usageRaw.contextWindow != null) latestExactWindow = usageRaw.contextWindow
  if (usageRaw.modelWindows) {
    const matched = pickModelWindow(usageRaw.modelWindows, currentModel) // 前缀匹配→单条目取之→最大窗口
    if (matched != null) latestExactWindow = matched
  }
  if (usageRaw.scope === "turn_total") { turnTotals = usageRaw }
  else { latestContextParsed = usageRaw }
  latestUsage = buildSnapshot(latestContextParsed, latestExactWindow, options) // 见下
}

function buildSnapshot(parsed: ParsedUsage | null, exactWindow: number | null, options): TokenUsageSnapshot | null {
  if (!parsed) return null
  const windowTokens = options.contextWindowOverride ?? exactWindow ?? getContextWindowForModel(currentModel)
  if (!windowTokens || windowTokens <= 0 || parsed.totalTokens <= 0) return null
  return { usedTokens: parsed.totalTokens, windowTokens,
    source: parsed.exact && exactWindow != null ? "exact" : "approx", detail: parsed.detail }
}
```

关键点：**result 到达时（turn_total + modelWindows）要重建 latestUsage**（窗口升级），即 turn_total 分支后也调 buildSnapshot（用旧 latestContextParsed + 新 exactWindow）——这修掉"末次 message_start 在 result 前、窗口升级丢失"的时序洞。onUsageSnapshot 每次重建后触发（AC8 复用）。

```typescript
// .then 收尾（afterRun 之后）：
try {
  const resolved = await runtime.resolveUsage({ sessionId: currentSessionId })
  if (resolved && resolved.scope === "context" && resolved.totalTokens > 0) {
    if (resolved.contextWindow != null) latestExactWindow = resolved.contextWindow
    latestContextParsed = resolved
    latestUsage = buildSnapshot(latestContextParsed, latestExactWindow, options)
    if (latestUsage) options.onUsageSnapshot?.(latestUsage)
  }
} catch { /* 回读失败保留流内值 */ }
return { ..., usage: latestUsage, turnTotals: turnTotalsToResult(turnTotals),
  sealDecision: computeSealDecision(options.provider, latestUsage, options.sealThresholds), ... }
```

`RunTurnResult` 加 `turnTotals: { totalTokens: number; detail?: UsageDetail } | null`（continuation-loop 测试的字面量对象需补该字段——additive，加 `turnTotals: null` 即可）。

**Step 4.3 跑测通过 → Step 4.4 全仓 api 测试跑一遍（编译连锁面）→ Commit**

## Task 5: gemini warn-only fail-open（AC3 尾）

**Files:**
- Modify: `packages/api/src/runtime/gemini-runtime.ts:200-223`（迁 ParsedUsage：scope="context", exact=false + 注释）
- Modify: `packages/api/src/runtime/cli-orchestrator.ts` computeSealDecision
- Test: `context-seal.test.ts`

**Step 5.1 失败测试**：

```typescript
test("gemini: action-threshold fill downgrades to warn (fail-open until live-tested)", () => {
  const d = computeSealDecision("gemini", snapshot(900_000, 1_048_576)) // 0.858 ≥ action 0.8
  assert.equal(d?.shouldSeal, false)
  assert.equal(d?.reason, "warn")
})
test("claude/codex action threshold still seals", () => { ... })
```

**Step 5.2 实现**（computeSealDecision 内）：

```typescript
if (fillRatio >= thresholds.action) {
  // F043 AC3：gemini usedTokens 仍为 CLI 累计口径（stats.total_tokens）且 CLI 地区墙无法活测，
  // approx 数据不触发硬动作（对标 clowder F062）——只 warn 不封存。
  // 解封条件：gemini CLI 恢复后活测口径，确认 footprint 语义再启用。
  if (provider === "gemini") return { shouldSeal: false, reason: "warn", fillRatio, usage }
  return { shouldSeal: true, reason: "threshold", fillRatio, usage }
}
```

**Step 5.3 AC9 顺手**：删 gemini "stats.context_window 存在性" 旧断言（v0.49 无此字段——保留解析代码作前向兼容，但测试改为"字段缺失 → contextWindow null"为主路径）。

**Step 5.4 跑测通过 → Commit**

## Task 6: 封存后状态复位（AC4）

**Files:**
- Modify: `packages/api/src/services/message-service.ts:2431-2508`
- Modify: `components/chat/right-panel/agent-list.tsx`（sealed 态"待重启"）+ 上游 props 链（status-panel.tsx / thread-store.ts 的 sealed 透传，实读确认现状再动）
- Test: message-service 现有 seal 相关测试文件（TDD 时 `grep -l "sealDecision" packages/api/src/**/*.test.ts` 定位；无则在既有 service 测试壳里加）+ `agent-list.test.tsx`

**Step 6.1 失败测试**（后端）：shouldSeal 轮 → `updateThread` 收到 `lastFillRatio === null` + `prevUsedTokens` 不含该 thread（下一轮 F-BLOAT 不误报）；warn 轮 → fillRatio 照旧落库。

**Step 6.2 实现**：

```typescript
// :2439 seal 分支内追加
this.prevUsedTokens.delete(thread.id)
// :2501 改
const lastFillRatio = result.sealDecision?.shouldSeal ? null : result.sealDecision?.fillRatio
```

**Step 6.3 前端失败测试**：`sealed=true, fillRatio=null` → 渲染"待重启"徽记；`sealed=false, fillRatio=null` → 维持现占位（agent-list.test.tsx:67 既有行为不回归）。

**Step 6.4 前端实现**：ProviderThreadView.sealed 已存在（realtime.ts:184，F021 AC-32）→ 透传链补齐（thread-store card → status-panel :83 附近 → agent-list props），agent-list 渲染 sealed 徽记。

**Step 6.5 跑测通过 → Commit**

## Task 7: usage 明细持久化（AC5）

**Files:**
- Modify: `packages/api/src/db/sqlite.ts`（migration 清单 + row mapper）与 `packages/api/src/db/drizzle-instance.ts`（**双清单同步**，house 模式见 model/retry_count 先例 :446/:662）
- Modify: `packages/api/src/services/session-service.ts`（updateThread 扩真值三列；overwriteMessage/appendMessage 路径带 token 四列）
- Modify: `packages/api/src/services/message-service.ts`（turn 收尾把 `result.turnTotals.detail` 落 assistant 消息；`result.usage` 真值落 threads）
- Test: db migration 测试（照 `messages-retry-count.test.ts` 模式）+ service 测试

**Migration（additive，两文件同 SQL）：**

```sql
ALTER TABLE messages ADD COLUMN input_tokens INTEGER;
ALTER TABLE messages ADD COLUMN output_tokens INTEGER;
ALTER TABLE messages ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE messages ADD COLUMN cache_creation_tokens INTEGER;
ALTER TABLE threads ADD COLUMN last_used_tokens INTEGER;
ALTER TABLE threads ADD COLUMN last_window_tokens INTEGER;
ALTER TABLE threads ADD COLUMN last_usage_source TEXT;
```

**要点**：threads 三列随 last_fill_ratio 同点写入（updateThread 扩签名——注意 AC4 复位时三列同置 null）；messages 四列在 turn 收尾 overwriteMessage 时带上（claude=turnTotals.detail 整轮计费；codex=usage.detail；gemini=null 不写）；NULL=无数据（旧行/gemini），语义与 0 区分。

**Step 顺序**：migration 失败测试（新库两文件各自开出 → PRAGMA table_info 断言列存在；旧库升级不丢数据）→ 实现 → service 落库失败测试 → 实现 → Commit。

## Task 8: MessageMeta 点亮（AC6）

**Files:**
- Modify: `packages/api/src/services/session-service.ts` toTimelineMessage/mapTimelineMessage（token 列 → `inputTokens/outputTokens/cachedPercent`；wire 字段已存在 realtime.ts:99-101）
- Test: session-service mapping 测试 + E2E 种子扩展（`webapp-testing` 既有 harness：种一条带 token 列的 assistant 消息 → 断言气泡下胶囊文本）

**cachedPercent 定义**（写进代码注释）：`round(cacheRead / (input + cacheRead + cacheCreation) * 100)`，分母 0 → 0。

**Step**：mapping 失败测试（行含 token 列 → TimelineMessage 三字段；NULL 列 → 字段 undefined，MessageMeta 返 null 不渲染）→ 实现 → E2E 断言 `缓存 \d+%` 胶囊 → Commit。

## Task 9: 面板真值直传（AC7）

**Files:**
- Modify: `packages/shared/src/realtime.ts:171-185`（ProviderThreadView + `usedTokens?/windowTokens?/usageSource?`）
- Modify: `packages/api/src/services/session-service.ts:200-207`（从 threads 真值列供数）
- Modify: `components/stores/thread-store.ts:34` 附近（card 字段）+ `components/chat/status-panel.tsx:69-87`（**删自算窗口反推链**）+ `components/chat/right-panel/agent-list.tsx:155`（`fmtTokens(agent.usedTokens)` 直用真值；approx → 前缀"约"；无数据 → "无数据"）
- Test: `agent-list.test.tsx` 更新（:93/:101/:120 系）+ status-panel 测试

**验收锚**：面板 token 数 === 后端落库真值（不再 ratio×window 反推）；gemini 无快照 → "无数据"。

**Step**：前端组件失败测试 → shared 类型 + 后端供数 → 前端消费 → 全绿 → Commit。

## Task 10: 轮中实时更新（AC8）

**Files:**
- Modify: `packages/api/src/services/message-service.ts`（runTurn options 传 `onUsageSnapshot`：节流 ≥2s → emit）
- Modify: `packages/shared/src/realtime.ts`（事件类型 `usage.snapshot` payload {threadId, sessionGroupId, usedTokens, windowTokens, fillRatio, source}）
- Modify: `components/stores/thread-store.ts`（事件 → card 更新）
- Test: 节流单测（fake timers）+ store reducer 测试；活体验证走验收段录屏（AC8 验收标准本身允许 E2E 或活体）

**Step**：节流器失败测试 → 实现 → store 测试 → 接线 → Commit。

## Task 11: AC9 收尾清扫

**Files:** `context-seal.test.ts` / `claude-runtime.test.ts` / 其余 grep 命中面

**清单**（PLAN-SEED 决策 4 + Task 2/3/5 已覆盖部分的补漏）：
1. `grep -rn "cached_input_tokens" packages/` — 注释与实现全扫，确认无"input 是新增量"错误注释残留（codex-runtime.ts:222-224 旧注释必删）。
2. `claude-runtime.test.ts` 若有 result→usage 断言 → 翻正。
3. 回归重放测试定案：`cli-orchestrator-usage.test.ts` 的 fixture 重放（Task 4.1-1）即 AC1 验收"重放封存现场"的机械化版——若排查报告的 15 调用原始事件序列可从 `.runtime` 事件日志提取则补真现场 fixture，不可得则以探针 2 调用序列 + 断言注释回指排查报告数值（77,238 vs 989,369）为准。
4. `pnpm build && pnpm test` 全仓绿 + biome 点名文件 + tsc 0。

**Commit → 更新 feature doc AC 打勾 + Timeline。**

## Task 12: 收尾编排（不在本 plan 展开）

quality-gate → acceptance-guardian（AC 逐条复跑）→ requesting-review（真德彪，`-c model_provider=openai`）→ 小孙验收 → merge-gate（rebase 核倒灌——F040 大概率已合，message-service/status-panel 交集面重点 diff）。

---

## 风险与对策

| 风险 | 对策 |
|---|---|
| parseUsage 签名变更连锁编译错 | Task 2 一次迁完三 adapter 签名（codex/gemini 行为直译），语义修复分 Task 3/5——每 commit 全仓可编译 |
| result 晚于末次 message_start 的窗口升级时序 | Task 4 buildSnapshot 重建式设计 + 专项测试 4.1-3 |
| codex rollout 文件定位失败（日期翻天/路径变体） | 今昨两日目录优先 + 全量 walk 兜底 + null 降级路径测试；回读 try/catch 永不 fail turn |
| 双 migration 清单漏一半 | Task 7 测试同时开 sqlite.ts 与 drizzle-instance.ts 两路径建库断言列 |
| continuation-loop / dynamic-budget 等 fillRatio 下游行为变化 | usedTokens 变小是本 feature 的目的；下游只读 fillRatio 语义不变，Task 4.4 全仓测试兜底 |
| F040 合并冲突（message-service/status-panel） | 合并前 rebase + 交集面逐 hunk 核倒灌（F038 教训） |
