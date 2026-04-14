# F010 基线回绿 + P0 止血 Implementation Plan

**Feature:** F010 — `docs/features/F010-baseline-greenlight.md`
**Goal:** 让项目回到"能编译、能测试、不崩服务"的状态
**Acceptance Criteria:**
- AC-01: `session-repository.ts` 类型断裂修复
- AC-02: `logger.ts` 类型断裂修复（pino 类型声明）
- AC-03: `decision-manager.ts:118` verdict 类型从 string 收紧为联合类型
- AC-04: `uploads.ts:29` request.file() 类型声明补全
- AC-05: `embedding-service.ts:57` @huggingface/transformers 类型声明补全
- AC-06: `context-assembler.test.ts` 类型断裂修复
- AC-07: `approval-manager.test.ts` 类型断裂修复
- AC-08: `package.json` 补声明依赖 pino + @huggingface/transformers
- AC-09: `pnpm typecheck` 全绿（0 errors）
- AC-10: `phase1-header.ts` 补回"不要加载全文"约束
- AC-11: `approval-manager.test.ts:51` approval.resolved 测试对齐共享契约
- AC-12: `pnpm test` 全绿（493/493）
- AC-13: 所有 docs 中正文 `**Status**: xxx` 行删除
- AC-14: frontmatter status 值与实际状态对齐
- AC-15: `ws.ts:78` JSON.parse 加 try-catch（BUG-1）
- AC-16: `message-service.ts` 三处 void promise 加 .catch（BUG-2）
- AC-17: `cli-output-block.tsx:293-295` setState 移入 useEffect（BUG-3）
- AC-18: `execution-bar.tsx:38-40` getState() 改成 selector（BUG-4）
- AC-19: 全部完成后 `pnpm typecheck && pnpm test` 一次性通过
**Architecture:** 纯修复，无架构变更。修 7 处类型断裂、2 条红测、12 处文档双写、4 个 P0 bug。
**Tech Stack:** TypeScript, Node.js test runner, React, Zustand

---

## Task 1: 补声明依赖 (AC-08)

**Files:**
- Modify: `packages/api/package.json`

**Step 1: 添加缺失依赖到 package.json**

在 `packages/api/package.json` 的 `dependencies` 中添加：
```json
"pino": "^9.0.0",
"@huggingface/transformers": "^3.0.0"
```

**Step 2: 安装依赖**

Run: `pnpm install`
Expected: lockfile 更新，无报错

**Step 3: Commit**

```bash
git add packages/api/package.json pnpm-lock.yaml
git commit -m "fix(F010): declare missing deps pino + @huggingface/transformers (AC-08)"
```

---

## Task 2: 修复 typecheck 7 处断裂 (AC-01~07)

### Task 2a: session-repository.ts params 类型 (AC-01)

**Files:**
- Modify: `packages/api/src/db/repositories/session-repository.ts:418`

**Step 1: 修复 params 类型**

将 line 418 的 `unknown[]` 改为 `(string | number | null)[]`：
```typescript
const params: (string | number | null)[] = []
```

**Step 2: 跑 typecheck 确认该文件不再报错**

Run: `pnpm typecheck 2>&1 | grep session-repository`
Expected: 无输出（该文件不再有错）

### Task 2b: logger.ts pino 类型 (AC-02)

依赖 Task 1 安装 pino 后自动修复。验证：

Run: `pnpm typecheck 2>&1 | grep logger`
Expected: 无输出

### Task 2c: decision-manager.ts verdict 类型 (AC-03)

**Files:**
- Modify: `packages/api/src/orchestrator/decision-manager.ts:118`

**Step 1: 将 verdict 类型从 string 收紧**

```typescript
// Before:
decisions: Array<{optionId: string; verdict: string; modification?: string}>,

// After:
import type { OptionVerdict } from "@multi-agent/shared"
// ...
decisions: Array<{optionId: string; verdict: OptionVerdict; modification?: string}>,
```

检查文件顶部是否已有 `@multi-agent/shared` 的 import，如有则合并。

**Step 2: 验证**

Run: `pnpm typecheck 2>&1 | grep decision-manager`
Expected: 无输出

### Task 2d: uploads.ts request.file() 类型 (AC-04)

**Files:**
- Modify: `packages/api/src/routes/uploads.ts`

**Step 1: 添加 multipart 类型声明**

在文件顶部添加：
```typescript
import type { FastifyInstance } from "fastify"
import type { MultipartFile } from "@fastify/multipart"
```

并在 handler 中给 request 加类型断言，或直接声明 route 的 request 类型。最简方案：
```typescript
const file = await (request as unknown as { file(): Promise<MultipartFile | undefined> }).file()
```

或者更优方案——确认 `@fastify/multipart` 的类型扩展是否需要在 tsconfig 中配置。先检查 `@fastify/multipart` 是否提供了全局类型扩展。

**Step 2: 验证**

Run: `pnpm typecheck 2>&1 | grep uploads`
Expected: 无输出

### Task 2e: embedding-service.ts @huggingface/transformers 类型 (AC-05)

依赖 Task 1 安装 @huggingface/transformers 后自动修复。验证：

Run: `pnpm typecheck 2>&1 | grep embedding`
Expected: 无输出

### Task 2f: context-assembler.test.ts 类型 (AC-06)

**Files:**
- Modify: `packages/api/src/orchestrator/context-assembler.test.ts:57-58`

**Step 1: 补全 ContextMessage 必填字段**

```typescript
// Before:
roomSnapshot: [
  { agentId: "黄仁勋", role: "assistant", content: "我完成了实现" },
  { agentId: "范德彪", role: "assistant", content: "收到" },
],

// After:
roomSnapshot: [
  { id: "msg-1", agentId: "黄仁勋", role: "assistant" as const, content: "我完成了实现", createdAt: "2026-01-01T00:00:00Z" },
  { id: "msg-2", agentId: "范德彪", role: "assistant" as const, content: "收到", createdAt: "2026-01-01T00:00:01Z" },
],
```

**Step 2: 验证**

Run: `pnpm typecheck 2>&1 | grep context-assembler`
Expected: 无输出

### Task 2g: approval-manager.test.ts 类型 (AC-07)

此处的类型错误与 AC-11（测试断言滞后）是同一个问题。修复方式见 Task 3b。

### Task 2h: 全量 typecheck 验证 (AC-09)

Run: `pnpm typecheck`
Expected: 0 errors

**Commit:**
```bash
git add packages/api/src/
git commit -m "fix(F010): resolve all 7 typecheck failures (AC-01~09)"
```

---

## Task 3: 修复 2 条红测 (AC-10~12)

### Task 3a: phase1-header 补回约束 (AC-10)

**Files:**
- Modify: `packages/api/src/orchestrator/phase1-header.ts:19`

**Step 1: 在规则列表中补回"不要加载全文"**

在 line 19（`只回答本问题...` 之后）添加一条：
```typescript
"- 不要加载全文，只依据当前上下文和你已有的知识回答",
```

**Step 2: 跑测试确认通过**

Run: `pnpm --filter @multi-agent/api test -- --test-name-pattern "not loading full skill"`
Expected: PASS

### Task 3b: approval.resolved 测试对齐共享契约 (AC-11)

**Files:**
- Modify: `packages/api/src/orchestrator/approval-manager.test.ts:51-54`

**Step 1: 更新 deepEqual 断言，加入 sessionGroupId**

```typescript
// Before:
assert.deepEqual(emitted[1], {
  type: "approval.resolved",
  payload: { requestId: payload.requestId, granted: true },
})

// After:
assert.deepEqual(emitted[1], {
  type: "approval.resolved",
  payload: { sessionGroupId: "group-1", requestId: payload.requestId, granted: true },
})
```

**Step 2: 跑测试确认通过**

Run: `pnpm --filter @multi-agent/api test -- --test-name-pattern "requestPermission holds until respond"`
Expected: PASS

### Task 3c: 全量测试验证 (AC-12)

Run: `pnpm test`
Expected: 全绿（493/493 或更多）

**Commit:**
```bash
git add packages/api/src/orchestrator/
git commit -m "fix(F010): fix 2 red tests — phase1-header constraint + approval.resolved contract (AC-10~12)"
```

---

## Task 4: 文档状态单点化 (AC-13~14)

**Files:**
- Modify: 12 个文档文件（见下方列表）

**Step 1: 删除所有正文 `**Status**:` 行**

以下 12 个文件包含正文 Status 双写，删除对应行：

| 文件 | 删除的行 |
|------|---------|
| `docs/features/F001-ui-refresh.md` | `**Status**: done` |
| `docs/features/F002-decision-board.md` | `**Status**: spec` |
| `docs/features/F003-a2a-convergence.md` | `**Status**: done（...）` |
| `docs/features/F004-context-memory-authoritative.md` | `**Status**: done` |
| `docs/features/F005-runtime-governance-ui.md` | `**Status**: merged (...)` |
| `docs/features/F006-ui-ux-refinement-and-runtime-governance-v2.md` | `**Status**: completed` |
| `docs/features/F007-context-compression-optimization.md` | `**Status**: done` |
| `docs/features/F008-dev-infra-evidence-chain.md` | `**Status**: implemented` |
| `docs/features/F009-perf-optimization.md` | `**Status**: completed` |
| `docs/bugReport/B005-direct-turn-amnesia.md` | `**Status**: investigating（...）` |
| `docs/bugReport/B006-gemini-startup-429.md` | `**Status**: fixed（...）` |
| `docs/bugReport/B011-stall-kill-mid-retry.md` | `**Status**: fixed` |

**Step 2: 校正 frontmatter status 值 (AC-14)**

| 文件 | 当前 frontmatter | 修正为 | 原因 |
|------|-----------------|--------|------|
| `docs/bugReport/B005-direct-turn-amnesia.md` | `investigating` | `fixed` | 已有回归测试，代码已修复 |

其他文件 frontmatter status 经核实与实际状态一致，不需修改。

**Step 3: 验证无双写残留**

Run: `grep -rn '^\*\*Status\*\*:' docs/features/ docs/bugReport/ && echo "FAIL" || echo "PASS"`
Expected: PASS

**Commit:**
```bash
git add docs/
git commit -m "fix(F010): docs status single-source-of-truth — remove body-text Status, fix B005 frontmatter (AC-13~14)"
```

---

## Task 5: P0 Bug 修复 (AC-15~18)

### Task 5a: ws.ts JSON.parse 加 try-catch (AC-15)

**Files:**
- Modify: `packages/api/src/routes/ws.ts:77-79`

**Step 1: 包裹 try-catch**

```typescript
// Before:
socket.on("message", async (raw: Buffer) => {
  const event = JSON.parse(raw.toString()) as RealtimeClientEvent;
  log.debug({ type: event.type }, "client event received");

// After:
socket.on("message", async (raw: Buffer) => {
  let event: RealtimeClientEvent;
  try {
    event = JSON.parse(raw.toString()) as RealtimeClientEvent;
  } catch {
    log.warn({ raw: raw.toString().slice(0, 200) }, "invalid JSON from client");
    return;
  }
  log.debug({ type: event.type }, "client event received");
```

**Step 2: 验证 typecheck**

Run: `pnpm typecheck 2>&1 | grep ws.ts`
Expected: 无输出

### Task 5b: message-service.ts fire-and-forget 加 .catch (AC-16)

**Files:**
- Modify: `packages/api/src/services/message-service.ts` 三处

**Step 1: Line ~457 — handleSendMessage**

```typescript
// Before:
void this.handleSendMessage(event, emit)

// After:
void this.handleSendMessage(event, emit).catch(err =>
  this.log.error({ err }, "handleSendMessage background task failed")
)
```

**Step 2: Line ~1211 — runThreadTurn (A2A 回程)**

```typescript
// Before:
void this.runThreadTurn({

// After:
void this.runThreadTurn({
  ...（参数不变）
}).catch(err =>
  this.log.error({ err, threadId: returnPlan.parentThreadId }, "A2A return thread turn failed")
)
```

**Step 3: Line ~1789 — IIFE 循环内**

```typescript
// Before:
void (async () => {
  const turnResult = await this.runThreadTurn({
    ...
  })
  ...
})()

// After:
void (async () => {
  const turnResult = await this.runThreadTurn({
    ...
  })
  ...
})().catch(err =>
  this.log.error({ err, threadId: thread.id }, "parallel dispatch thread turn failed")
)
```

**Step 4: 验证 typecheck**

Run: `pnpm typecheck 2>&1 | grep message-service`
Expected: 无输出

### Task 5c: cli-output-block.tsx setState 移入 useEffect (AC-17)

**Files:**
- Modify: `components/chat/rich-blocks/cli-output-block.tsx:293-295`

**Step 1: 删除渲染体中的 setState，合并到已有 useEffect**

```typescript
// 删除 lines 293-295:
// if (isStreaming && !toolsExpanded) {
//   setToolsExpanded(true)
// }

// 修改 lines 286-291 的 useEffect，加入 streaming → expanded 逻辑:
useEffect(() => {
  if (isStreaming && !toolsExpanded && !toolsUserInteracted.current) {
    setToolsExpanded(true)
  }
  if (prevStatus.current === "streaming" && !isStreaming && !toolsUserInteracted.current) {
    setToolsExpanded(false)
  }
  prevStatus.current = status
}, [status, isStreaming, toolsExpanded])
```

**Step 2: 验证 typecheck**

Run: `pnpm typecheck 2>&1 | grep cli-output`
Expected: 无输出

### Task 5d: execution-bar.tsx getState() 改 selector (AC-18)

**Files:**
- Modify: `components/chat/execution-bar.tsx:31, 38-40`

**Step 1: 用 selector 替代 getState()**

```typescript
// Before (line 31):
const pendingCount = useApprovalStore((s) => s.pending.length)
// ...
// Before (lines 38-40):
const isWaiting = useApprovalStore.getState().pending.some(
  (r) => r.provider === provider,
)

// After: 提升 pending 到组件顶层
const pendingCount = useApprovalStore((s) => s.pending.length)
const pendingProviders = useApprovalStore((s) => s.pending.map(r => r.provider))
// ...
// 在 map 内部:
const isWaiting = pendingProviders.includes(provider)
```

**Step 2: 验证 typecheck**

Run: `pnpm typecheck 2>&1 | grep execution-bar`
Expected: 无输出

**Commit:**
```bash
git add packages/api/src/routes/ws.ts packages/api/src/services/message-service.ts components/
git commit -m "fix(F010): 4 P0 bugs — ws JSON.parse guard, fire-and-forget .catch, render setState, Zustand selector (AC-15~18)"
```

---

## Task 6: 全量门禁验证 (AC-19)

**Step 1: typecheck + test 一次性通过**

Run: `pnpm typecheck && pnpm test`
Expected: 0 typecheck errors + 全绿测试

**Step 2: 文档双写验证**

Run: `grep -rn '^\*\*Status\*\*:' docs/features/ docs/bugReport/ && echo "FAIL" || echo "PASS"`
Expected: PASS

---

## 总结

| Task | AC | 文件数 | 预估 |
|------|-----|--------|------|
| 1. 补依赖 | AC-08 | 1 | 5 min |
| 2. typecheck 修复 | AC-01~07, 09 | 5 | 30 min |
| 3. 红测修复 | AC-10~12 | 2 | 15 min |
| 4. 文档单点化 | AC-13~14 | 12 | 20 min |
| 5. P0 Bug | AC-15~18 | 4 | 30 min |
| 6. 门禁验证 | AC-19 | 0 | 5 min |
| **总计** | **19 AC** | **24 文件** | **~2 小时** |
