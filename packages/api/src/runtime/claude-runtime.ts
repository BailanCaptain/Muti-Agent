import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ToolEvent, UsageDetail } from "@multi-agent/shared"
import { AGENT_SYSTEM_PROMPTS } from "./agent-prompts"
import {
  type AgentRunInput,
  BaseCliRuntime,
  type ParsedUsage,
  type RuntimeCommand,
  type StopReason,
} from "./base-runtime"
import { resolveClaudeCommand } from "./claude-command"

function formatClaudeToolInput(name: string, input: Record<string, unknown>): string {
  try {
    if (name === "Bash") {
      const cmd = String(input.command ?? "")
        .split("\n")[0]
        .slice(0, 80)
      return `$ ${cmd}`
    }

    if (["Read", "Write", "Edit", "NotebookEdit"].includes(name)) {
      const filePath = String(input.file_path ?? "")
      return filePath.split(/[/\\]/).slice(-2).join("/")
    }

    if (name === "Glob") {
      return String(input.pattern ?? "")
    }

    if (name === "Grep") {
      return String(input.pattern ?? "").slice(0, 40)
    }

    if (name === "Task" || name === "Agent") {
      return String(input.description ?? "").slice(0, 60)
    }

    // Default: first string value in input
    for (const value of Object.values(input)) {
      if (typeof value === "string") {
        return value.slice(0, 60)
      }
    }

    return ""
  } catch {
    return ""
  }
}

export class ClaudeRuntime extends BaseCliRuntime {
  readonly agentId = "claude"

  private thinkingBuffer = ""
  private currentMessageId: string | undefined
  private partialTextMessageIds = new Set<string>()
  private lastToolSource: "tool" | "mcp" | "skill" = "tool"

  private unwrapStreamEvent(event: Record<string, unknown>): Record<string, unknown> | null {
    if (event.type === "stream_event") {
      return (event.event ?? event.stream_event) as Record<string, unknown> | null
    }
    return null
  }

  protected buildCommand(input: AgentRunInput): RuntimeCommand {
    const runtime = resolveClaudeCommand()
    const model = input.env?.MULTI_AGENT_MODEL
    const effort = input.env?.MULTI_AGENT_EFFORT
    const sessionId = input.env?.MULTI_AGENT_NATIVE_SESSION_ID
    // 会话已恢复时不重复附加 system prompt，避免冗余 token。
    const args = ["--output-format", "stream-json", "--include-partial-messages", "--verbose"]
    if (!sessionId) {
      const systemPrompt = input.env?.MULTI_AGENT_SYSTEM_PROMPT || AGENT_SYSTEM_PROMPTS.claude
      args.push("--append-system-prompt", systemPrompt)
    }
    args.push("--permission-mode", "bypassPermissions")

    if (model) {
      args.push("--model", model)
    }
    if (effort) {
      args.push("--effort", effort)
    }
    if (sessionId) {
      args.push("--resume", sessionId)
    }

    return {
      command: runtime.command,
      args: [...runtime.prefixArgs, ...args],
      shell: runtime.shell,
      stdinContent: input.prompt,
    }
  }

  parseActivityLine(event: Record<string, unknown>): string | null {
    try {
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

      if (event.type === "system") {
        const subtype =
          (event as Record<string, unknown>).subtype ?? (event as Record<string, unknown>).event
        if (subtype === "compact_boundary") return "[context compacted]"
      }
      if (event.type === "rate_limit_event") {
        // rate_limit_event 是 Claude Code CLI 每次请求都发的配额心跳，不是限流告警。
        // 只有 status 为非 allowed 值（approaching / blocked / exceeded 等）才提示用户。
        // 默认 drop，避免 status:allowed 的心跳淹没推理流（B016）。
        const nested = (event as Record<string, unknown>).rate_limit as
          | Record<string, unknown>
          | undefined
        const status = (nested?.status ?? (event as Record<string, unknown>).status) as
          | string
          | undefined
        if (!status || status === "allowed") return null
        return `[quota: ${status}]`
      }

      if (event.type === "content_block_delta") {
        const delta = event.delta as { type?: string; thinking?: string } | undefined
        if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
          return delta.thinking
        }
      }
      return null
    } catch {
      return null
    }
  }

  transformToolEvent(event: Record<string, unknown>): ToolEvent | null {
    try {
      if (event.type === "assistant") {
        const message = event.message as
          | { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> }
          | undefined
        const toolUse = message?.content?.find((item) => item.type === "tool_use")
        if (toolUse?.name) {
          const source = toolUse.name.startsWith("mcp__")
            ? ("mcp" as const)
            : toolUse.name === "Skill" ||
                toolUse.name === "Agent" ||
                toolUse.name === "activate_skill"
              ? ("skill" as const)
              : ("tool" as const)
          this.lastToolSource = source
          return {
            type: "tool_use",
            toolName: toolUse.name,
            toolInput: formatClaudeToolInput(toolUse.name, toolUse.input ?? {}),
            status: "started",
            timestamp: new Date().toISOString(),
            source,
          }
        }
        return null
      }

      if (event.type === "user") {
        const message = event.message as
          | { content?: Array<{ type?: string; content?: unknown; is_error?: boolean }> }
          | undefined
        const toolResult = message?.content?.find((item) => item.type === "tool_result")
        if (toolResult) {
          const resultContent = toolResult.content
          let text = ""
          if (typeof resultContent === "string") {
            text = resultContent.split("\n")[0].slice(0, 200)
          } else if (Array.isArray(resultContent)) {
            for (const part of resultContent) {
              if (
                typeof part === "object" &&
                part &&
                typeof (part as { text?: string }).text === "string"
              ) {
                text = (part as { text: string }).text.split("\n")[0].slice(0, 200)
                break
              }
            }
          }
          return {
            type: "tool_result",
            toolName: "",
            content: text || "done",
            status: toolResult.is_error ? "error" : "completed",
            timestamp: new Date().toISOString(),
            source: this.lastToolSource,
          }
        }
        return null
      }

      return null
    } catch {
      return null
    }
  }

  // F043 AC1 口径分离（AC0 实测契约见 .agents/acceptance/F043/probes/PROBE-NOTES.md）：
  // - message_start.usage = 该次 API 调用起点的真实上下文足迹（input+cache_read+
  //   cache_creation；output 不占起点窗口，前轮 output 已折进本次 input/cache_read）
  //   → scope="context"，每次调用刷新，域内 latest-wins = 轮末真实占用。
  // - message_delta.usage = 同调用收尾快照（全量字段非 output-only）→ context fallback。
  // - result.usage = 整轮所有调用精确求和（cache_read 每调用重复计）→ scope="turn_total"，
  //   仅供计费统计；喂 seal 判定就是 989k/200k=100% 假封存的病根。
  // - result.modelUsage[完整模型名].contextWindow = 账户生效窗口（camelCase）→ modelWindows。
  parseUsage(event: Record<string, unknown>): ParsedUsage | null {
    const readDetail = (raw: unknown): UsageDetail | null => {
      if (!raw || typeof raw !== "object") return null
      const usage = raw as Record<string, unknown>
      const num = (v: unknown) => (typeof v === "number" ? v : 0)
      const detail: UsageDetail = {
        inputTokens: num(usage.input_tokens),
        outputTokens: num(usage.output_tokens),
        cacheReadTokens: num(usage.cache_read_input_tokens),
        cacheCreationTokens: num(usage.cache_creation_input_tokens),
      }
      const any =
        detail.inputTokens + detail.outputTokens + detail.cacheReadTokens + detail.cacheCreationTokens
      return any > 0 ? detail : null
    }
    const footprintOf = (d: UsageDetail) => d.inputTokens + d.cacheReadTokens + d.cacheCreationTokens

    const contextUsage = (raw: unknown): ParsedUsage | null => {
      const detail = readDetail(raw)
      if (!detail) return null
      const footprint = footprintOf(detail)
      if (footprint <= 0) return null
      return { scope: "context", totalTokens: footprint, contextWindow: null, exact: true, detail }
    }

    const inner = this.unwrapStreamEvent(event)
    if (inner) {
      if (inner.type === "message_start") {
        const msg = inner.message as Record<string, unknown> | undefined
        this.currentMessageId = msg?.id as string | undefined
        return contextUsage((msg as { usage?: unknown } | undefined)?.usage)
      }
      if (inner.type === "message_delta") {
        return contextUsage((inner as { usage?: unknown }).usage)
      }
      return null
    }

    if (event.type === "message_start") {
      const message = event.message as { usage?: unknown } | undefined
      return contextUsage(message?.usage)
    }
    if (event.type === "message_delta") {
      return contextUsage((event as { usage?: unknown }).usage)
    }
    if (event.type === "result") {
      const detail = readDetail((event as { usage?: unknown }).usage)
      if (!detail) return null
      const modelWindows = this.readModelWindows(event.modelUsage)
      return {
        scope: "turn_total",
        totalTokens: footprintOf(detail) + detail.outputTokens,
        contextWindow: null,
        exact: true,
        detail,
        ...(modelWindows ? { modelWindows } : {}),
      }
    }
    return null
  }

  /** F043 AC3：提炼 result.modelUsage 的账户生效窗口。key = 完整模型名，遍历不索引。 */
  private readModelWindows(raw: unknown): Record<string, number> | null {
    if (!raw || typeof raw !== "object") return null
    const out: Record<string, number> = {}
    for (const [model, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue
      const window = (entry as { contextWindow?: unknown }).contextWindow
      if (typeof window === "number" && window > 0) out[model] = window
    }
    return Object.keys(out).length > 0 ? out : null
  }

  parseStopReason(event: Record<string, unknown>): StopReason | null {
    const inner = this.unwrapStreamEvent(event)
    if (inner?.type === "message_delta") {
      const delta = inner.delta as Record<string, unknown> | undefined
      const reason = delta?.stop_reason
      return reason ? this.mapClaudeStopReason(reason) : null
    }

    if (event.type === "result") {
      if (event.is_error) {
        const subtype = event.subtype as string | undefined
        if (subtype === "error_max_turns" || subtype === "error_max_budget_usd") return "truncated"
        return "aborted"
      }
      return this.mapClaudeStopReason(event.stop_reason)
    }
    if (event.type === "message_delta") {
      const delta = event.delta as { stop_reason?: unknown } | undefined
      return this.mapClaudeStopReason(delta?.stop_reason)
    }
    return null
  }

  private mapClaudeStopReason(raw: unknown): StopReason | null {
    if (typeof raw !== "string") return null
    switch (raw) {
      case "end_turn":
      case "stop_sequence":
        return "complete"
      case "max_tokens":
        return "truncated"
      case "refusal":
        return "refused"
      case "tool_use":
        return "tool_wait"
      default:
        return null
    }
  }

  parseAssistantDelta(event: Record<string, unknown>) {
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
        return ""
      }
      return ""
    }

    if (event.type === "content_block_delta") {
      const delta = event.delta as { type?: string; text?: string } | undefined
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        return delta.text
      }
    }

    if (event.type === "message_delta" && typeof event.delta === "string") {
      return event.delta
    }

    if (event.type !== "assistant") {
      return ""
    }

    const message = event.message as
      | { id?: string; content?: Array<{ type?: string; text?: string }> }
      | undefined
    const messageId = message?.id
    // R-057 + R-075 双根因合并修：assistant envelope 含 text 永远不进 content stream。
    //   - R-057 (4/29 D-五轮传话游戏 早一版)：thinking-only envelope 错消费 skip 标记 →
    //     下一帧 text envelope 不再 skip → DB 入双份
    //   - R-075 (5/1 D-五轮传话游戏 仁勋 final)：DB 实证 1724B 双段（单段 ×2 差 1 字节回车），
    //     流式 text_delta 累加 851B + envelope 含完整 text → 字符级精确双拷贝
    // 当前 CLI 行为（实测 --include-partial-messages）：text_delta 总是先发，envelope 后发；
    // envelope 的 text 字段是 CLI 冗余 partial snapshot。流式 text_delta 是 source of truth，
    // envelope 含 text 一律 return ""，杜绝任何状态机错乱（singleton 跨 invocation 共享、
    // 旧 process 加载旧代码等）导致的双段。
    const hasTextContent = !!message?.content?.some(
      (item) => item.type === "text" && typeof item.text === "string",
    )
    if (messageId && this.partialTextMessageIds.has(messageId) && hasTextContent) {
      this.partialTextMessageIds.delete(messageId) // 消费 skip 标记保持向后兼容
    }
    return ""
  }
}

export const claudeRuntime = new ClaudeRuntime()
