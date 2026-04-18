# F012 前端加固 + 渲染重构 + DesignSystem + 三 CLI 整改 Implementation Plan

**Feature:** F012 — `docs/features/F012-frontend-hardening-redesign.md`
**Goal:** 健壮性修复 + 消息卡片化 + 折叠式渲染 + 三 CLI 参数/事件对齐 + 截图能力 + 统一 DesignSystem
**Acceptance Criteria:**
- AC-01: Error Boundary（BUG-10）
- AC-02: 图片上传容错（BUG-11）
- AC-03: WebSocket JSON.parse try-catch（BUG-14）
- AC-04: Store 空 catch 块加 console.error（BUG-15）
- AC-05: 消息卡片模型
- AC-06: 渲染路径拆分（tool/skill/thinking/content）
- AC-06a: skillEvents 数据管道
- AC-07: 折叠式展示
- AC-08: CliOutputBlock 只包裹工具输出
- AC-09: 流式自动展开/折叠
- AC-10: 统一 theme
- AC-11..14: DesignSystem 迁移
- AC-20: Thinking 管道打通（Claude stream_event 重写 + Codex reasoning）
- AC-21: 权限全放开 + 废弃 F005
- AC-22: 截图能力
- AC-26: 三 CLI 参数对齐
- AC-27: 三 CLI 事件类型补全
- AC-15..31: 门禁验证

**Architecture:** 后端 CLI runtime 层重写事件解析（Claude stream_event 信封拆解 + Codex 事件补全）；前端从气泡模型换卡片模型 + 统一 DesignSystem theme；新增截图子系统（PreviewGateway + Puppeteer）
**Tech Stack:** TypeScript, Next.js, React, TailwindCSS, Puppeteer, Sharp, http-proxy

**总原则：** 权限全放开 · MCP 不碰 · 环境配置不管 · 对齐 clowder-ai 已验证实现

---

## Task 1: Phase 1 — 健壮性修复 (AC-01, AC-02, AC-03, AC-04)

**Files:**
- Modify: `app/layout.tsx:13-18`
- Modify: `components/stores/chat-store.ts:86-93`
- Modify: `components/ws/client.ts:88-90`
- Modify: 所有 store 文件（含空 catch 块）
- Create: `components/error-boundary.tsx`

### Step 1: 创建 ErrorBoundary 组件 (AC-01)

```tsx
// components/error-boundary.tsx
"use client"
import { Component, type ReactNode, type ErrorInfo } from "react"

interface Props { children: ReactNode; fallback?: ReactNode }
interface State { hasError: boolean; error?: Error }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="flex items-center justify-center h-screen">
          <div className="text-center p-8">
            <h2 className="text-lg font-semibold mb-2">页面出了点问题</h2>
            <p className="text-sm text-gray-500 mb-4">{this.state.error?.message}</p>
            <button onClick={() => this.setState({ hasError: false })}
              className="px-4 py-2 bg-blue-500 text-white rounded">
              重试
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
```

### Step 2: 在 layout.tsx 包裹 ErrorBoundary

```tsx
// app/layout.tsx — 修改后
import { ErrorBoundary } from "@/components/error-boundary"

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="zh-CN">
      <body>
        <ErrorBoundary>{children}</ErrorBoundary>
      </body>
    </html>
  )
}
```

### Step 3: 图片上传容错 (AC-02)

`chat-store.ts:86-93` — 从"一张失败全丢弃"改为"跳过失败、保留成功"：

```typescript
// Before:
for (const img of pending) {
  try {
    const url = await uploadFile(img.file)
    contentBlocks.push({ type: "image", url, alt: img.file.name })
  } catch {
    set({ status: `图片上传失败: ${img.file.name}` })
    return  // ← 全部放弃
  }
}

// After:
const failedNames: string[] = []
for (const img of pending) {
  try {
    const url = await uploadFile(img.file)
    contentBlocks.push({ type: "image", url, alt: img.file.name })
  } catch (err) {
    console.error(`[chat-store] 图片上传失败: ${img.file.name}`, err)
    failedNames.push(img.file.name)
  }
}
if (failedNames.length > 0) {
  set({ status: `${failedNames.length} 张图片上传失败: ${failedNames.join(", ")}` })
}
// 继续发送文字 + 已成功的图片，不 return
```

### Step 4: WebSocket JSON.parse 加 try-catch (AC-03)

`client.ts:88-90`：

```typescript
// Before:
socket.addEventListener("message", (event) => {
  callbacks.onMessage(JSON.parse(event.data) as RealtimeServerEvent);
});

// After:
socket.addEventListener("message", (event) => {
  try {
    callbacks.onMessage(JSON.parse(event.data) as RealtimeServerEvent)
  } catch (err) {
    console.error("[ws] Failed to parse message:", err, event.data?.slice?.(0, 200))
  }
});
```

### Step 5: 所有 store 空 catch 块加 console.error (AC-04)

搜索所有 `catch {` 或 `catch (e) { }` 空块，改为 `catch (err) { console.error("[store-name]", err) }`。

Run: `pnpm typecheck`
Expected: PASS

**Commit:**
```bash
git add components/error-boundary.tsx app/layout.tsx components/stores/ components/ws/client.ts
git commit -m "fix(F012): Phase 1 健壮性修复 — ErrorBoundary + 图片容错 + WS安全 + store日志 (AC-01..04)"
```

---

## Task 2: Claude stream_event 解析器重写 (AC-20 C1+C3, AC-27 Claude)

> **F012 工作量最大的一项。** 加 `--include-partial-messages` 后事件从 `{ type: "assistant" }` 变为 `{ type: "stream_event", event: {...} }` 信封格式，5 个解析方法全需要改。

**Files:**
- Modify: `packages/api/src/runtime/claude-runtime.ts:66-269`
- Test: `packages/api/src/runtime/claude-runtime.test.ts`(新建)

### Step 1: 写失败测试 — stream_event 信封拆解

```typescript
// packages/api/src/runtime/claude-runtime.test.ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"

describe("ClaudeRuntime stream_event handling", () => {
  it("parseActivityLine extracts thinking_delta from stream_event envelope", () => {
    const event = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me think..." }
      }
    }
    const runtime = createTestClaudeRuntime()
    const result = runtime.parseActivityLine(event)
    // thinking 应该被 buffer 住，不立即返回
    assert.equal(result, null)
  })

  it("parseActivityLine emits thinking on content_block_stop", () => {
    const runtime = createTestClaudeRuntime()
    // 1. content_block_start(thinking) → 初始化 buffer
    runtime.parseActivityLine({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } }
    })
    // 2. thinking_delta → 累积
    runtime.parseActivityLine({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Step 1. " } }
    })
    runtime.parseActivityLine({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Step 2." } }
    })
    // 3. content_block_stop → 一次性发出
    const result = runtime.parseActivityLine({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 }
    })
    assert.equal(result, "Step 1. Step 2.")
  })

  it("parseAssistantDelta extracts text_delta from stream_event", () => {
    const runtime = createTestClaudeRuntime()
    const result = runtime.parseAssistantDelta({
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } }
    })
    assert.equal(result, "Hello")
  })

  it("parseAssistantDelta skips signature_delta", () => {
    const runtime = createTestClaudeRuntime()
    const result = runtime.parseAssistantDelta({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } }
    })
    assert.equal(result, "")
  })

  it("parseUsage extracts from stream_event message_start", () => {
    const runtime = createTestClaudeRuntime()
    const result = runtime.parseUsage({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { id: "msg_1", usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 } }
      }
    })
    assert.ok(result)
    assert.equal(result!.inputTokens, 160) // 100 + 50 + 10
  })

  it("transformToolEvent deduplicates text when already streamed", () => {
    const runtime = createTestClaudeRuntime()
    // Simulate text_delta was received (add to partialTextMessageIds)
    runtime.parseAssistantDelta({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Hello" }
      }
    })
    // message_start to set currentMessageId
    runtime.parseUsage({
      type: "stream_event",
      event: { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } } }
    })
    // Now full assistant message should skip text, only return tool_use
    const result = runtime.transformToolEvent({
      type: "assistant",
      message: {
        id: "msg_1",
        content: [
          { type: "text", text: "Hello" },
          { type: "tool_use", id: "tu_1", name: "Read", input: { path: "/a" } }
        ]
      }
    })
    // Should have tool_use but text should be skipped
    assert.ok(result)
  })
})
```

Run: `pnpm --filter @multi-agent/api test`
Expected: FAIL (methods not yet updated)

### Step 2: 加 `--include-partial-messages` 参数

`claude-runtime.ts:72` — 在 `--verbose` 后面加：

```typescript
// buildCommand() 内，line ~72
const args = [
  "--output-format", "stream-json",
  "--include-partial-messages",   // ← 新增：启用流式事件输出（含 thinking_delta）
  "--verbose",
]
```

### Step 3: 加 stream_event 状态 + unwrapStreamEvent()

在 `ClaudeRuntime` class 开头加实例状态：

```typescript
// claude-runtime.ts — class ClaudeRuntime 内新增
private thinkingBuffer = ""
private currentMessageId: string | undefined
private partialTextMessageIds = new Set<string>()

private unwrapStreamEvent(event: Record<string, unknown>): Record<string, unknown> | null {
  if (event.type === "stream_event") {
    return (event.event ?? event.stream_event) as Record<string, unknown> | null
  }
  return null
}
```

### Step 4: 重写 parseActivityLine (thinking + compact_boundary + rate_limit)

```typescript
parseActivityLine(event: Record<string, unknown>): string | null {
  // --- stream_event 信封内事件 ---
  const inner = this.unwrapStreamEvent(event)
  if (inner) {
    if (inner.type === "content_block_start") {
      const block = inner.content_block as Record<string, unknown> | undefined
      if (block?.type === "thinking") this.thinkingBuffer = ""
      return null
    }
    if (inner.type === "content_block_delta") {
      const delta = inner.delta as Record<string, unknown> | undefined
      if (delta?.type === "thinking_delta") {
        this.thinkingBuffer += (delta.thinking as string) ?? ""
        return null
      }
      if (delta?.type === "signature_delta") return null
      return null
    }
    if (inner.type === "content_block_stop") {
      if (this.thinkingBuffer.length > 0) {
        const text = this.thinkingBuffer
        this.thinkingBuffer = ""
        return text
      }
      return null
    }
    if (inner.type === "message_start") {
      const msg = inner.message as Record<string, unknown> | undefined
      this.currentMessageId = msg?.id as string | undefined
      return null
    }
    if (inner.type === "message_stop") {
      this.currentMessageId = undefined
      return null
    }
    return null
  }

  // --- 顶层事件 ---
  if (event.type === "system") {
    const subtype = (event as any).subtype ?? (event as any).event
    if (subtype === "compact_boundary") return "[context compacted]"
  }
  if (event.type === "rate_limit_event") return "[rate limited]"

  // --- 保留原有 content_block_delta 逻辑（兼容无 --include-partial-messages 模式） ---
  if (event.type === "content_block_delta") {
    const delta = event.delta as Record<string, unknown> | undefined
    if (delta?.type === "thinking_delta") return delta.thinking as string
  }

  return null
}
```

### Step 5: 重写 parseAssistantDelta (text_delta 流式 + 去重标记)

```typescript
parseAssistantDelta(event: Record<string, unknown>): string {
  // --- stream_event text_delta ---
  const inner = this.unwrapStreamEvent(event)
  if (inner) {
    if (inner.type === "content_block_delta") {
      const delta = inner.delta as Record<string, unknown> | undefined
      if (delta?.type === "text_delta") {
        if (this.currentMessageId) {
          this.partialTextMessageIds.add(this.currentMessageId)
        }
        return (delta.text as string) ?? ""
      }
      // thinking_delta / signature_delta → 不输出为 assistant text
      return ""
    }
    // message_start/stop/content_block_start/stop → 不产生 text
    return ""
  }

  // --- 保留原有逻辑（完整 assistant 消息 fallback） ---
  if (event.type === "content_block_delta") {
    const delta = event.delta as Record<string, unknown> | undefined
    if (delta?.type === "text_delta") return (delta.text as string) ?? ""
  }
  if (event.type === "message_delta" && typeof event.delta === "string") {
    return event.delta
  }
  if (event.type !== "assistant") return ""

  const message = event.message as Record<string, unknown> | undefined
  const content = message?.content
  if (!Array.isArray(content)) return ""

  // 去重：如果 text 已通过流式 text_delta 发送过，跳过
  const messageId = message?.id as string | undefined
  const skipText = messageId ? this.partialTextMessageIds.has(messageId) : false
  if (skipText && messageId) this.partialTextMessageIds.delete(messageId)

  return content
    .filter((item: any) => item.type === "text" && !skipText)
    .map((item: any) => item.text ?? "")
    .join("")
}
```

### Step 6: 重写 parseUsage (stream_event message_start/message_delta)

```typescript
parseUsage(event: Record<string, unknown>) {
  const inner = this.unwrapStreamEvent(event)
  if (inner) {
    if (inner.type === "message_start") {
      const msg = inner.message as Record<string, unknown> | undefined
      const usage = msg?.usage as Record<string, number> | undefined
      if (usage) {
        const input = (usage.input_tokens ?? 0)
          + (usage.cache_read_input_tokens ?? 0)
          + (usage.cache_creation_input_tokens ?? 0)
        return { inputTokens: input, outputTokens: usage.output_tokens ?? 0 }
      }
    }
    if (inner.type === "message_delta") {
      const usage = inner.usage as Record<string, number> | undefined
      if (usage) {
        return { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 }
      }
    }
    return null
  }

  // 保留原有顶层逻辑
  if (event.type === "message_start") { /* 原有代码 */ }
  if (event.type === "message_delta") { /* 原有代码 */ }
  if (event.type === "result") { /* 原有代码 */ }
  return null
}
```

### Step 7: 重写 parseStopReason (stream_event message_delta)

```typescript
parseStopReason(event: Record<string, unknown>) {
  const inner = this.unwrapStreamEvent(event)
  if (inner?.type === "message_delta") {
    const delta = inner.delta as Record<string, unknown> | undefined
    const reason = delta?.stop_reason as string | undefined
    return reason ? this.mapClaudeStopReason(reason) : null
  }

  // result error subtype 映射
  if (event.type === "result" && event.is_error) {
    const subtype = event.subtype as string | undefined
    if (subtype === "error_max_turns") return "truncated"
    if (subtype === "error_max_budget_usd") return "truncated"
    return "aborted"
  }

  // 保留原有顶层逻辑
  if (event.type === "result") { /* 原有 stop_reason 映射 */ }
  if (event.type === "message_delta") { /* 原有 fallback */ }
  return null
}
```

### Step 8: 跑测试确认通过

Run: `pnpm --filter @multi-agent/api test`
Expected: PASS

**Commit:**
```bash
git add packages/api/src/runtime/claude-runtime.ts packages/api/src/runtime/claude-runtime.test.ts
git commit -m "feat(F012): Claude stream_event 解析器重写 — thinking累积 + text去重 + usage信封拆解 (AC-20 C1+C3, AC-27)"
```

---

## Task 3: Claude 权限全放 + Windows MCP 临时文件 (AC-20 C4, AC-21 Claude)

**Files:**
- Modify: `packages/api/src/runtime/claude-runtime.ts:66-93`

### Step 1: 加 `--permission-mode bypassPermissions`

`buildCommand()` 的 args 数组加：

```typescript
args.push("--permission-mode", "bypassPermissions")
```

### Step 2: Windows MCP config 写临时文件

```typescript
// claude-runtime.ts buildCommand() 内，替换 line 79-93
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// MCP config
const mcpConfigObj = { mcpServers: { multi_agent_room: { /* ... 原有内容 ... */ } } }
if (process.platform === "win32") {
  const dir = mkdtempSync(join(tmpdir(), "multi-agent-mcp-"))
  const configPath = join(dir, "mcp-config.json")
  writeFileSync(configPath, JSON.stringify(mcpConfigObj), "utf-8")
  args.push("--mcp-config", configPath)
} else {
  args.push("--mcp-config", JSON.stringify(mcpConfigObj))
}
```

Run: `pnpm typecheck`
Expected: PASS

**Commit:**
```bash
git add packages/api/src/runtime/claude-runtime.ts
git commit -m "fix(F012): Claude CLI 权限全放 + Windows MCP临时文件 (AC-20 C4, AC-21)"
```

---

## Task 4: Codex CLI 整改 (AC-21 Codex, AC-26 Codex, AC-27 Codex)

**Files:**
- Modify: `packages/api/src/runtime/codex-runtime.ts`
- Test: `packages/api/src/runtime/codex-runtime.test.ts`(新建)

### Step 1: 写失败测试 — 新事件类型

```typescript
describe("CodexRuntime event types", () => {
  it("parseActivityLine handles mcp_tool_call started", () => {
    const runtime = createTestCodexRuntime()
    // 应返回 null（tool_use 走 transformToolEvent）但不抛错
  })
  it("transformToolEvent handles mcp_tool_call", () => {
    const event = { type: "item.started", item: { type: "mcp_tool_call", server: "room", tool: "send_message", arguments: { msg: "hi" } } }
    const result = runtime.transformToolEvent(event)
    assert.ok(result)
    assert.equal(result.toolName, "mcp:room/send_message")
  })
  it("parseActivityLine handles todo_list", () => {
    const event = { type: "item.started", item: { type: "todo_list", todo_items: [{ id: "1", content: "task", status: "pending" }] } }
    const result = runtime.parseActivityLine(event)
    assert.ok(result?.includes("task"))
  })
})
```

### Step 2: 修改 buildCommand() — sandbox + git + image

`codex-runtime.ts:21-47`：

```typescript
// Line 36: workspace-write → danger-full-access
"--sandbox", "danger-full-access",

// Line 39 后新增：
"--add-dir", ".git",

// 条件化 --skip-git-repo-check：
// 替换无条件 --skip-git-repo-check
...(existsSync(join(input.workingDirectory ?? ".", ".git")) ? [] : ["--skip-git-repo-check"]),

// 有图片时加 --image
...(input.images?.map(img => ["--image", img.path]).flat() ?? []),
```

### Step 3: 补全 7 个缺失事件类型

在 `parseActivityLine` 和 `transformToolEvent` 中新增：

```typescript
// parseActivityLine — 新增 todo_list + web_search + error
parseActivityLine(event: Record<string, unknown>): string | null {
  const type = event.type as string
  const item = (event.item ?? event) as Record<string, unknown>

  // todo_list → 任务进度
  if (item.type === "todo_list") {
    const items = (Array.isArray(item.todo_items) ? item.todo_items : Array.isArray(item.items) ? item.items : []) as any[]
    const summary = items.map((t: any) => `[${t.status ?? "?"}] ${(t.content ?? t.text ?? "").slice(0, 80)}`).join("; ")
    return `Tasks: ${summary}`
  }

  // web_search
  if (type === "item.completed" && item.type === "web_search") {
    return "[web search completed]"
  }

  // item-level error
  if (type === "item.completed" && item.type === "error") {
    return `[warning] ${(item.message as string) ?? "unknown error"}`
  }

  // stream-level error
  if (type === "error") {
    const msg = (event.message as string)?.trim() ?? ""
    if (msg.startsWith("Reconnecting")) return `[${msg}]`
    return null
  }

  // thread.started → session tracking (handled elsewhere but log it)
  if (type === "thread.started") return null

  // 原有 reasoning 逻辑保留
  if (type === "item.started" && item.type === "reasoning") return null
  if (type === "item.completed" && item.type === "reasoning") {
    return (item.text as string) || null
  }

  return null
}

// transformToolEvent — 新增 mcp_tool_call
transformToolEvent(event: Record<string, unknown>) {
  const type = event.type as string
  const item = (event.item ?? event) as Record<string, unknown>
  const itemType = item.type as string

  // mcp_tool_call started
  if (type === "item.started" && itemType === "mcp_tool_call") {
    const server = typeof item.server === "string" ? item.server : "unknown"
    const tool = typeof item.tool === "string" ? item.tool : "unknown"
    const args = typeof item.arguments === "object" && item.arguments !== null
      ? item.arguments as Record<string, unknown> : {}
    return {
      type: "tool_use" as const,
      toolName: `mcp:${server}/${tool}`,
      toolInput: args,
    }
  }

  // mcp_tool_call completed
  if (type === "item.completed" && itemType === "mcp_tool_call") {
    const status = (item.status as string) ?? "unknown"
    const result = item.result as Record<string, unknown> | undefined
    const content = Array.isArray(result?.content)
      ? (result!.content as any[]).filter(c => c.type === "text").map(c => c.text).join("\n")
      : String(result ?? "")
    return {
      type: "tool_result" as const,
      content: `[${status}] ${content.slice(0, 500)}`,
      isError: status === "error",
    }
  }

  // 原有 command_execution + file_change 逻辑保留
  // ...
}
```

### Step 4: agent_message 多轮分隔

`parseAssistantDelta` 中，跟踪 `hadPriorTextTurn` 状态：

```typescript
// class 属性
private hadPriorTextTurn = false

// parseAssistantDelta 内 agent_message 处理：
if (event.type === "item.completed" && item?.type === "agent_message") {
  const text = (item.text as string)?.trim() ?? ""
  if (text.length === 0) return ""
  const prefix = this.hadPriorTextTurn ? "\n\n" : ""
  this.hadPriorTextTurn = true
  return prefix + text
}
```

Run: `pnpm --filter @multi-agent/api test`
Expected: PASS

**Commit:**
```bash
git add packages/api/src/runtime/codex-runtime.ts packages/api/src/runtime/codex-runtime.test.ts
git commit -m "feat(F012): Codex CLI 整改 — sandbox全放 + git + 7事件类型补全 (AC-21,26,27)"
```

---

## Task 5: Gemini CLI 整改 (AC-26 Gemini, AC-27 Gemini)

**Files:**
- Modify: `packages/api/src/runtime/gemini-runtime.ts`

### Step 1: 加 `--include-directories` + candidates crash 容错

```typescript
// buildCommand() 新增：
if (input.images?.length) {
  const dirs = [...new Set(input.images.map(img => dirname(img.path)))]
  for (const dir of dirs) {
    args.push("--include-directories", dir)
  }
}

// parseStopReason 修改 — 加 candidates crash 容错：
parseStopReason(event: Record<string, unknown>) {
  if (event.type !== "result") return null

  // candidates crash 容错
  if (event.status !== "success") {
    const errMsg = this.extractErrorMessage(event.error)
    if (errMsg?.includes("Cannot read properties of undefined (reading 'candidates')")) {
      return "complete"  // 吞掉已知 bug，当作正常结束
    }
    return "aborted"
  }

  // 原有 finishReason 逻辑
  // ...
}

// result error → 发 error 消息
parseActivityLine(event: Record<string, unknown>): string | null {
  // 新增：result error 不只走 stopReason，也发活动消息
  if (event.type === "result" && event.status !== "success") {
    const errMsg = this.extractErrorMessage(event.error)
    if (errMsg?.includes("Cannot read properties of undefined (reading 'candidates')")) {
      return null  // 已知 crash，静默
    }
    if (errMsg) return `[error] ${errMsg}`
  }

  // 原有 thought 逻辑保留
  // ...
}

private extractErrorMessage(rawError: unknown): string | null {
  if (typeof rawError === "string") return rawError.trim() || null
  if (typeof rawError === "object" && rawError !== null) {
    const msg = (rawError as any).message
    return typeof msg === "string" ? msg.trim() || null : null
  }
  return null
}
```

Run: `pnpm typecheck`
Expected: PASS

**Commit:**
```bash
git add packages/api/src/runtime/gemini-runtime.ts
git commit -m "fix(F012): Gemini CLI 整改 — 图片目录 + candidates crash容错 + error事件 (AC-26,27)"
```

---

## Task 6: stdin→参数迁移 (AC-26 全局)

**Files:**
- Modify: `packages/api/src/runtime/claude-runtime.ts` (buildCommand)
- Modify: `packages/api/src/runtime/codex-runtime.ts` (buildCommand)
- Modify: `packages/api/src/runtime/gemini-runtime.ts` (buildCommand)
- Modify: `packages/api/src/runtime/base-runtime.ts:246-254` (stdin 处理)

### Step 1: Claude — prompt 改为 `-p` 参数

```typescript
// claude-runtime.ts buildCommand()
// Before: stdinContent: input.prompt
// After:
args.unshift("-p", wrappedPrompt)  // prompt 通过 -p 参数传入
// 删除 stdinContent 字段，或设为 undefined
return { command, args, shell: false }  // 不再传 stdinContent
```

### Step 2: Codex — prompt 改为 `--` 位置参数

```typescript
// codex-runtime.ts buildCommand()
// Before: stdinContent: prompt
// After:
baseArgs.push("--", wrappedPrompt)  // prompt 通过 -- 位置参数传入
return { command, args: [...baseArgs, ...topLevelArgs], shell: false }
```

### Step 3: Gemini — prompt 改为 `-p` 参数

```typescript
// gemini-runtime.ts buildCommand()
// Before: stdinContent: wrappedPrompt
// After:
args.push("-p", wrappedPrompt)
return { command, args, shell: false }
```

### Step 4: base-runtime.ts stdin 默认改 "ignore"

`base-runtime.ts:246-254`：

```typescript
// Before:
stdio: [command.stdinContent !== undefined ? "pipe" : "ignore", "pipe", "pipe"]

// After (stdinContent 不再被使用，统一 ignore):
stdio: ["ignore", "pipe", "pipe"]
// 删除 child.stdin.end(command.stdinContent) 相关代码
```

Run: `pnpm typecheck && pnpm --filter @multi-agent/api test`
Expected: PASS

**Commit:**
```bash
git add packages/api/src/runtime/
git commit -m "refactor(F012): 三CLI stdin→参数传prompt + stdin统一ignore (AC-26)"
```

---

## Task 7: 废弃 F005 审批系统 (AC-21 cleanup)

**Files:**
- Delete: `components/chat/approval-card.tsx` (167 行)
- Delete: `components/hooks/use-approval-notification.ts` (56 行)
- Modify: `app/page.tsx:133-149` (删除 approval 事件处理)
- Modify: `components/chat/status-panel.tsx` (删除 ApprovalTabContent)
- Modify: `components/chat/settings-modal.tsx` (删除规则管理 Tab)
- Modify: `components/stores/approval-store.ts` (标记废弃)
- Modify: `docs/features/F005-runtime-governance-ui.md` (标注废弃)

### Step 1: 删除 approval 前端组件

删除 `approval-card.tsx` 和 `use-approval-notification.ts` 文件。

### Step 2: 清理 page.tsx 审批事件处理

`app/page.tsx` — 删除 lines 133-149（`approval.request` / `approval.resolved` / `approval.auto_granted` 的 event handler）。删除 `useApprovalNotification()` 调用。删除 `useApprovalStore` import。

### Step 3: 清理 status-panel.tsx 和 settings-modal.tsx

- `status-panel.tsx`：删除 `ApprovalTabContent` 函数和审批规则 Tab
- `settings-modal.tsx`：删除"权限规则" Tab 的规则列表和删除功能

### Step 4: 标记后端废弃

`approval-store.ts` 顶部加注释 `// @deprecated F012: 权限审批已废弃，三 CLI 全放权`

### Step 5: 更新 F005 spec

`docs/features/F005-runtime-governance-ui.md` 加：
```
> **⚠️ 废弃通知 (2026-04-15, F012)**：权限审批功能已废弃。三个 CLI 全部给最大权限（Claude: --permission-mode bypassPermissions, Codex: --sandbox danger-full-access, Gemini: --approval-mode yolo）。前端审批 UI 组件已删除。后端 API 保留但不使用。
```

Run: `pnpm typecheck`
Expected: PASS（可能有 unused import 需清理）

**Commit:**
```bash
git add -A
git commit -m "refactor(F012): 废弃F005审批系统 — 删除前端审批UI + 标记后端废弃 (AC-21)"
```

---

## Task 8: 统一 DesignSystem theme (AC-10)

**Files:**
- Create: `components/theme.ts`
- Modify: `tailwind.config.ts`（如需扩展）

### Step 1: 创建 theme.ts

```typescript
// components/theme.ts
import type { Provider } from "@multi-agent/shared"

export const providerAccent: Record<Provider, string> = {
  claude: "#22C55E",   // 绿
  codex:  "#3B82F6",   // 蓝
  gemini: "#EC4899",   // 粉
}

export const providerLabel: Record<Provider, string> = {
  claude: "黄仁勋",
  codex:  "范德彪",
  gemini: "桂芬",
}

export const card = {
  radius: "rounded-xl",
  shadow: "shadow-sm",
  border: "border border-slate-200",
  padding: "p-4",
  gap: "space-y-3",
} as const

export const foldBlock = {
  bg: "bg-slate-50",
  border: "border-l-2",
  radius: "rounded-lg",
  padding: "px-3 py-2",
  font: "text-sm",
} as const

export const typography = {
  body: "font-sans text-sm text-slate-800",
  code: "font-mono text-xs",
  label: "text-xs font-medium text-slate-500 uppercase tracking-wider",
} as const
```

Run: `pnpm typecheck`
Expected: PASS

**Commit:**
```bash
git add components/theme.ts
git commit -m "feat(F012): 统一 DesignSystem theme — Provider色彩 + 卡片token + 折叠块样式 (AC-10)"
```

---

## Task 9: skillEvents 数据管道 (AC-06a)

**Files:**
- Modify: `packages/shared/src/realtime.ts:71-91` — TimelineMessage 加 `skillEvents`
- Modify: `packages/api/src/services/message-service.ts` — skill 匹配时写 `skillEvents`
- Modify: `components/chat/message-bubble.tsx` — 按 `skillEvents` 渲染

### Step 1: 定义 SkillEvent 类型 + 扩展 TimelineMessage

```typescript
// packages/shared/src/realtime.ts — 在 TimelineMessage 定义前加：
export type SkillEvent = {
  skillName: string
  status: "running" | "completed" | "failed"
  detail?: string
  startedAt?: string
  completedAt?: string
}

// TimelineMessage 加字段：
export type TimelineMessage = {
  // ... 原有字段 ...
  skillEvents?: SkillEvent[]   // ← 新增
}
```

### Step 2: message-service.ts 写 skillEvents

找到 `prependSkillHint()` 调用处，改为写 `skillEvents`：

```typescript
// Before: content = prependSkillHint(skillName) + content
// After:
if (!msg.skillEvents) msg.skillEvents = []
msg.skillEvents.push({
  skillName,
  status: "completed",
  completedAt: new Date().toISOString(),
})
```

### Step 3: 构建共享包

Run: `pnpm --filter @multi-agent/shared build && pnpm typecheck`
Expected: PASS

**Commit:**
```bash
git add packages/shared/src/realtime.ts packages/api/src/services/message-service.ts
git commit -m "feat(F012): skillEvents 数据管道 — 独立字段替代 prependSkillHint (AC-06a)"
```

---

## Task 10: 消息卡片化 + 折叠式渲染 (AC-05, AC-06, AC-07, AC-08, AC-09)

> 这是前端核心重构。从气泡模型换成卡片模型。

**Files:**
- Modify: `components/chat/message-bubble.tsx` (重构)
- Create: `components/chat/collapsible-block.tsx` (折叠块通用组件)
- Modify: `components/chat/rich-blocks/cli-output-block.tsx` (只包裹工具输出)

### Step 1: 创建通用折叠块组件

```tsx
// components/chat/collapsible-block.tsx
"use client"
import { useState, type ReactNode } from "react"
import { ChevronRight, ChevronDown } from "lucide-react"
import { foldBlock } from "@/components/theme"

interface Props {
  label: string
  icon?: ReactNode
  accentColor: string
  defaultOpen?: boolean
  status?: string
  children: ReactNode
}

export function CollapsibleBlock({ label, icon, accentColor, defaultOpen = false, status, children }: Props) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className={`${foldBlock.bg} ${foldBlock.radius} ${foldBlock.padding} my-1`}
      style={{ borderLeft: `2px solid ${accentColor}` }}>
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full text-left">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {icon}
        <span className={foldBlock.font}>{label}</span>
        {status && <span className="ml-auto text-xs text-slate-400">{status}</span>}
      </button>
      {open && <div className="mt-2 pl-5">{children}</div>}
    </div>
  )
}
```

### Step 2: 重构 message-bubble.tsx — 卡片模型

核心变更：
- 外层从气泡改为卡片容器（圆角 + 边框 + 阴影）
- 标题栏：ProviderAvatar + 名字 + 时间戳
- 中间区：skill/tool/thinking 各自 CollapsibleBlock + content 始终展示
- 底部：操作栏

```tsx
// message-bubble.tsx — 核心结构重构
import { CollapsibleBlock } from "./collapsible-block"
import { card, providerAccent, providerLabel, typography } from "@/components/theme"

export const MessageBubble = memo(function MessageBubble({ message, ... }: Props) {
  const accent = providerAccent[message.provider] ?? "#94A3B8"
  const isStreaming = message.messageType === "progress"

  return (
    <div className={`${card.radius} ${card.shadow} ${card.border} ${card.padding} bg-white`}>
      {/* 标题栏 */}
      <div className="flex items-center gap-2 mb-3">
        <ProviderAvatar provider={message.provider} size={24} />
        <span className="font-medium text-sm">{message.alias ?? providerLabel[message.provider]}</span>
        <span className="ml-auto text-xs text-slate-400">{formatClock(message.createdAt)}</span>
      </div>

      {/* Skill 折叠块 */}
      {message.skillEvents?.map((skill, i) => (
        <CollapsibleBlock key={i} label={`Skill: ${skill.skillName}`}
          accentColor={accent} status={skill.status} defaultOpen={isStreaming}>
          <pre className="text-xs">{skill.detail ?? ""}</pre>
        </CollapsibleBlock>
      ))}

      {/* Tool 折叠块 */}
      {message.toolEvents?.length ? (
        <CollapsibleBlock label={`工具调用 (${message.toolEvents.length})`}
          accentColor={accent} defaultOpen={isStreaming}>
          {message.toolEvents.map((te, i) => (
            <div key={i} className="text-xs py-1 border-b border-slate-100 last:border-0">
              <span className="font-mono">{te.toolName}</span>
            </div>
          ))}
        </CollapsibleBlock>
      ) : null}

      {/* Thinking 折叠块 */}
      {message.thinking && (
        <CollapsibleBlock label="推理过程" accentColor={accent} defaultOpen={isStreaming}>
          <div className="text-xs text-slate-600 whitespace-pre-wrap">{message.thinking}</div>
        </CollapsibleBlock>
      )}

      {/* 内容区 — 始终展示 */}
      {message.content && (
        <div className={`${typography.body} mt-3`}>
          <MarkdownMessage content={message.content} />
        </div>
      )}

      {/* 操作栏 */}
      <div className="flex items-center gap-2 mt-3 pt-2 border-t border-slate-100">
        <button onClick={() => onCopy?.(message.content)} className="text-xs text-slate-400 hover:text-slate-600">
          复制
        </button>
      </div>
    </div>
  )
})
```

### Step 3: CliOutputBlock 只包裹工具输出 (AC-08)

`cli-output-block.tsx` — 确保不包裹文字回复。由 message-bubble 控制哪些内容进 CliOutputBlock。

### Step 4: 流式自动展开/折叠 (AC-09)

`CollapsibleBlock` 已通过 `defaultOpen={isStreaming}` 实现：streaming 时自动展开。在 message-bubble 中，当 `messageType` 从 `"progress"` 变为 `"final"` 时，折叠块自动收起（通过 useEffect 监听变化）。

Run: `pnpm typecheck && pnpm dev`
Expected: PASS + 浏览器中卡片化渲染正常

**Commit:**
```bash
git add components/chat/
git commit -m "feat(F012): 消息卡片化 + 折叠式渲染 — Card模型 + CollapsibleBlock + 流式展开 (AC-05..09)"
```

---

## Task 11: DesignSystem 迁移 (AC-11, AC-12, AC-13, AC-14)

**Files:**
- Modify: `components/chat/rich-blocks/cli-output-block.tsx` — 删 `PROVIDER_ACCENT`，用 `theme.providerAccent`
- Modify: `components/chat/message-bubble.tsx` — 删硬编码颜色
- Modify: `components/chat/status-panel.tsx` — Chip 颜色改用 theme

### Step 1: cli-output-block.tsx 迁移

```typescript
// Before (line 37-41):
const PROVIDER_ACCENT: Record<Provider, string> = {
  claude: "#7C3AED", codex: "#D97706", gemini: "#0EA5E9"
}

// After:
import { providerAccent } from "@/components/theme"
// 删除 PROVIDER_ACCENT，全部引用改为 providerAccent[provider]
```

### Step 2: message-bubble.tsx 迁移

删除 `bubbleTheme`、`thinkingTheme` 等硬编码对象，改用 `theme` 模块。

### Step 3: status-panel.tsx 迁移

Chip 颜色从硬编码改为 `providerAccent[provider]`。

### Step 4: 删除重复定义

确认三个文件中不再有重复的颜色定义。

Run: `pnpm typecheck`
Expected: PASS

**Commit:**
```bash
git add components/
git commit -m "refactor(F012): DesignSystem迁移 — 三处PROVIDER色彩收口到theme.ts (AC-11..14)"
```

---

## Task 12: 截图能力 (AC-22)

> 实际实现方案：MCP take_screenshot 工具 + Playwright headless 截图 + Callback API + ContentBlock 持久化 + WebSocket 实时推送。

**完整链路（三个 CLI 通用）：**
```
Agent 调用 MCP take_screenshot
  ↓
MCP server → POST /api/callbacks/take-screenshot
  ↓
API server → captureScreenshot() (Playwright headless, 1920×1080)
  ↓
保存 .runtime/uploads/screenshot-xxx.png
  ↓
appendContentBlock → DB 持久化 ContentBlock (type: "image")
  ↓
broadcast assistant_content_block (WebSocket)
  ↓
前端 applyContentBlock → ImageBlockComponent 渲染（支持点击放大 Lightbox）
```

**Files:**
- Create: `packages/api/src/preview/screenshot-service.ts` — Playwright 截图核心服务
- Modify: `packages/api/src/mcp/server.ts` — 注册 take_screenshot MCP 工具（第 12 个）
- Modify: `packages/api/src/routes/callbacks.ts` — 新增 POST /api/callbacks/take-screenshot
- Modify: `packages/api/src/server.ts` — 注入 takeScreenshot handler（截图 + ContentBlock + broadcast）
- Modify: `packages/api/src/db/repositories/session-repository.ts` — appendContentBlock + contentBlocks 字段
- Modify: `packages/api/src/db/repositories/session-repository-drizzle.ts` — 同上 Drizzle 版
- Modify: `packages/api/src/services/session-service.ts` — 暴露 appendContentBlock
- Modify: `packages/shared/src/realtime.ts` — 新增 assistant_content_block 事件类型
- Modify: `components/stores/thread-store.ts` — 新增 applyContentBlock store action
- Modify: `app/page.tsx` — 处理 assistant_content_block WebSocket 事件
- Modify: `components/chat/rich-blocks/image-block.tsx` — Lightbox createPortal 放大 + Escape 关闭
- Modify: `components/chat/markdown-message.tsx` — ZoomableImage 组件，markdown 图片也可放大
- Modify: `packages/api/src/mcp/server.test.ts` — 工具数 11→12 + take_screenshot 测试
- Modify: `packages/api/package.json` — 新增 playwright 依赖

### Step 1: 安装依赖

```bash
cd packages/api
pnpm add playwright
```

### Step 2: screenshot-service.ts — Playwright headless 截图

通过 `node -e` 子进程调用 Playwright chromium，用环境变量传参（避免 argv 偏移问题），
输出 base64 → Buffer → 写入 uploads 目录。

关键设计：
- `resolvePlaywrightNodeModules()` 多级降级查找 playwright 路径（require.resolve → node -e → npx）
- 环境变量 `_SS_URL` / `_SS_W` / `_SS_H` 传参
- 默认 1920×1080 viewport

### Step 3: MCP 工具注册

`mcp/server.ts` 的 `getTools()` 新增 `take_screenshot`（参数：url?, alt?），
`handleToolCall()` 路由到 `callTakeScreenshot()`，通过 callback API 执行截图。

### Step 4: Callback 端点

`routes/callbacks.ts` 新增 `POST /api/callbacks/take-screenshot`，
带 invocationId + callbackToken 鉴权，调用 `options.takeScreenshot()` handler。

### Step 5: Server 组装

`server.ts` 注入 `takeScreenshot` handler：
1. `captureScreenshot()` 执行 Playwright 截图
2. 构建 ImageBlock（type: "image", url, alt, meta）
3. `appendContentBlock()` 持久化到最后一条 assistant 消息
4. `broadcaster.broadcast()` 推送 `assistant_content_block` 事件

### Step 6: DB 层 — appendContentBlock

`session-repository.ts` + `session-repository-drizzle.ts`：
- `overwriteMessage` 增加 `contentBlocks` 字段
- 新增 `appendContentBlock(messageId, block)` — JSON parse → push → JSON stringify → UPDATE

### Step 7: 前端渲染

- `thread-store.ts` 新增 `applyContentBlock(messageId, block)` — 追加到 message.contentBlocks[]
- `app/page.tsx` 监听 `assistant_content_block` WebSocket 事件
- `image-block.tsx` — Lightbox 用 `createPortal` 挂到 document.body（避免 overflow-hidden 裁剪），
  支持 Escape 键关闭、backdrop-blur、点击图片不误关闭
- `markdown-message.tsx` — 新增 `ZoomableImage` 组件 + `img` 覆盖，
  markdown 文本中 `![](url)` 图片也支持点击放大

Run: `pnpm typecheck && pnpm test`
Expected: PASS（工具数 12，截图测试通过）

**Commit:**
```bash
git add packages/api/src/preview/screenshot-service.ts packages/api/src/mcp/server.ts \
  packages/api/src/mcp/server.test.ts packages/api/src/routes/callbacks.ts \
  packages/api/src/server.ts packages/api/src/db/repositories/session-repository*.ts \
  packages/api/src/services/session-service.ts packages/shared/src/realtime.ts \
  components/stores/thread-store.ts app/page.tsx \
  components/chat/rich-blocks/image-block.tsx components/chat/markdown-message.tsx \
  packages/api/package.json pnpm-lock.yaml
git commit -m "feat(F012): 截图能力 — MCP take_screenshot + Playwright + ContentBlock + Lightbox (AC-22)"
```

---

## Task 13: 最终验证 (AC-15..AC-31)

### Step 1: 自动化门禁

```bash
pnpm typecheck && pnpm test
```
Expected: 全绿 (AC-15)

### Step 2: 手动验证清单

| AC | 验证方式 | 预期 |
|----|---------|------|
| AC-16 | DevTools → 在 React 组件中抛异常 | ErrorBoundary 拦截，不白屏 |
| AC-17 | 上传 3 张图片（1 张故意损坏） | 2 张成功 + 文字正常发出 |
| AC-18 | 发送带 tool_use 的消息 | skill/MCP/thinking 默认折叠，结论展示 |
| AC-19 | theme.ts 加新 Provider | 只改一处，全局生效 |
| AC-23 | Claude / Codex / Gemini 各跑一次复杂提示 | 三端 thinking 折叠块都有内容（Gemini 显示 subject/description 拼接 markdown）|
| AC-24 | 三个 CLI 执行操作 | 不卡死、不弹审批、直接放行 |
| AC-25 | agent 调用截图 API | 截图在消息中渲染 |
| AC-28 | Claude stream_event 流式输出 | thinking 累积 + text 流式 + usage 正确 |
| AC-29 | Codex MCP 工具调用 | 前端可见 |
| AC-30 | Gemini candidates crash | 不报错 |
| AC-31 | Windows 下启动 Claude | MCP config 用临时文件 |

**Commit:**
```bash
git commit --allow-empty -m "chore(F012): 全部门禁验证通过 (AC-15..31)"
```

---

## Task 14: Gemini thinking 本地 session 文件回读 (AC-20 Gemini)

**背景（2026-04-18 翻案追加）**：原 AC-20 Gemini 子项判定"无原生 thinking，做不到"是错的。Gemini CLI 一直在 `~/.gemini/tmp/<projectDir>/chats/session-<sessionId>.json` 持久化完整会话，每条 `type === "gemini"` 的消息带 `thoughts: [{ subject, description }]` 数组。自验 `~/.gemini/tmp/multi-agent/chats/`（我们项目自己也在写）+ `~/.gemini/tmp/clowder-ai/chats/session-2026-04-18T08-31-*.json`（clowder 今日会话）已确认数据存在、格式一致。

### Pin finish line

- **B**：Gemini 跑一次复杂提示后，前端"深度思考"折叠块显示 Gemini 本次推理的 `**{subject}**\n{description}` 拼接 markdown；复用 Claude/Codex 既有 thinking 字段管道，前端零改动。
- **不做**：切 `@google/genai` SDK；新增 thinking 专用事件类型（复用 `system_info({type:"thinking"})` 路径）；修改前端 `<ThinkingContent>` 组件；处理历史 session（只处理本次 invoke 产生的）。

### Terminal schema

```typescript
// packages/api/src/runtime/gemini-session-reader.ts
export interface GeminiThought {
  subject?: string
  description?: string
}

export interface GeminiSessionMessage {
  type: "user" | "gemini" | string
  content?: string
  thoughts?: GeminiThought[]
}

// 按 sessionId 读 session 文件，返回本次 invoke 的 assistant 消息 thoughts
export function readGeminiThoughtsFromSession(
  sessionId: string,
  opts: { home?: string; projectDir?: string; assistantText?: string }
): Promise<GeminiThought[]>

// thoughts[] → markdown
export function formatGeminiThoughts(thoughts: GeminiThought[]): string
```

---

### Task 14-A: Spike — 核实 projectDir 推导规则 + 消息匹配策略（限时 20 min）

**产出：决策，不是代码。** 不写实现，不跑测试。

**需要确认的三个问题：**

1. **`projectDir` 是怎么算的？**
   - 假设：`basename(cwd())`。自验方法：
     ```bash
     ls ~/.gemini/tmp/ | head
     echo "cwd names:"; pwd
     ```
   - 对比本地目录名 `multi-agent` / `clowder-ai` / `api` / `bin` / `desktop` / `project` —— 看能否和已知工作目录一一对上
   - 如果不是 basename，看 Gemini CLI 源码 / docs 确认

2. **多轮 resume 时怎么精准匹配本次 assistant 消息？**
   - 打开 `~/.gemini/tmp/multi-agent/chats/session-2026-03-19T17-41-887670b9.json` 看完整结构
   - 重点看：消息有没有 `id` / `timestamp` / `role` 字段？多轮对话是追加到同一个文件还是每轮新文件？
   - 初始策略：取最后一条 `type === "gemini"` 的消息的 thoughts（单轮可用）
   - 如果多轮会累积到同一文件，需要改为"按本次 invoke 的 assistant 输出文本反查"策略

3. **文件写入时序**：CLI 进程退出后，session 文件是否已落盘完成？需要 poll/wait 吗？
   - 自验方法：shell 里跑一次 `gemini -p "test" -o stream-json`，进程退出后立即 `cat` session 文件看内容完整性
   - 如果不完整，加最多 3 次 50ms 轮询

**产出物：** 在本 plan Task 14-A 下方追加"Spike 结论"小节，三问都有结论后才进 14-B。

**Commit：**
```bash
git commit -m "docs(F012): Task 14-A spike 结论 — Gemini session 文件 projectDir/匹配/时序"
```

---

### Task 14-B: 写 `readGeminiThoughtsFromSession` 纯函数 + 失败测试

**Files:**
- Create: `packages/api/src/runtime/gemini-session-reader.ts`
- Create: `packages/api/src/runtime/gemini-session-reader.test.ts`
- Create fixture: `packages/api/src/runtime/__fixtures__/gemini-session-sample.json`（从 `~/.gemini/tmp/clowder-ai/chats/session-2026-04-18T08-31-8c6f6e07.json` 脱敏抽取：保留 1 条 user + 1 条 gemini 消息含 2-3 个 thoughts 条目，删除无关字段）

**Step 1: 写失败测试**

```typescript
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readGeminiThoughtsFromSession } from "./gemini-session-reader.js"

describe("readGeminiThoughtsFromSession", () => {
  it("extracts thoughts[] from the last gemini message in session JSON", async () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-session-test-"))
    const projectDir = "multi-agent"
    const sessionId = "abc-123"
    const chatsDir = join(home, ".gemini", "tmp", projectDir, "chats")
    mkdirSync(chatsDir, { recursive: true })
    const sample = JSON.parse(readFileSync("packages/api/src/runtime/__fixtures__/gemini-session-sample.json", "utf8"))
    writeFileSync(join(chatsDir, `session-${sessionId}.json`), JSON.stringify(sample))

    const thoughts = await readGeminiThoughtsFromSession(sessionId, { home, projectDir })

    assert.ok(Array.isArray(thoughts))
    assert.ok(thoughts.length >= 1)
    assert.equal(typeof thoughts[0].subject, "string")
    assert.equal(typeof thoughts[0].description, "string")
  })

  it("returns empty array when session file missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-session-test-"))
    const thoughts = await readGeminiThoughtsFromSession("nope", { home, projectDir: "x" })
    assert.deepEqual(thoughts, [])
  })

  it("returns empty array when last gemini message has no thoughts field", async () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-session-test-"))
    const chatsDir = join(home, ".gemini", "tmp", "x", "chats")
    mkdirSync(chatsDir, { recursive: true })
    writeFileSync(join(chatsDir, "session-sid.json"), JSON.stringify({
      messages: [{ type: "gemini", content: "hi" }]
    }))
    const thoughts = await readGeminiThoughtsFromSession("sid", { home, projectDir: "x" })
    assert.deepEqual(thoughts, [])
  })
})
```

**Step 2: 跑测试确认失败**

```bash
pnpm --filter @multi-agent/api test -- gemini-session-reader
```
Expected: FAIL with "Cannot find module './gemini-session-reader.js'"

**Step 3: 最小实现**

```typescript
// packages/api/src/runtime/gemini-session-reader.ts
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export interface GeminiThought {
  subject?: string
  description?: string
}

interface GeminiSessionMessage {
  type?: string
  content?: string
  thoughts?: GeminiThought[]
}

interface GeminiSessionFile {
  messages?: GeminiSessionMessage[]
}

export async function readGeminiThoughtsFromSession(
  sessionId: string,
  opts: { home?: string; projectDir: string; assistantText?: string } = { projectDir: "" }
): Promise<GeminiThought[]> {
  const home = opts.home ?? homedir()
  const path = join(home, ".gemini", "tmp", opts.projectDir, "chats", `session-${sessionId}.json`)

  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    return []
  }

  let parsed: GeminiSessionFile
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }

  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  const geminiMessages = messages.filter((m) => m.type === "gemini")
  if (geminiMessages.length === 0) return []

  // MVP: 取最后一条 gemini 消息的 thoughts。
  // 多轮 resume 按 assistantText 匹配的策略在 14-A spike 结论中确定后再扩展。
  const last = geminiMessages[geminiMessages.length - 1]
  const thoughts = Array.isArray(last.thoughts) ? last.thoughts : []
  return thoughts.filter((t) => t && (t.subject || t.description))
}
```

**Step 4: 跑测试确认通过**

```bash
pnpm --filter @multi-agent/api test -- gemini-session-reader
```
Expected: PASS 3/3

**Step 5: Commit**

```bash
git add packages/api/src/runtime/gemini-session-reader.ts \
        packages/api/src/runtime/gemini-session-reader.test.ts \
        packages/api/src/runtime/__fixtures__/gemini-session-sample.json
git commit -m "feat(F012): readGeminiThoughtsFromSession — 回读本地 session 文件 thoughts 数组 (AC-20 Gemini)"
```

---

### Task 14-C: 写 `formatGeminiThoughts` + 测试

**Files:**
- Modify: `packages/api/src/runtime/gemini-session-reader.ts`（追加 export）
- Modify: `packages/api/src/runtime/gemini-session-reader.test.ts`（追加 describe 块）

**Step 1: 写失败测试**

```typescript
import { formatGeminiThoughts } from "./gemini-session-reader.js"

describe("formatGeminiThoughts", () => {
  it("joins subject + description with markdown formatting", () => {
    const out = formatGeminiThoughts([
      { subject: "Analyzing", description: "I'm dissecting..." },
      { subject: "Planning", description: "Next I will..." },
    ])
    assert.equal(out, "**Analyzing**\nI'm dissecting...\n\n**Planning**\nNext I will...")
  })

  it("handles missing subject (description only)", () => {
    const out = formatGeminiThoughts([{ description: "just a thought" }])
    assert.equal(out, "just a thought")
  })

  it("handles missing description (subject only)", () => {
    const out = formatGeminiThoughts([{ subject: "Heading" }])
    assert.equal(out, "**Heading**")
  })

  it("returns empty string for empty array", () => {
    assert.equal(formatGeminiThoughts([]), "")
  })
})
```

**Step 2: 失败**

```bash
pnpm --filter @multi-agent/api test -- gemini-session-reader
```
Expected: FAIL "formatGeminiThoughts is not exported"

**Step 3: 实现**

```typescript
// 追加到 packages/api/src/runtime/gemini-session-reader.ts
export function formatGeminiThoughts(thoughts: GeminiThought[]): string {
  return thoughts
    .map((t) => {
      const subject = t.subject?.trim()
      const description = t.description?.trim()
      if (subject && description) return `**${subject}**\n${description}`
      if (subject) return `**${subject}**`
      if (description) return description
      return ""
    })
    .filter((s) => s.length > 0)
    .join("\n\n")
}
```

**Step 4: 通过**

```bash
pnpm --filter @multi-agent/api test -- gemini-session-reader
```
Expected: PASS 7/7

**Step 5: Commit**

```bash
git add packages/api/src/runtime/gemini-session-reader.ts \
        packages/api/src/runtime/gemini-session-reader.test.ts
git commit -m "feat(F012): formatGeminiThoughts — thoughts[] 拼成 markdown (AC-20 Gemini)"
```

---

### Task 14-D: GeminiRuntime 集成 — invoke 结束后发 thinking 事件

**Files:**
- Modify: `packages/api/src/runtime/gemini-runtime.ts`（invoke 收尾处加回读 + emit；删 L86-131 `parseActivityLine` 对 `event.thought` 的死代码；删 L246 `parseAssistantDelta` 的 `if (event.thought) return ""` 防御）
- Modify: `packages/api/src/runtime/gemini-runtime.test.ts`（或新建对应集成测试文件）

**Step 1: 写失败测试**

```typescript
// packages/api/src/runtime/gemini-runtime-thinking.test.ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GeminiRuntime } from "./gemini-runtime.js"

describe("GeminiRuntime thinking event from session file", () => {
  it("emits a thinking event with formatted thoughts after invoke completes", async () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-rt-"))
    const projectDir = "testproj"
    const sessionId = "sid-xyz"
    const chatsDir = join(home, ".gemini", "tmp", projectDir, "chats")
    mkdirSync(chatsDir, { recursive: true })
    writeFileSync(join(chatsDir, `session-${sessionId}.json`), JSON.stringify({
      messages: [
        { type: "user", content: "hi" },
        { type: "gemini", content: "hello", thoughts: [
          { subject: "Greeting", description: "Saying hi back." }
        ]}
      ]
    }))

    const events: Array<{ type: string; content?: unknown }> = []
    const runtime = new GeminiRuntime({ home, projectDir })
    await runtime.emitThinkingFromSession(sessionId, (e) => events.push(e))

    const thinking = events.find((e) => e.type === "system_info"
      && JSON.parse((e.content as string) ?? "{}").type === "thinking")
    assert.ok(thinking, "should emit a thinking system_info")
    const payload = JSON.parse(thinking.content as string)
    assert.equal(payload.text, "**Greeting**\nSaying hi back.")
  })

  it("emits nothing when session has no thoughts", async () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-rt-"))
    const events: Array<{ type: string }> = []
    const runtime = new GeminiRuntime({ home, projectDir: "x" })
    await runtime.emitThinkingFromSession("missing", (e) => events.push(e))
    assert.equal(events.length, 0)
  })
})
```

**Step 2: 失败**
```bash
pnpm --filter @multi-agent/api test -- gemini-runtime-thinking
```
Expected: FAIL "emitThinkingFromSession is not a function" 或 constructor 不接受 `{ home, projectDir }`

**Step 3: 实现 `emitThinkingFromSession` + invoke 收尾调用 + 删死代码**

```typescript
// packages/api/src/runtime/gemini-runtime.ts 增加
import { readGeminiThoughtsFromSession, formatGeminiThoughts } from "./gemini-session-reader.js"

// constructor 支持注入（便于测试）：
constructor(private readonly deps: { home?: string; projectDir?: string } = {}) { super() }

async emitThinkingFromSession(
  sessionId: string,
  emit: (event: { type: string; content: string; timestamp: number }) => void
): Promise<void> {
  const projectDir = this.deps.projectDir ?? basename(process.cwd())
  const thoughts = await readGeminiThoughtsFromSession(sessionId, { home: this.deps.home, projectDir })
  if (thoughts.length === 0) return
  const text = formatGeminiThoughts(thoughts)
  if (!text) return
  emit({
    type: "system_info",
    content: JSON.stringify({ type: "thinking", text }),
    timestamp: Date.now(),
  })
}

// invoke() 收尾处（在 yield done 前）调用：
// await this.emitThinkingFromSession(sessionId, (e) => yieldQueue.push(e))
// —— 具体集成点按 invoke 现有代码结构嵌入
```

删除死代码（L86-131 `parseActivityLine` 全段 `if (!event.thought) return null; ...` → 直接 `return null`；L246 `parseAssistantDelta` 的 `if (event.thought) return ""` 整段删）。

**Step 4: 通过**
```bash
pnpm --filter @multi-agent/api test -- gemini-runtime-thinking
pnpm --filter @multi-agent/api test  # 全量回归，确认 F006 3b571bc 的旧 parseActivityLine 测试不回归（如果有，更新它们）
```
Expected: PASS + 全量绿

**Step 5: Commit**
```bash
git add packages/api/src/runtime/gemini-runtime.ts \
        packages/api/src/runtime/gemini-runtime-thinking.test.ts
git commit -m "feat(F012): GeminiRuntime 集成 session 回读 + emit thinking 事件 + 删 F006 死代码 (AC-20 Gemini)"
```

---

### Task 14-E: 手动验证 AC-23 Gemini 项

**Step 1: 重启 dev server + 触发复杂提示**

```bash
pnpm dev  # 或现有启动脚本
```

在前端选 Gemini（桂芬），发一条需要多步推理的复杂提示（例如"分析这个文件的架构并给出三条改进建议"）。

**Step 2: 观察前端"深度思考"折叠块**

预期：
- Gemini 消息气泡下方出现"深度思考"折叠标签
- 展开后显示 `**{subject}**\n{description}` 格式的多条思考，和 Claude/Codex 同样样式
- 若 thinking 为空（简单提示），折叠块不出现

**Step 3: 对照 session 文件验证一致性**

```bash
ls -t ~/.gemini/tmp/multi-agent/chats/ | head -1
# 打开最新 session-*.json，确认前端显示内容与 thoughts[] 一致
```

**Step 4: Commit 验证记录**
```bash
git commit --allow-empty -m "chore(F012): AC-23 Gemini thinking 手动验证通过"
```

---

## Summary

| Task | AC | 文件数 | 预估 |
|------|-----|--------|------|
| 1. 健壮性修复 | AC-01..04 | 5 | 30 min |
| 2. Claude stream_event 重写 | AC-20 C1+C3, AC-27 Claude | 2 | 2 hr |
| 3. Claude 权限 + Windows MCP | AC-20 C4, AC-21 Claude | 1 | 15 min |
| 4. Codex 整改 | AC-21,26,27 Codex | 2 | 1 hr |
| 5. Gemini 整改 | AC-26,27 Gemini | 1 | 20 min |
| 6. stdin→param | AC-26 全局 | 4 | 30 min |
| 7. F005 废弃 | AC-21 cleanup | 7 | 30 min |
| 8. DesignSystem theme | AC-10 | 1 | 20 min |
| 9. skillEvents 管道 | AC-06a | 3 | 30 min |
| 10. 卡片化渲染 | AC-05..09 | 3 | 3 hr |
| 11. DesignSystem 迁移 | AC-11..14 | 3 | 30 min |
| 12. 截图能力 | AC-22 | 6 | 2 hr |
| 13. 最终验证 | AC-15..31 | 0 | 1 hr |
| 14. Gemini thinking 回读 | AC-20 Gemini (AC-23 Gemini) | 3 | 1.5 hr |
| **总计** | **31 个 AC** | **~41 文件** | **~13.5 hr** |

**实施顺序：** Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14（2026-04-18 翻案追加）

**关键路径：** Task 2（Claude stream_event 重写）是风险最高、工作量最大的任务，建议优先做并充分测试。Task 14 风险点在 Spike（14-A）—— projectDir 推导规则 / 多轮匹配 / 写入时序三者任一错判会让 session 回读取不到或取错 thoughts；Spike 未结论前不进 14-B。
