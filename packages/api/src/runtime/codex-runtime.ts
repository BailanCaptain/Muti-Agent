import { existsSync, readFileSync, readdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ToolEvent } from "@multi-agent/shared"
import { AGENT_SYSTEM_PROMPTS } from "./agent-prompts"
import {
  type AgentRunInput,
  BaseCliRuntime,
  type ParsedUsage,
  type RuntimeCommand,
  type RuntimeDependencies,
  type StopReason,
  resolveNpmRoot,
  wrapPromptWithInstructions,
} from "./base-runtime"

function resolveCodexCommand() {
  const npmRoot = resolveNpmRoot()
  const codexJs = npmRoot
    ? path.join(npmRoot, "node_modules", "@openai", "codex", "bin", "codex.js")
    : ""

  if (codexJs && existsSync(codexJs)) {
    return { command: process.execPath, prefixArgs: [codexJs], shell: false }
  }

  return { command: "codex.cmd", prefixArgs: [], shell: true }
}

export class CodexRuntime extends BaseCliRuntime {
  readonly agentId = "codex"
  private hadPriorTextTurn = false

  /**
   * F043 AC2：rollout 目录可注入（测试用 temp dir）。生产默认 ~/.codex/sessions，
   * 结构 YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl。
   */
  constructor(
    dependencies: RuntimeDependencies = {},
    private readonly sessionsDir = path.join(os.homedir(), ".codex", "sessions"),
  ) {
    super(dependencies)
  }

  protected buildCommand(input: AgentRunInput): RuntimeCommand {
    const runtime = resolveCodexCommand()
    const model = input.env?.MULTI_AGENT_MODEL
    const effort = input.env?.MULTI_AGENT_EFFORT
    const sessionId = input.env?.MULTI_AGENT_NATIVE_SESSION_ID
    const systemPrompt = input.env?.MULTI_AGENT_SYSTEM_PROMPT || AGENT_SYSTEM_PROMPTS.codex
    const prompt = sessionId ? input.prompt : wrapPromptWithInstructions(systemPrompt, input.prompt)
    const cwd = input.cwd ?? "."
    const hasGit = existsSync(path.join(cwd, ".git"))
    const topLevelArgs = [
      ...(model ? ["-m", model] : []),
      ...(effort ? ["--config", `model_reasoning_effort="${effort}"`] : []),
      "--config",
      'approval_policy="on-request"',
      "--sandbox",
      "danger-full-access",
      "--add-dir",
      ".git",
    ]
    const baseArgs = sessionId
      ? ["exec", "resume", ...(hasGit ? [] : ["--skip-git-repo-check"]), "--json", sessionId]
      : ["exec", ...(hasGit ? [] : ["--skip-git-repo-check"]), "--json"]

    return {
      command: runtime.command,
      args: [...runtime.prefixArgs, ...topLevelArgs, ...baseArgs],
      shell: runtime.shell,
      stdinContent: prompt,
    }
  }

  parseActivityLine(event: Record<string, unknown>): string | null {
    try {
      const type = event.type as string | undefined
      if (!type) return null
      const item = (event.item ?? event) as Record<string, unknown>
      const itemType = item.type as string | undefined

      if (type === "item.started" && itemType === "reasoning") {
        return "🧠 正在推理..."
      }
      if (type === "item.completed" && itemType === "reasoning") {
        const directText = typeof item.text === "string" ? item.text.trim() : ""
        if (directText) return directText
        const summaryArr = Array.isArray(item.summary)
          ? (item.summary as Array<Record<string, unknown>>)
          : []
        const summaryText = summaryArr
          .filter((s) => s.type === "summary_text" && typeof s.text === "string")
          .map((s) => s.text as string)
          .join("\n")
          .trim()
        return summaryText || null
      }

      if (itemType === "todo_list") {
        const items = (
          Array.isArray(item.todo_items)
            ? item.todo_items
            : Array.isArray(item.items)
              ? item.items
              : []
        ) as Array<Record<string, unknown>>
        const summary = items
          .map(
            (t) =>
              `[${(t.status as string) ?? "?"}] ${((t.content as string) ?? (t.text as string) ?? "").slice(0, 80)}`,
          )
          .join("; ")
        return `Tasks: ${summary}`
      }

      if (type === "item.completed" && itemType === "web_search") {
        return "[web search completed]"
      }

      if (type === "item.completed" && itemType === "error") {
        return `[warning] ${(item.message as string) ?? "unknown error"}`
      }

      if (type === "error") {
        const msg = ((event.message as string) ?? "").trim()
        if (msg.startsWith("Reconnecting")) return `[${msg}]`
        return null
      }

      return null
    } catch {
      return null
    }
  }

  transformToolEvent(event: Record<string, unknown>): ToolEvent | null {
    try {
      const type = event.type as string | undefined
      const item = event.item as Record<string, unknown> | undefined
      if (!type || !item) return null
      const itemType = item.type as string | undefined

      if (type === "item.started" && itemType === "mcp_tool_call") {
        const server = typeof item.server === "string" ? item.server : "unknown"
        const tool = typeof item.tool === "string" ? item.tool : "unknown"
        return {
          type: "tool_use",
          toolName: `mcp:${server}/${tool}`,
          toolInput: JSON.stringify(item.arguments ?? {}).slice(0, 100),
          status: "started",
          timestamp: new Date().toISOString(),
          source: "mcp",
        }
      }

      if (type === "item.completed" && itemType === "mcp_tool_call") {
        const status = (item.status as string) ?? "unknown"
        const result = item.result as Record<string, unknown> | undefined
        const content = Array.isArray(result?.content)
          ? (result!.content as Array<Record<string, unknown>>)
              .filter((c) => c.type === "text")
              .map((c) => c.text as string)
              .join("\n")
          : String(result ?? "")
        return {
          type: "tool_result",
          toolName: "",
          content: `[${status}] ${content.slice(0, 500)}` || "done",
          status: status === "error" ? "error" : "completed",
          timestamp: new Date().toISOString(),
          source: "mcp",
        }
      }

      if (type === "item.started" && itemType === "command_execution") {
        const cmd = (item.command as string) ?? ""
        const skillMatch = cmd.match(/multi-agent-skills[\/\\]+([a-z0-9-]+)/i)
        if (skillMatch) {
          return {
            type: "tool_use",
            toolName: "Skill",
            toolInput: skillMatch[1],
            status: "started",
            timestamp: new Date().toISOString(),
            source: "skill",
          }
        }
        return {
          type: "tool_use",
          toolName: "Bash",
          toolInput: cmd.split("\n")[0].slice(0, 100),
          status: "started",
          timestamp: new Date().toISOString(),
          source: "tool",
        }
      }

      if (type === "item.completed" && itemType === "command_execution") {
        const cmd = (item.command as string) ?? ""
        const output = (item.aggregated_output as string) ?? (item.output as string) ?? ""
        const isSkill = /multi-agent-skills[\/\\]+[a-z0-9-]+/i.test(cmd)
        return {
          type: "tool_result",
          toolName: isSkill ? "Skill" : "Bash",
          content: output.split("\n")[0].slice(0, 200) || "done",
          status: "completed",
          timestamp: new Date().toISOString(),
          source: isSkill ? "skill" : "tool",
        }
      }

      if (type === "item.completed" && itemType === "file_change") {
        const filePath = (item.path as string) ?? ""
        const shortPath = filePath.split(/[/\\]/).slice(-2).join("/")
        const isSkill = /multi-agent-skills[\/\\]/i.test(filePath)
        return {
          type: "tool_use",
          toolName: isSkill ? "Skill" : "Edit",
          toolInput: shortPath,
          status: "completed",
          timestamp: new Date().toISOString(),
          source: isSkill ? "skill" : "tool",
        }
      }

      return null
    } catch {
      return null
    }
  }

  // F043 AC2（AC0 实测翻正，探针 codex-0.144.1-multicall.ndjson + rollout 对账）：
  // turn.completed.usage 就是 total_token_usage —— session 级累计值，且
  // cached_input_tokens ⊆ input_tokens（旧注释断言「input 是新增量、cached 另计」
  // 实测为假，相加 = 双计缓存，9.35× 虚高实锤）。
  // 流内只能拿到这个退化估计：input_tokens 单值、exact:false，仍作 context 喂 seal
  // （否则 rollout 回读失败时 codex 无任何封存保护）。真足迹走 resolveUsage 回读。
  parseUsage(event: Record<string, unknown>): ParsedUsage | null {
    if (event.type !== "turn.completed") {
      return null
    }
    const usage = event.usage as Record<string, unknown> | undefined
    if (!usage) {
      return null
    }
    const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0
    if (input <= 0) {
      return null
    }
    return { scope: "context", totalTokens: input, contextWindow: null, exact: false }
  }

  /**
   * F043 AC2：turn 结束后回读 rollout 文件末条 token_count ——
   * `info.last_token_usage` = 末次请求真实上下文足迹（vs total_token_usage 累计），
   * `info.model_context_window` = CLI 自报真窗口（随换代漂移，绝不写死）。
   * 行结构（AC0 实测）：{"type":"event_msg","payload":{"type":"token_count","info":{...}}}。
   * 任何失败 → null（保留流内退化值），绝不 fail turn。
   */
  override async resolveUsage(ctx: { sessionId: string | null }): Promise<ParsedUsage | null> {
    if (!ctx.sessionId) return null
    try {
      const file = this.findRolloutFile(ctx.sessionId)
      if (!file) return null
      const info = this.lastTokenCountInfo(file)
      if (!info) return null
      const last = info.last_token_usage as Record<string, unknown> | undefined
      if (!last) return null
      const num = (v: unknown) => (typeof v === "number" ? v : 0)
      const inputTokens = num(last.input_tokens)
      const outputTokens = num(last.output_tokens)
      const cachedInput = num(last.cached_input_tokens)
      const totalTokens =
        typeof last.total_tokens === "number" ? last.total_tokens : inputTokens + outputTokens
      if (totalTokens <= 0) return null
      const window = info.model_context_window
      return {
        scope: "context",
        totalTokens,
        contextWindow: typeof window === "number" && window > 0 ? window : null,
        exact: true,
        detail: {
          // UsageDetail 统一契约（P1-2 德彪 r1）：inputTokens = 非缓存输入。
          // codex 原生 input_tokens 含 cached（cached ⊆ input），这里拆开归一化；
          // 不拆则展示层按三列互斥语义求和 → 缓存双计（13,384+13,056=26,440 假高）。
          inputTokens: Math.max(0, inputTokens - cachedInput),
          outputTokens,
          cacheReadTokens: cachedInput,
          cacheCreationTokens: 0,
        },
      }
    } catch {
      return null
    }
  }

  /** 定位 rollout 文件：日期目录倒序扫（turn 刚结束，文件几乎必在最近日期），文件名含 sessionId。 */
  private findRolloutFile(sessionId: string): string | null {
    const listDirs = (dir: string) => {
      try {
        return readdirSync(dir, { withFileTypes: true })
      } catch {
        return []
      }
    }
    const years = listDirs(this.sessionsDir)
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse()
    for (const year of years) {
      const months = listDirs(path.join(this.sessionsDir, year))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .reverse()
      for (const month of months) {
        const days = listDirs(path.join(this.sessionsDir, year, month))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort()
          .reverse()
        for (const day of days) {
          const dayDir = path.join(this.sessionsDir, year, month, day)
          const hit = listDirs(dayDir).find(
            (e) => e.isFile() && e.name.includes(sessionId) && e.name.endsWith(".jsonl"),
          )
          if (hit) return path.join(dayDir, hit.name)
        }
      }
    }
    return null
  }

  /** 倒序扫行找最后一条 token_count（真实 rollout 尾行是 task_complete，半行损坏也要容忍）。 */
  private lastTokenCountInfo(file: string): Record<string, unknown> | null {
    const lines = readFileSync(file, "utf-8").split("\n")
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const parsed = JSON.parse(line) as {
          payload?: { type?: string; info?: Record<string, unknown> }
        }
        if (parsed.payload?.type === "token_count" && parsed.payload.info) {
          return parsed.payload.info
        }
      } catch {
        // 半行/损坏行跳过，继续向上找
      }
    }
    return null
  }

  parseStopReason(event: Record<string, unknown>): StopReason | null {
    if (event.type === "turn.completed") {
      return "complete"
    }
    if (event.type === "turn.failed") {
      const error = event.error as { type?: string } | undefined
      if (error?.type === "context_length_exceeded" || error?.type === "max_output_tokens") {
        return "truncated"
      }
      return "aborted"
    }
    return null
  }

  parseAssistantDelta(event: Record<string, unknown>) {
    const item = event.item as { type?: string; text?: string } | undefined

    // Reasoning items are surfaced via parseActivityLine into the thinking bubble,
    // so they must not leak into the assistant's visible text output.
    if (item?.type === "reasoning") {
      return ""
    }

    const delta =
      typeof event.delta === "string"
        ? event.delta
        : typeof event.text === "string"
          ? event.text
          : typeof (event.output_text as string | undefined) === "string"
            ? (event.output_text as string)
            : ""

    if (
      (event.type === "response.output_text.delta" ||
        event.type === "item.delta" ||
        event.type === "agent_message.delta") &&
      delta
    ) {
      return delta
    }

    if (
      event.type === "item.completed" &&
      item?.type === "agent_message" &&
      typeof item.text === "string"
    ) {
      const text = item.text.trim()
      if (text.length === 0) return ""
      const prefix = this.hadPriorTextTurn ? "\n\n" : ""
      this.hadPriorTextTurn = true
      return prefix + text
    }

    return ""
  }
}

export const codexRuntime = new CodexRuntime()
