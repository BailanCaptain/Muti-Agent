# F026 Phase 3 — Context 改造（M5 保真 · cold-target burst 兜底）

**Feature:** F026 — `docs/features/F026-a2a-reliability-layer.md` (v2)
**Goal:** 让 mention 派发时下游 agent 收到的 prompt（① taskSnippet 任务载荷 + ② cold-target 上下文兜底）默认不失真、不黑盒；让 cold-target（被 @ 的 agent 没有 nativeSessionId、SessionBootstrap 也无料）场景下游不必先调 MCP 即可看懂主线（user-mention 与 A2A-mention 同等触发，本质是「下游冷启」而非「上游来源」）。
**Acceptance Criteria（覆盖 spec）:**
- M5（payload 完整性）全部子项：`buildReturnPathPayload` + `extractTaskSnippet` 拆分、`dispatch.ts:297/359` 分流、单条 contextSnapshot 同 cap、`A2A_PAYLOAD_MAX_TOKENS` env、fuzz、R-034 replay、DB 红线
- 场景 3（长对话召新 agent）：cold-target 时 burst + Tombstone 注入到 `assemblePrompt` content，下游不需主动调 MCP 即可看懂当前主线（user @ 与 agent @ 同等覆盖）
- 复用 Phase 1/2 已有：`truncateHeadTail`（context-snapshot.ts:80）/ `assemblePrompt` content 段拼装结构 / `buildSessionBootstrap`（不重写，仅在它无料时兜底）

**Architecture:**
- A 层（taskSnippet 保真）：`extractTaskSnippet` 保留作为 trigger_mention 短摘要专用（≤500 字语义不变）；新增 `buildReturnPathPayload(content, {maxTokens})` 走 token 预算 + `truncateHeadTail`（头 60% + 尾 30% + 省略标记）；`dispatch.ts` 派发场景按 `mode: "snippet" | "full"` 分流
- B 层（cold-target burst 兜底）：抄 clowder `context-transport.ts` 三个纯函数（`detectRecentBurst` / `protectSemanticChains` / `buildTombstone+formatTombstone`）适配 Multi-Agent message 形态；`assemblePrompt` 在 cold-target 触发条件命中时把 burst section 注入 content（位置在 `[A2A 协作请求]` header 之前、SessionBootstrap 之后）
- 触发判定（cold-target）：`nativeSessionId === null`（目标 agent 无 CLI resume）AND SessionBootstrap 内 threadMemory + previousDigest 都为空（真 cold start）→ 注入；任一不满足跳过（不重复轰炸）。**不限 source**：user @ 与 agent @ 同等触发——本质是"下游冷启"而非"上游来源"，user 在长对话里 @ 一个新 agent 与 A2A 派发到一个新 agent 面临的"看不懂主线"问题完全同构
- 失真与显式标注：超 cap 场景 `buildReturnPathPayload` 输出含 `[...省略 X 字 / 原文 DB msg_id=...]`；UI 展开按钮在 P5 落地（本 Phase 仅保 DB 红线 + msg_id 引用）

**Tech Stack:** TypeScript · node:test · zod · 复用 truncateHeadTail / assemblePrompt / buildSessionBootstrap
**Phase Dependencies:** P1+P2 已落（37 commit · API 测试绿 · ADR-004 guard 绿）
**Phase 下游:** P4（Registry DB 下沉）不依赖 P3 · P5（前端栏 + UI 展开）依赖 P3 的 Tombstone msg_id 字段

---

## Out of Scope（明确 · 防 scope 漂移）

- ❌ 重新激活并维护 `buildContextSnapshot` 的全部 40 条历史投喂（路径 ② 仍然只在 cold-target 触发时复活，不是无脑投喂）
- ❌ 删除 `buildContextSnapshot`（B 复用其作为骨架，C 选项已作废）
- ❌ 前端 [查看完整原文] 按钮 / 折叠群组 / 溯源胶囊（P5）
- ❌ Anchors / Evidence Recall / scrubToolPayloads（clowder F148 算法的剩余部分，先不抄；本 Phase 不依赖）
- ❌ rollingSummary 重写（F007 已落，本 Phase 仅消费）
- ❌ Tombstone 的 retrieval hint 调用 search_evidence（Multi-Agent 没这工具，hint 退化为「调 MCP get_room_context, msg_id=...」）
- ❌ 修改 `mention-router.ts` / `a2a-gateway.ts`（P1 已落，触发判定从它们传入的 envelope 元信息消费即可）
- ❌ ADR-004 红线：本 Phase 不向 `agent-prompts.ts` / `CLAUDE.md` / `GEMINI.md` 添加任何 A2A 协议字段；burst section 直接拼进 content 字符串

---

## Acceptance Criteria（Phase 3 · 客观可测）

### M5 子项（spec AC §M5 全覆盖）

- [ ] `extractTaskSnippet` 行为契约不变（保留 ≤500 字 / sentence boundary / fallback）；MCP `trigger_mention.taskSnippet` 字段仍走它
- [ ] 新增 `buildReturnPathPayload(content: string, opts: { maxTokens: number, dbMsgId?: string }) → { text, truncated, omittedChars }`；超 cap 时调 `truncateHeadTail` 并在省略标记里附 `msg_id=<dbMsgId>` 引用
- [ ] `dispatch.ts:297` 与 `dispatch.ts:359` 两处 `extractSnippet` 调用替换为 `buildReturnPathPayload(..., { maxTokens: env.A2A_PAYLOAD_MAX_TOKENS, dbMsgId })`；trigger_mention MCP 入口 `taskSnippet` 字段保留 `extractTaskSnippet` 短摘要不变
- [ ] `buildContextSnapshot` 单条 `content` 若超 cap 走 `truncateHeadTail`（防历史通路二次挤掉）—— 本 Phase 仍然在 cold-target 复活路径里被消费
- [ ] `A2A_PAYLOAD_MAX_TOKENS` 环境变量：默认 16384 · 允许范围 [4096, 65536] · 越界 fallback 到默认 + 启动日志告警 · runtime hot-reload（沿用 R-198 hot-reload 通道）
- [ ] fuzz 回归：4k / 16k / 32k 三档 × 段首有/无 `@<targetAlias>` × 有/无 sentence boundary × 中段含/不含 review finding 关键词 → 16k 档**所有 case** 中段 finding 不被砍
- [ ] R-034 replay：用 2026-04-24 范德彪 4195 字 review 原文（fixture 抓 `messages.id = 94ebd971...`）作为 dispatch 输入，断言下游 prompt content 包含全部三条 finding 关键句 + 验证命令字符串
- [ ] DB 永远完整保存原文（红线）：`buildReturnPathPayload` 不修改 `messages.content` 列；任何省略只发生在 prompt 字符串

### 场景 3 · cold-target burst 兜底（spec AC §场景 3）

- [ ] cold-target 触发判定：仅当 `input.nativeSessionId === null` AND `threadMemory==null && previousDigest==null` 两条同时成立才注入（**不看 sourceAlias**）；5 条 case 测试覆盖：user→cold ✅ / agent→cold ✅ / user→hot(nativeSession) ❌ / agent→hot(threadMemory) ❌ / user→hot(previousDigest) ❌
- [ ] burst 注入位置：在 `assemblePrompt` content 的 `[A2A 协作请求]` header **之前**、SessionBootstrap section **之后**；不影响系统 prompt
- [ ] burst section 形态：
  ```
  [Burst — 最近 N 条相关讨论]
  <每条：[role · alias · 时间] content>
  [/Burst]
  [Tombstone] 此前省略 X 条 · 时间窗 ... · 参与者 ... · 关键词 ... · 详情可调 MCP get_room_context [/Tombstone]
  ```
- [ ] 抄移 clowder 三函数到 `packages/api/src/orchestrator/burst-context.ts`：
  - `detectRecentBurst(messages, { burstSilenceGapMs: 15 * 60_000, minBurstMessages: 4, maxBurstMessages: 12 })`
  - `protectSemanticChains` (Q→A: user→assistant；tool_use→tool_result)
  - `buildTombstone` + `formatTombstone`（参与者用 alias，retrieval hint 改 `MCP get_room_context, msg_id=<head>~<tail>`）
- [ ] 长对话场景集成测试 ×2：(a) A2A path — 100 条消息 → 仁勋 A2A @ 桂芬 (cold) → 桂芬收到含 burst+tombstone；(b) user path — 同样 100 条 → user @ 桂芬 (cold) → 桂芬同样收到含 burst+tombstone。两条都断言不调 MCP 即可看懂主线
- [ ] burst section token 预算：burst+tombstone 合计硬顶 4k tokens（`A2A_BURST_MAX_TOKENS` env 默认 4096），超出时 burst 数量从 max=12 往 min=4 收

### ADR-004 红线（每 Phase 必查）

- [ ] `git diff HEAD@{P3-start} -- packages/api/src/runtime/agent-prompts.ts CLAUDE.md GEMINI.md AGENTS.md` 为空或仅删除
- [ ] `scripts/ci/check-adr-004-diff.sh` 在 P3 commit 后保持绿

---

## Straight-Line Check（A→B 不绕路）

1. **Pin finish line**：dispatch 一条 4195 字 review → 下游 prompt content 含全文 + cold-target 时下游不调 MCP 看懂主线（user/agent 两路都覆盖）+ DB 原文不动
2. **Terminal schema**：
   - `buildReturnPathPayload(content, opts) → { text, truncated, omittedChars }` ← 长期 API
   - `buildBurstContext(messages, opts) → { burstSection: string, tombstoneSection: string | null, tokensUsed }` ← 长期 API
   - `assemblePrompt` 增加可选入参 `coldTargetBurst?: { burstSection, tombstoneSection }`，注入位置固定
3. **每步过三问**：每个 Task 终态保留（不丢弃）+ 每步有可验证证据（测试）+ 去掉哪步会丢什么 AC 都明确

---

## Task 拆分

### Task 1 · `buildReturnPathPayload` 纯函数（A 层核心）

**Files:**
- Create: `packages/api/src/orchestrator/return-path-payload.ts`
- Test: `packages/api/src/orchestrator/return-path-payload.test.ts`

**Step 1: 写失败测试**
```typescript
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildReturnPathPayload } from "./return-path-payload"

describe("buildReturnPathPayload", () => {
  it("returns content as-is when within budget", () => {
    const r = buildReturnPathPayload("hello", { maxTokens: 16384 })
    assert.equal(r.text, "hello")
    assert.equal(r.truncated, false)
    assert.equal(r.omittedChars, 0)
  })

  it("truncates head+tail when over budget and embeds msg_id reference", () => {
    const long = "x".repeat(80_000)
    const r = buildReturnPathPayload(long, { maxTokens: 4096, dbMsgId: "abc123" })
    assert.equal(r.truncated, true)
    assert.ok(r.omittedChars > 0)
    assert.match(r.text, /msg_id=abc123/)
    assert.match(r.text, /省略\s*\d+/)
  })

  it("preserves both head and tail content (not just head)", () => {
    const head = "HEAD_MARKER_" + "a".repeat(20_000)
    const tail = "b".repeat(20_000) + "_TAIL_MARKER"
    const r = buildReturnPathPayload(head + tail, { maxTokens: 4096 })
    assert.match(r.text, /HEAD_MARKER_/)
    assert.match(r.text, /_TAIL_MARKER/)
  })
})
```

**Step 2: 跑测试确认失败** — `pnpm --filter @multi-agent/api test return-path-payload` → FAIL "Cannot find module"

**Step 3: 最小实现**
```typescript
import { truncateHeadTail } from "./context-snapshot"

const CHARS_PER_TOKEN = 4

export type BuildReturnPathPayloadOptions = {
  maxTokens: number
  dbMsgId?: string
}

export type BuildReturnPathPayloadResult = {
  text: string
  truncated: boolean
  omittedChars: number
}

export function buildReturnPathPayload(
  content: string,
  opts: BuildReturnPathPayloadOptions,
): BuildReturnPathPayloadResult {
  const maxChars = opts.maxTokens * CHARS_PER_TOKEN
  if (content.length <= maxChars) {
    return { text: content, truncated: false, omittedChars: 0 }
  }
  const truncated = truncateHeadTail(content, maxChars)
  // truncateHeadTail 已带 `...(省略 N 字)...` 标记；附 msg_id 引用
  const text = opts.dbMsgId
    ? truncated.replace(/(\(省略 \d+ 字\))/, `$1 [msg_id=${opts.dbMsgId}]`)
    : truncated
  return {
    text,
    truncated: true,
    omittedChars: content.length - maxChars,
  }
}
```

**Step 4: 跑测试确认通过** — PASS（3/3）

**Step 5: Commit**
```bash
git add packages/api/src/orchestrator/return-path-payload.ts packages/api/src/orchestrator/return-path-payload.test.ts
git commit -m "feat(F026-P3 Task1): buildReturnPathPayload — token 预算 + 头尾保留 + msg_id 引用 (M5)"
```

---

### Task 2 · `A2A_PAYLOAD_MAX_TOKENS` env 接入（A 层）

**Files:**
- Modify: `packages/api/src/runtime/env.ts`（或对等的 env 解析模块；P1 已建）
- Test: `packages/api/src/runtime/env.test.ts`（追加 case）

**Step 1: 写失败测试** —— env 越界 fallback + 启动告警 + hot-reload 监听
```typescript
it("A2A_PAYLOAD_MAX_TOKENS defaults to 16384 when unset", () => {
  delete process.env.A2A_PAYLOAD_MAX_TOKENS
  assert.equal(getA2APayloadMaxTokens(), 16384)
})
it("A2A_PAYLOAD_MAX_TOKENS clamps to default when out of [4096, 65536]", () => {
  process.env.A2A_PAYLOAD_MAX_TOKENS = "100"
  assert.equal(getA2APayloadMaxTokens(), 16384)
  process.env.A2A_PAYLOAD_MAX_TOKENS = "100000"
  assert.equal(getA2APayloadMaxTokens(), 16384)
})
it("A2A_PAYLOAD_MAX_TOKENS accepts 4096", () => {
  process.env.A2A_PAYLOAD_MAX_TOKENS = "4096"
  assert.equal(getA2APayloadMaxTokens(), 4096)
})
```

**Step 2-4: 标准 TDD 循环** — 加 `getA2APayloadMaxTokens()` 函数 + clamp 逻辑 + 启动告警

**Step 5: Commit** — `feat(F026-P3 Task2): A2A_PAYLOAD_MAX_TOKENS env (default 16k, clamp 4k-64k)`

---

### Task 3 · `dispatch.ts` 调用点分流（A 层）

**Files:**
- Modify: `packages/api/src/services/message-service.ts`（`extractSnippet` callsite at 588/715/1392/2581 — Phase 1 后已重命名走 dispatch 模块）
- Modify: `packages/api/src/orchestrator/dispatch.ts:297`（前向派发 / 重派）
- Modify: `packages/api/src/orchestrator/dispatch.ts:359`（worklist 续推 / on-behalf）
- Test: `packages/api/src/orchestrator/dispatch.snippet-mode.test.ts`（新建）

**Step 1: 写失败测试**
```typescript
it("dispatch.297 (forward) uses extractTaskSnippet (≤500 char)", () => { ... })
it("dispatch.359 (return-path) uses buildReturnPathPayload (16k token budget)", () => { ... })
it("MCP trigger_mention.taskSnippet still uses extractTaskSnippet for short summary", () => { ... })
```

**Step 2-4: 实现** —— `dispatch.ts:359` 改 `buildReturnPathPayload(content, { maxTokens: env, dbMsgId })`；`dispatch.ts:297` 保持 `extractTaskSnippet` 不变（前向派发的"任务一句话"语义没变）；MCP 路径独立保持

**Step 5: Commit** — `feat(F026-P3 Task3): dispatch.ts return-path 走 buildReturnPathPayload，前向派发 + MCP 短摘保留 extractTaskSnippet`

---

### Task 4 · `buildContextSnapshot` 单条 `truncateHeadTail` 防爆（A 层）

**Files:**
- Modify: `packages/api/src/orchestrator/context-snapshot.ts:55-68`（map 内单条 content 处理）
- Test: `packages/api/src/orchestrator/context-snapshot.test.ts`（追加 case）

**Step 1: 写失败测试** —— 单条 80k 字消息进 buildContextSnapshot → 输出该条 content ≤ cap × CHARS_PER_TOKEN

**Step 2-4: 实现** —— 在 map 函数里调 `truncateHeadTail(m.content, env.A2A_PAYLOAD_MAX_TOKENS * 4)`

**Step 5: Commit** — `feat(F026-P3 Task4): contextSnapshot 单条 content 同 cap 头尾保护 (M5 防二次截)`

---

### Task 5 · 抄 clowder burst 三函数（B 层算法）

**Files:**
- Create: `packages/api/src/orchestrator/burst-context.ts`
- Test: `packages/api/src/orchestrator/burst-context.test.ts`

**Step 1: 写失败测试**
```typescript
import { detectRecentBurst, buildTombstone, formatTombstone } from "./burst-context"

describe("detectRecentBurst", () => {
  it("returns all when below maxBurstMessages and no big gap", () => {
    const msgs = makeMsgs(5, /*gapMs*/ 60_000)
    const r = detectRecentBurst(msgs, { burstSilenceGapMs: 900_000, min: 4, max: 12 })
    assert.equal(r.burst.length, 5)
    assert.equal(r.omitted.length, 0)
  })
  it("cuts at silence gap >= 15min", () => {
    const msgs = [
      ...makeMsgs(50, 60_000),                 // 50 条紧密
      ...makeMsgsAt(8, baseTs + 60 * 60_000), // gap 1h, 8 条紧密
    ]
    const r = detectRecentBurst(msgs, { burstSilenceGapMs: 900_000, min: 4, max: 12 })
    assert.equal(r.burst.length, 8)
    assert.equal(r.omitted.length, 50)
  })
  it("protects Q→A boundary (user→assistant) — does not split", () => { ... })
  it("caps at maxBurstMessages even within burst", () => { ... })
})

describe("buildTombstone + formatTombstone", () => {
  it("returns null on empty omitted", () => { ... })
  it("includes participants by alias and msg_id range hint", () => {
    const t = buildTombstone(omittedMsgs, "R-013", { maxTombstoneKeywords: 5 })
    const s = formatTombstone(t!)
    assert.match(s, /MCP get_room_context/)
    assert.match(s, /msg_id=/)
  })
})
```

**Step 2-4: 实现** —— 移植 clowder `context-transport.ts:60-302` 三函数（`detectRecentBurst` / `protectSemanticChains` / `buildTombstone` / `formatTombstone`）到 `burst-context.ts`；类型从 `StoredMessage` 改 `ContextMessage` (复用 `context-snapshot.ts` 的类型)；`catId` 判定改 `role==="assistant"` + `agentId`；retrieval hint 改 `调 MCP get_room_context, msg_id=<head>~<tail>`

**Step 5: Commit** — `feat(F026-P3 Task5): burst-context 抄 clowder F148 三函数（detectRecentBurst + protectSemanticChains + tombstone）适配 Multi-Agent 消息形态`

---

### Task 6 · cold-target 触发判定 + assemblePrompt 集成（B 层接入）

**Files:**
- Modify: `packages/api/src/orchestrator/context-assembler.ts`（增加 `coldTargetBurst` 入参 + 注入逻辑）
- Test: `packages/api/src/orchestrator/context-assembler.cold-target.test.ts`（新建）

**Step 1: 写失败测试**
```typescript
describe("assemblePrompt cold-target burst injection", () => {
  it("does NOT inject burst when nativeSessionId is set (CLI resume case)", () => { ... })
  it("does NOT inject burst when SessionBootstrap has threadMemory", () => { ... })
  it("does NOT inject burst when SessionBootstrap has previousDigest", () => { ... })
  it("injects burst when target cold (nativeSession=null + bootstrap empty), source=A2A", async () => {
    const r = await assemblePrompt({
      ...baseInput,
      sourceAlias: "黄仁勋",
      nativeSessionId: null,
      threadMemory: null,
      previousDigest: null,
      coldTargetBurst: { burstSection: "[Burst]\n...\n[/Burst]", tombstoneSection: "[Tombstone] 此前省略 50 条 ... [/Tombstone]" },
    }, null)
    assert.match(r.content, /\[Burst\]/)
    assert.match(r.content, /\[Tombstone\]/)
    // 注入位置：SessionBootstrap 之后、[A2A 协作请求] 之前
    const burstIdx = r.content.indexOf("[Burst]")
    const headerIdx = r.content.indexOf("[A2A 协作请求")
    assert.ok(burstIdx < headerIdx, "burst must precede A2A header")
  })
  it("injects burst when target cold AND source=user (user-mention path equally covered)", async () => {
    const r = await assemblePrompt({
      ...baseInput,
      sourceAlias: "user",  // ← 关键：user 触发也注入
      nativeSessionId: null,
      threadMemory: null,
      previousDigest: null,
      coldTargetBurst: { burstSection: "[Burst]\n...\n[/Burst]", tombstoneSection: null },
    }, null)
    assert.match(r.content, /\[Burst\]/)
  })
})
```

**Step 2-4: 实现**
```typescript
// context-assembler.ts AssemblePromptInput 加：
//   coldTargetBurst?: { burstSection: string, tombstoneSection: string | null }
// 在 SessionBootstrap section push 之后、`[A2A 协作请求 from ...]` 之前插入：
if (input.coldTargetBurst) {
  contentSections.push(input.coldTargetBurst.burstSection)
  if (input.coldTargetBurst.tombstoneSection) {
    contentSections.push(input.coldTargetBurst.tombstoneSection)
  }
  contentSections.push("")
}
```

**Step 5: Commit** — `feat(F026-P3 Task6): assemblePrompt 接入 coldTargetBurst 注入位（SessionBootstrap 之后 / A2A header 之前 · user/agent 触发同等覆盖）`

---

### Task 7 · 触发点串联 — message-service.ts 派发侧组装 burst（B 层 wire）

**Files:**
- Modify: `packages/api/src/services/message-service.ts`（在调 `assemblePrompt` 前判定 cold-target 并组装 `coldTargetBurst`）
- Test: `packages/api/src/services/message-service.cold-target.test.ts`（新建 / 集成测试）

**Step 1: 写失败测试** —— 两条 fixture 都 100 条消息（前 88 gap 30min、后 12 gap 2min）：
- (a) A2A path：仁勋 A2A dispatch @ 桂芬（cold） → 断言 prompt 含 burst + tombstone
- (b) user path：user @ 桂芬（cold） → 断言同样含 burst + tombstone（验证 user-mention 路径同等覆盖）

**Step 2-4: 实现**
```typescript
// message-service.ts dispatch 路径前（user @ 与 A2A @ 共用同一段判定）：
const isColdTarget =
  nativeSessionId === null &&
  threadMemory == null &&
  previousDigest == null
// ← 不再看 sourceAlias：cold-target 由"下游状态"定义，与"上游来源"无关
let coldTargetBurst: AssemblePromptInput["coldTargetBurst"] | undefined
if (isColdTarget) {
  const allRoomMessages = await this.messages.findBySessionGroup(sessionGroupId)
  const ctxMsgs = buildContextSnapshot(allRoomMessages, threadMeta, {
    sessionGroupId, triggerMessageId, maxMessages: 200, // 给 burst 足够池子选
  })
  const { burst, omitted } = detectRecentBurst(ctxMsgs, BURST_CONFIG)
  const burstSection = formatBurstSection(burst, A2A_BURST_MAX_TOKENS)
  const tombstone = buildTombstone(omitted, threadTitle)
  coldTargetBurst = {
    burstSection,
    tombstoneSection: tombstone ? formatTombstone(tombstone) : null,
  }
}
return assemblePrompt({ ..., coldTargetBurst }, memoryService)
```

**Step 5: Commit** — `feat(F026-P3 Task7): message-service 派发侧 cold-target 判定 + burst 组装 (B AC 场景3 · user/agent 触发同等覆盖)`

---

### Task 8 · M5 fuzz harness + R-034 replay（A AC 验收）

**Files:**
- Create: `packages/api/src/__tests__/a2a-replay/M5-payload-fuzz.test.ts`
- Create: `packages/api/src/__tests__/a2a-replay/R-034-payload.test.ts`
- Create fixture: `packages/api/src/__tests__/a2a-replay/fixtures/R-034-vande-review-4195.txt`（从 prod DB `messages.id=94ebd971...` 抓全文）

**Step 1: 写失败测试** —— fuzz 矩阵 4k/16k/32k × 段首 @/不在 × sentence boundary × finding 关键词位置；R-034 replay 断言三条 finding + 验证命令完整

**Step 2-4: 实现** —— harness 跑 dispatch + 验证 prompt content；fuzz 用 property-based（zod fuzz）

**Step 5: Commit** — `test(F026-P3 Task8): M5 fuzz + R-034 4195 字 replay 必绿（A AC 完整验收）`

---

### Task 9 · cold-target 长对话集成测试（B AC 验收）

**Files:**
- Create: `packages/api/src/__tests__/a2a-replay/scenario-3-cold-target.test.ts`

**Step 1: 写失败测试** —— 100 条 fixture，跑两条端到端：
- (a) A2A path：仁勋 @ 冷桂芬 → prompt 含 burst + tombstone
- (b) user path：user @ 冷桂芬 → prompt 同样含 burst + tombstone

两条都断言不出现 "如需更早的上下文调 MCP" 之外的 MCP 必调指示。

**Step 2-4: 已在 Task 7 实现，本 Task 仅补 scenario-3 端到端测试（双路径）**

**Step 5: Commit** — `test(F026-P3 Task9): scenario 3 cold-target 100 轮长对话 burst+tombstone 集成绿（user/agent 双路径）`

---

### Task 10 · ADR-004 红线 + Phase 收尾

**Step 1:** 跑 `scripts/ci/check-adr-004-diff.sh` → 必绿
**Step 2:** 跑 `pnpm --filter @multi-agent/api test` 全量 → 必绿（≥ Phase 2 末态 1058 + 本 Phase 新增）
**Step 3:** 跑 `pnpm typecheck` → 必绿
**Step 4:** 同步 spec 的 Timeline 段落补 P3 完结条目（实施完成日期）
**Step 5: Commit** — `chore(F026-P3 收官): ADR-004 + 全量绿 + Timeline 同步`

---

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 复活 `buildContextSnapshot` 路径②触发回归（被废 F018 AC5.3/5.4 警觉） | 中 | 设计意图打架 | 触发条件两连 AND（nativeSession=null + bootstrap 空），不重新启用全场景 flat 历史投喂；AC 明确「F018 设计仍然有效，本 Phase 仅补 cold-target 兜底；user-mention 路径同等覆盖但同样受两连 AND 收紧」 |
| burst 算法移植后参数（gap=15min / min=4 / max=12）不适合 Multi-Agent 节奏 | 中 | 体感 | env 全部可调（`A2A_BURST_GAP_MS` / `A2A_BURST_MIN` / `A2A_BURST_MAX`）；Phase 5 调参实战验证 |
| 16k 默认 cap 撞 LLM "lost in the middle" | 低 | 质量 | spec Design Decision 已论证 16k 仍在强注意力区间；env 可调；后续做 4k/16k/64k 实测 |
| Tombstone retrieval hint 无 `search_evidence` 工具 | 低 | UX | 退化为 `MCP get_room_context, msg_id=...`；P5 前端 [查看完整原文] 替代 |
| `dispatch.ts` 两处分流命中错（前向 vs 回程语义判错） | 中 | M5 部分覆盖 | Task 3 单元测试明确两处场景；fuzz 跑 forward+return-path 双向 |

---

## Phase 完成定义（DoD）

- [ ] Task 1-9 全 commit 在 worktree `feat/F026-p0-a2a-stabilize`
- [ ] M5 AC 7 子项全绿 + 场景 3 AC 5 子项全绿
- [ ] ADR-004 guard 绿
- [ ] 全量 API 测试 + typecheck 绿
- [ ] spec Timeline 同步补 P3 完结条目
- [ ] **不合 dev**（按 feedback_feature_completion_before_merge：F026 整 feature 全 AC 完才合，Phase 级中间 commit 留 worktree）

