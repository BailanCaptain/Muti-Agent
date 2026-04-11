# F004 — 上下文记忆权威化 Implementation Plan

**Feature:** F004 — `docs/features/F004-context-memory-authoritative.md`
**Goal:** 让 direct-turn 和 A2A 走统一的历史权威源（API 从 SQLite 读真实消息注入 prompt），CLI --resume 降级为性能优化 bonus；顺手降低 Gemini seal 阈值并解耦摘要服务的 API key。
**Acceptance Criteria:** AC1 直接路径历史注入 / AC2 移除 self-history skip 陷阱 / AC3 扩大历史预算 / AC4 降清 session 激进度 / AC5 解耦摘要 API key / AC6 B005+B006 存档 / AC7 LL-005 / AC8 手动场景
**Architecture:** `assembleDirectTurnPrompt` 改签名接收 `roomSnapshot`，与 `assemblePrompt` 共用同一套注入逻辑；移除 `context-assembler.ts:111` 的 `nativeSessionId` guard；`POLICY_FULL` 放宽窗口预算；`failure-classifier.ts` unknown case 不清 session；`memory-service.ts` 摘要 key 优先 `MEMORY_SUMMARY_API_KEY`。
**Tech Stack:** TypeScript / node:test / SQLite (better-sqlite3) / pnpm workspace

---

## Straight-Line Check

**Pin finish line（B）**：
- `pnpm --filter @multi-agent/api test` 全绿
- 新增的失忆复现测试从红→绿
- 新增的 failure-classifier unknown case 测试从红→绿
- 新增的 memory-service key fallback 测试从红→绿
- 手动场景：新会话连续 10 轮 → 重启 API → 第 11 轮 agent 仍记得前面内容

**Terminal schema**（改动后的最终形态，不是中间脚手架）：

```ts
// context-assembler.ts — 统一 direct 和 A2A
export type AssembleDirectTurnInput = {
  provider: Provider
  threadId: string
  sessionGroupId: string
  nativeSessionId: string | null   // 只用于判断 resume bonus，不再作为 skip 依据
  task: string
  sourceAlias: "user"
  targetAlias: string
  roomSnapshot: readonly ContextMessage[]  // ← 新增，来自 captureSnapshot
  skillHint?: string | null
}
export async function assembleDirectTurnPrompt(
  input: AssembleDirectTurnInput,
  memoryService: MemoryService | null,
): Promise<AssemblePromptResult>  // ← 返回 {systemPrompt, content} 两段式

// context-assembler.ts:111 — shouldInjectSelfHistory
const shouldInjectSelfHistory = policy.injectSelfHistory  // 移除 && !nativeSessionId

// context-policy.ts — POLICY_FULL 放宽
sharedHistoryLimit: 30      // was 10
maxContentLength: 2000      // was 500
selfHistoryLimit: 15        // was 5

// failure-classifier.ts:132 — unknown case
case "unknown":
  return { ...rest, shouldClearSession: false }  // was true

// message-service.ts:904 — 空回清 session 加 exitCode 前置
const emptyExitedCleanly = !accumulatedContent.trim() &&
  result.exitCode === 0 &&
  result.nativeSessionId === thread.nativeSessionId
// 正常退出但空回：保留 session（只有 exitCode !== 0 的空回才清）
let effectiveSessionId = emptyExitedCleanly ? result.nativeSessionId : ...

// constants.ts — Gemini seal
gemini: { warn: 0.70, action: 0.80 }  // was 0.55 / 0.65

// memory-service.ts:131 — key fallback
const apiKey = process.env.MEMORY_SUMMARY_API_KEY
  || process.env.GEMINI_API_KEY
  || process.env.GOOGLE_API_KEY
  || ""
```

**每步过三问**：
- 每一步的产物在终态保留吗？→ Task 1-13 每一步都直接落在终态文件上，无脚手架
- 每步完成后能 demo/test 什么？→ 每个 Task 末尾跑一次目标测试确认 red→green
- 去掉这步，到 B 会少什么？→ Task 逐个对应 1~N 条 AC，删任一 = AC 不覆盖

**不做什么（out of scope）**：
- 不删 rolling summary（保留作压缩层）
- 不动 Codex / Claude 的 seal 阈值（它们本身合理）
- 不重写 failure-classifier（只改 unknown 一行）
- 不加 long-term facts / memory middleware（那是 F00X 后续）
- 不迁移到 LangGraph checkpointer（那是大改 C 方案，本 Feature 走 B 方案）
- 不动 MCP memory surface

## 并发切分（3 个子 agent）

| Group | Subagent | Task 范围 | 文件 | 依赖 |
|---|---|---|---|---|
| **A** | sub-A | Task 1 只写**失忆复现失败测试**（证明当前 DirectTurnPrompt 不含历史） | `packages/api/src/orchestrator/context-assembler.test.ts` | 无 |
| **B** | sub-B | Task 2-8 实现主路径（AC1+AC2+AC3） | context-assembler.ts, context-policy.ts, message-service.ts (L766-774) | 等 A 完成 |
| **C** | sub-C | Task 9-16 安全网路径（AC4+AC5） | failure-classifier.ts, message-service.ts (L904-907), constants.ts, memory-service.ts | 独立，可与 B 并行 |
| **D** | 黄仁勋本体 | Task 17-22 整合、手动验证、存档回填、review pipeline | ROADMAP, bugReport, lessons, PR | 等 B 和 C 完成 |

---

## Group A — 失忆复现失败测试（sub-A，2 min）

### Task 1: 写失忆复现失败测试

**Files:**
- Modify: `packages/api/src/orchestrator/context-assembler.test.ts`

**Step 1**: 在文件末尾追加失败测试：

```typescript
test("assembleDirectTurnPrompt injects room history into content (B005 regression)", async () => {
  const roomSnapshot: ContextMessage[] = [
    { id: "m1", role: "user", agentId: "user", content: "我们要做 F004 项目", createdAt: "2026-04-11T10:00:00Z" },
    { id: "m2", role: "assistant", agentId: "黄仁勋", content: "好的，先立项", createdAt: "2026-04-11T10:00:01Z" },
    { id: "m3", role: "user", agentId: "user", content: "记住要看 reference-code", createdAt: "2026-04-11T10:00:02Z" },
  ]
  const result = await assembleDirectTurnPrompt({
    provider: "claude",
    threadId: "t1",
    sessionGroupId: "sg1",
    nativeSessionId: "sess-abc",  // 故意传 id：新行为不应因此跳过历史
    task: "继续推进",
    sourceAlias: "user",
    targetAlias: "黄仁勋",
    roomSnapshot,
  }, null)

  // 失忆回归：content 必须包含真实历史片段
  assert.match(result.content, /F004/, "content must reference F004 from history")
  assert.match(result.content, /reference-code/, "content must reference reference-code from history")
  assert.match(result.content, /继续推进/, "content must include the current task")
})
```

**Step 2**: 跑测试确认失败

```bash
pnpm --filter @multi-agent/api test -- --test-name-pattern "B005 regression"
```

Expected: **FAIL** — 当前 `assembleDirectTurnPrompt` 签名不接受 `roomSnapshot`，也不返回 `{systemPrompt, content}`，TypeScript 或运行时会红。

**Step 3**: Commit（Group A 专用 worktree）

```bash
git add packages/api/src/orchestrator/context-assembler.test.ts
git commit -m "test(F004/AC1): red — direct turn must inject room history [黄仁勋/Opus-46 🐾]"
```

---

## Group B — 主路径实现（sub-B，约 20 min）

### Task 2: 重构 assembleDirectTurnPrompt 签名

**Files:**
- Modify: `packages/api/src/orchestrator/context-assembler.ts:155-177`

**Step 1**: 把 `AssembleDirectTurnInput` 类型和 `assembleDirectTurnPrompt` 函数重写为：

```typescript
export type AssembleDirectTurnInput = {
  provider: Provider
  threadId: string
  sessionGroupId: string
  nativeSessionId: string | null
  task: string
  sourceAlias: "user"
  targetAlias: string
  roomSnapshot: readonly ContextMessage[]
  skillHint?: string | null
}

export async function assembleDirectTurnPrompt(
  input: AssembleDirectTurnInput,
  memoryService: MemoryService | null,
): Promise<AssemblePromptResult> {
  // direct turn 复用 POLICY_FULL + assemblePrompt 核心逻辑
  return assemblePrompt({
    ...input,
    policy: POLICY_FULL,
    phase1HeaderText: undefined,
    preamble: undefined,
    visionGuardianMode: false,
  }, memoryService)
}
```

**Step 2**: 在文件顶部 import `POLICY_FULL`：

```typescript
import { POLICY_FULL, type ContextPolicy } from "./context-policy"
```

**Step 3**: 跑 Task 1 的测试确认仍然编译错（因为调用点还没改）

```bash
pnpm --filter @multi-agent/api test -- --test-name-pattern "B005 regression"
```

Expected: FAIL（类型错误或断言失败）

### Task 3: 移除 nativeSessionId skip 陷阱（AC2）

**Files:**
- Modify: `packages/api/src/orchestrator/context-assembler.ts:111`

**Step 1**: 修改

```typescript
// Before
const shouldInjectSelfHistory = policy.injectSelfHistory && !input.nativeSessionId

// After
const shouldInjectSelfHistory = policy.injectSelfHistory
```

**Step 2**: 跑全量 context-assembler.test.ts

```bash
pnpm --filter @multi-agent/api test packages/api/src/orchestrator/context-assembler.test.ts
```

Expected: 可能有原有 test 依赖跳过逻辑而失败 —— 这是**预期的**，改为断言"nativeSessionId 存在时也注入 self history"。

### Task 4: 放宽 POLICY_FULL 和 POLICY_INDEPENDENT（AC3）

**Files:**
- Modify: `packages/api/src/orchestrator/context-policy.ts:26-47`

**Step 1**: 修改

```typescript
export const POLICY_FULL: ContextPolicy = {
  injectRollingSummary: true,
  injectSelfHistory: true,
  injectSharedHistory: true,
  sharedHistoryLimit: 30,       // was 10
  selfHistoryLimit: 15,         // was 5
  maxContentLength: 2000,       // was 500
  phase1Header: false,
  injectPreamble: false,
}

export const POLICY_INDEPENDENT: ContextPolicy = {
  injectRollingSummary: true,
  injectSelfHistory: true,
  injectSharedHistory: false,
  sharedHistoryLimit: 0,
  selfHistoryLimit: 15,         // was 5
  maxContentLength: 2000,       // was 500
  phase1Header: true,
  injectPreamble: false,
}
```

**Step 2**: 跑 context-policy 相关的测试（如果有）和 context-assembler.test.ts

```bash
pnpm --filter @multi-agent/api test packages/api/src/orchestrator/
```

### Task 5: 改 message-service.ts 调用点（AC1 最后一刀）

**Files:**
- Modify: `packages/api/src/services/message-service.ts:766-774`

**Step 1**: 在调用点前捕获 roomSnapshot。注意 `message-service.ts` 其他地方（如 `runThreadTurn` 处理 A2A 时）已经有 `captureSnapshot` 的辅助方法 —— 查找并复用；如果没有合适的方法，新建：

```typescript
// message-service.ts:766-774 (runThreadTurn 内部)
const systemPrompt = options.systemPrompt
  ?? await (async () => {
    const roomSnapshot = this.captureSnapshot(thread.sessionGroupId, options.rootMessageId)
    const result = await assembleDirectTurnPrompt({
      provider: thread.provider,
      threadId: thread.id,
      sessionGroupId: thread.sessionGroupId,
      nativeSessionId: thread.nativeSessionId,
      task: options.content,
      sourceAlias: "user",
      targetAlias: thread.alias,
      roomSnapshot,
    }, this.memoryService)
    // ⚠️ 注意：direct turn 当前只用了 systemPrompt，content 仍是原 options.content
    // 这里需要把 result.content 覆盖到下游的 userMessage 里（见 Task 6）
    return result
  })()
```

**Step 2**: **这里有个关键语义变更**——direct turn 原本只返回 systemPrompt，下游的 `createRun(userMessage)` 接收的是**原始 options.content**。现在 `assembleDirectTurnPrompt` 返回 `{systemPrompt, content}` 两段式，`content` 里已经包含"历史 + skill hint + 当前任务"完整封装。必须把 `content` 作为 `userMessage` 传下去，否则历史注入白做了。

具体改动：

```typescript
// 把 systemPrompt 的取值改成 assembleResult 完整对象
let assembledPrompt: AssemblePromptResult | null = null
if (!options.systemPrompt) {
  const roomSnapshot = this.captureSnapshot(thread.sessionGroupId, options.rootMessageId)
  assembledPrompt = await assembleDirectTurnPrompt({
    provider: thread.provider,
    threadId: thread.id,
    sessionGroupId: thread.sessionGroupId,
    nativeSessionId: thread.nativeSessionId,
    task: options.content,
    sourceAlias: "user",
    targetAlias: thread.alias,
    roomSnapshot,
  }, this.memoryService)
}
const systemPrompt = options.systemPrompt ?? assembledPrompt!.systemPrompt

// createRun 接收 userMessage 的参数，默认是 options.content；
// 如果 direct turn 走的是新组装路径，用 assembledPrompt.content
const effectiveUserMessage = assembledPrompt?.content ?? options.content
```

然后把 `createRun(userMessage)` 的调用位置改成 `createRun(effectiveUserMessage)`，以及 `runContinuationLoop` 的 `initialUserMessage: effectiveUserMessage`。

**Step 3**: 跑 message-service 相关测试

```bash
pnpm --filter @multi-agent/api test packages/api/src/services/message-service
```

### Task 6: 跑 Task 1 失忆复现测试确认绿

```bash
pnpm --filter @multi-agent/api test -- --test-name-pattern "B005 regression"
```

Expected: **PASS** — content 包含 F004 / reference-code / 当前任务。

### Task 7: 跑 Group B 全量测试

```bash
pnpm --filter @multi-agent/api test
```

Expected: 全绿。如果有非 F004 相关的 test 失败（比如 `context-assembler.test.ts` 其他旧测试因为历史注入逻辑变化需要更新断言），按"最小改动更新断言"原则修，不重写。

### Task 8: Commit Group B

```bash
git add packages/api/src/orchestrator/context-assembler.ts \
        packages/api/src/orchestrator/context-policy.ts \
        packages/api/src/orchestrator/context-assembler.test.ts \
        packages/api/src/services/message-service.ts
git commit -m "feat(F004/AC1-3): direct turn 历史从 API 注入 + 移除 nativeSessionId skip 陷阱 + 放宽 POLICY_FULL 预算 [黄仁勋/Opus-46 🐾]"
```

---

## Group C — 安全网路径实现（sub-C，约 15 min，可与 B 并行）

### Task 9: 写 failure-classifier unknown case 新行为失败测试

**Files:**
- Modify: `packages/api/src/runtime/failure-classifier.test.ts`

**Step 1**: 追加

```typescript
test("unknown failures no longer clear session (F004/AC4)", () => {
  const result = classifyFailure("some random gibberish that matches nothing", "")
  assert.equal(result.class, "unknown")
  assert.equal(result.shouldClearSession, false, "unknown errors must preserve session — clearing on unknown throws away history")
  assert.equal(result.safeToRetry, true)
})
```

**Step 2**: 跑测试确认失败

```bash
pnpm --filter @multi-agent/api test -- --test-name-pattern "unknown failures no longer"
```

Expected: FAIL（当前 unknown case `shouldClearSession: true`）

### Task 10: 改 failure-classifier.ts unknown case

**Files:**
- Modify: `packages/api/src/runtime/failure-classifier.ts:132-138`

**Step 1**: 修改

```typescript
case "unknown":
  return {
    class: cls,
    shouldClearSession: false,  // was true — F004: unknown 不清 session 防失忆
    safeToRetry: true,
    userMessage: "这一轮出错了，可以直接重试（session 已保留，不会失忆）。"
  };
```

**Step 2**: 跑测试确认绿

```bash
pnpm --filter @multi-agent/api test packages/api/src/runtime/failure-classifier.test.ts
```

### Task 11: 改 message-service.ts 空回清 session 加 exitCode 前置

**Files:**
- Modify: `packages/api/src/services/message-service.ts:904-907`

**Step 1**: 修改

```typescript
// Before
let effectiveSessionId =
  !accumulatedContent.trim() && result.nativeSessionId === thread.nativeSessionId
    ? null
    : result.nativeSessionId

// After
// F004: 正常退出但空回（exitCode === 0）不清 session — CLI 吐空白不该失忆。
// 只有异常退出 + 空回 + session 未变才清（说明 CLI 真的崩了）。
const emptyAndAbnormal =
  !accumulatedContent.trim() &&
  result.exitCode !== null &&
  result.exitCode !== 0 &&
  result.nativeSessionId === thread.nativeSessionId
let effectiveSessionId = emptyAndAbnormal ? null : result.nativeSessionId
```

**Step 2**: 如果 message-service 有针对此逻辑的单测，更新；没有的话 skip。

### Task 12: 改 constants.ts Gemini seal 阈值

**Files:**
- Modify: `packages/shared/src/constants.ts:89-93`

**Step 1**: 修改

```typescript
export const SEAL_THRESHOLDS_BY_PROVIDER: Record<Provider, { warn: number; action: number }> = {
  gemini: { warn: 0.70, action: 0.80 },  // was 0.55 / 0.65 — F004: 1M 窗口过度激进
  codex: { warn: 0.75, action: 0.85 },
  claude: { warn: 0.80, action: 0.90 }
};
```

**Step 2**: 看 `context-seal.test.ts` 里是否有硬编码 0.65 / 0.55 的断言。如果有，更新到新值；如果是按 `SEAL_THRESHOLDS_BY_PROVIDER.gemini.action` 动态读的，无需改。

```bash
pnpm --filter @multi-agent/api test packages/api/src/runtime/context-seal.test.ts
```

### Task 13: 写 memory-service key fallback 失败测试

**Files:**
- Modify or Create: `packages/api/src/services/memory-service.test.ts`

**Step 1**: 追加测试（如果文件不存在则新建，最小骨架）：

```typescript
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"

describe("memory-service key fallback (F004/AC5)", () => {
  const originalMemoryKey = process.env.MEMORY_SUMMARY_API_KEY
  const originalGeminiKey = process.env.GEMINI_API_KEY

  beforeEach(() => {
    delete process.env.MEMORY_SUMMARY_API_KEY
    delete process.env.GEMINI_API_KEY
  })
  afterEach(() => {
    if (originalMemoryKey !== undefined) process.env.MEMORY_SUMMARY_API_KEY = originalMemoryKey
    else delete process.env.MEMORY_SUMMARY_API_KEY
    if (originalGeminiKey !== undefined) process.env.GEMINI_API_KEY = originalGeminiKey
    else delete process.env.GEMINI_API_KEY
  })

  it("prefers MEMORY_SUMMARY_API_KEY over GEMINI_API_KEY", () => {
    process.env.MEMORY_SUMMARY_API_KEY = "memory-key"
    process.env.GEMINI_API_KEY = "gemini-key"
    const key = resolveMemorySummaryApiKey()  // 新增 helper，见 Task 14
    assert.equal(key, "memory-key")
  })

  it("falls back to GEMINI_API_KEY when MEMORY_SUMMARY_API_KEY missing", () => {
    process.env.GEMINI_API_KEY = "gemini-key"
    const key = resolveMemorySummaryApiKey()
    assert.equal(key, "gemini-key")
  })
})
```

（注意：为了让测试能驱动实现，需要在 memory-service.ts export 一个 `resolveMemorySummaryApiKey()` 小 helper —— 见 Task 14。）

**Step 2**: 跑确认失败

```bash
pnpm --filter @multi-agent/api test -- --test-name-pattern "memory-service key fallback"
```

Expected: FAIL（helper 还没实现）

### Task 14: 改 memory-service.ts key fallback

**Files:**
- Modify: `packages/api/src/services/memory-service.ts:131`

**Step 1**: 抽 helper + 替换读取逻辑

```typescript
export function resolveMemorySummaryApiKey(): string {
  return process.env.MEMORY_SUMMARY_API_KEY
    || process.env.GEMINI_API_KEY
    || process.env.GOOGLE_API_KEY
    || ""
}

// callGeminiSummarizer 内部
private async callGeminiSummarizer(/* ... */) {
  const apiKey = resolveMemorySummaryApiKey()
  if (!apiKey) return extractive
  // ... 其余不变
}
```

**Step 2**: 跑测试确认绿

```bash
pnpm --filter @multi-agent/api test packages/api/src/services/memory-service
```

### Task 15: 更新 .env.example 注释（如果文件存在）

```bash
ls .env.example 2>&1
```

如果存在，追加：

```bash
# Rolling summary 服务的独立 API key（可选）
# 留空则 fallback 到 GEMINI_API_KEY。独立 key 可避免摘要服务和 Gemini CLI 抢同一个配额导致桂芬起手 429（B006）。
# MEMORY_SUMMARY_API_KEY=
```

如果 `.env.example` 不存在，skip（在 Group D 的整合 commit 里补一行到 F004 doc 里说明）。

### Task 16: 跑 Group C 全量测试 + Commit

```bash
pnpm --filter @multi-agent/api test
```

Expected: 全绿。

```bash
git add packages/api/src/runtime/failure-classifier.ts \
        packages/api/src/runtime/failure-classifier.test.ts \
        packages/api/src/services/message-service.ts \
        packages/shared/src/constants.ts \
        packages/api/src/services/memory-service.ts \
        packages/api/src/services/memory-service.test.ts
# (.env.example if applicable)
git commit -m "feat(F004/AC4-5): 降清 session 激进度 + 解耦 rolling-summary key [黄仁勋/Opus-46 🐾]"
```

---

## Group D — 整合、验收、存档（黄仁勋本体，约 20 min）

### Task 17: 合并 Group B 和 Group C 到主 worktree

**Step 1**: 在主 worktree 的 `feat/F004-context-memory-authoritative` 分支上，把 Group B 和 Group C 的 commit 合入（worktree 策略见下面"Worktree 编排"章节）。

**Step 2**: 跑全量测试 + lint

```bash
pnpm --filter @multi-agent/api test
pnpm --filter @multi-agent/api lint || pnpm lint
```

Expected: 全绿。

### Task 18: 手动场景验收（AC8）

**场景 1 — 长对话失忆测试**：
1. 启动 API + frontend
2. 新建会话，和黄仁勋对话 10+ 轮（任何话题，只要有连贯性）
3. 记下第 N 轮说过的某个具体内容（如"我喜欢紫色"）
4. `Ctrl+C` 重启 API
5. 继续对话："你还记得我喜欢什么颜色吗？"
6. **期望**：黄仁勋能答"紫色"

**场景 2 — 桂芬起手不崩**：
1. 确认 `GEMINI_API_KEY` 或 `MEMORY_SUMMARY_API_KEY` 可用
2. 新建会话，第一句直接 @ 桂芬
3. **期望**：桂芬正常回复，不报 RESOURCE_EXHAUSTED

**场景 3 — 触发 context seal 后不失忆**：
1. 人为把 Gemini seal 阈值临时调到 0.01（或让对话长到触发 seal）
2. 触发一次 seal 事件（`effectiveSessionId = null`）
3. 下一轮对话
4. **期望**：新 CLI session，但 prompt 里有历史注入，agent 仍能引用之前的内容

如果任一场景失败 → 回 Phase 1 重新诊断，**不**在 Phase 4 叠加 hack。

### Task 19: 回填 B005 / B006 五件套

**Files:**
- Modify: `docs/bugReport/B005-direct-turn-amnesia.md` 的五件套章节
- Modify: `docs/bugReport/B006-gemini-startup-429.md` 的五件套章节

补"复现步骤"（指向 Task 1/Task 13 的测试），"验证方式"（指向 Task 6/Task 18 的结果）。

### Task 20: 写 LL-005 lessons learned（AC7）

**Files:**
- Create: `docs/lessons/LL-005-session-clearance-requires-fallback-audit.md`

内容骨架：

```markdown
# LL-005 — 清 session 前必须审查兜底是否真的兜得住

## 事件

B002 修复时，黄仁勋把 Gemini 429 从 rate_limited 搬到 context_exhausted，
引入了一条清 nativeSessionId 的新路径。commit message 里自信地说：
> "handoff 通路 … 和 clowder-ai GeminiAgentService/SessionSealer 逐字对照
> 后确认同构 —— 清 nativeSessionId → 下一轮 gemini-runtime.ts 不加 --resume
> → wrapPromptWithInstructions 把 context-assembler 注入的 '## 本房间摘要'
> 传给新 CLI 进程。"

但没审查 rolling summary 的两个致命弱点：
1. 要 >10 条 user 消息才生成（冷启动空窗）
2. 是压缩文本，不含真实消息细节

结果：B002 fix 正确，但把"清 session"的代价放大了 —— 失忆概率直接上升。
小孙在 F004 立项时明确说：「超级超级超级大bug」「架构问题该整改就整改」。

## 教训

**任何"清状态"的修复必须配套审查"兜底路径是否真的能兜住"**：

- 不能只看 code 里有没有 fallback 分支存在
- 要看 fallback **在真实使用时段**能不能被命中（冷启动窗口、并发抢占、API key 耗尽）
- 要看 fallback **的信息密度**是否足以支撑原业务（压缩文本 vs 真实消息）
- 要看 fallback **的成功率**是否足够高（Gemini API 可能打挂）

## 怎么用

Review / 写 commit message / 做 debugging 时如果出现"清 X / 重置 Y / 回退到 Z"，
强制自问：
1. Z 在哪里来？冷启动有吗？
2. Z 的信息密度够吗？
3. Z 的 dependency 可靠吗？

答不出来 → 不能合入。

## 反例证据链

- commit `ca87c9d` — 引入 direct-turn 路径"只依赖 summary 兜底"的架构
- commit `74d64e0` — 在已经脆弱的基础上加清 session 路径
- F004 — 架构级整改
```

### Task 21: quality-gate → vision-guardian → requesting-review

走 skill chain：
1. `quality-gate` 自检
2. `vision-guardian` 独立验收（AC8 愿景对照）
3. `requesting-review` 发 review 请求给范德彪（Codex）

### Task 22: receiving-review → merge-gate → completion

1. 收 review 反馈 → `receiving-review` 处理
2. 放行 → `merge-gate` 开 PR → squash merge
3. 回 `feat-lifecycle` Completion 闭环：
   - 更新 F004 Status: done + Completed 日期
   - ROADMAP 活跃表 → 已完成表
   - 回填 B005/B006 status: resolved

---

## Worktree 编排

- **主 worktree** `feat/F004-context-memory-authoritative` —— 黄仁勋本体的工作空间，Group D 在这里整合
- **Group A worktree** `feat/F004-test-red` —— sub-A 只写失败测试
- **Group B worktree** `feat/F004-main-path` —— sub-B 实现主路径（基于 A 的 commit）
- **Group C worktree** `feat/F004-safety-net` —— sub-C 实现安全网（基于 dev）

整合顺序：
1. dev ← A
2. dev ← B（rebase on A）
3. dev ← C（rebase on latest）
4. 主 worktree 跑全量测试 + 手动验证
5. 主 worktree 开 PR

---

## AC 覆盖核对

| AC | 覆盖的 Task |
|---|---|
| AC1 直接路径历史注入 | Task 1, 2, 5, 6 |
| AC2 移除 self-history skip 陷阱 | Task 3 |
| AC3 扩大历史预算 | Task 4 |
| AC4 降清 session 激进度 | Task 9, 10, 11, 12 |
| AC5 解耦摘要 API key | Task 13, 14, 15 |
| AC6 B005/B006 存档 | Task 19（骨架已在 Phase 1 建好）|
| AC7 LL-005 | Task 20 |
| AC8 愿景验收 | Task 18 |

全部覆盖 ✓

---

## 风险点与回滚

| 风险 | 缓解 |
|---|---|
| `captureSnapshot` 签名可能和新调用点不兼容 | Task 5 Step 1 先查找现有方法签名，缺参数则新建 `captureDirectTurnSnapshot` |
| 历史注入导致 A2A prompt 膨胀超过 CLI 限制 | POLICY_FULL 的 30×2000 ≈ 30k tokens，远小于最小 200k 窗口 |
| 现有 context-assembler.test.ts 里的旧 test 依赖"skip self-history"被破坏 | Task 3 允许更新旧 test 断言（从"跳过"改成"总是注入"）|
| Gemini seal 阈值改动后遇到 MODEL_CAPACITY_EXHAUSTED 的回归 | 已对冲：failure-classifier 的 context_exhausted case 仍保留（只降频率，不去掉） |
| Group B 和 C 都改 message-service.ts 导致 merge conflict | 按文件**不同区段**切分：B 改 L766-774，C 改 L904-907，无重叠。整合时优先 rebase 不 merge |
