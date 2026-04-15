import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolEvent } from "@multi-agent/shared";
import { BaseCliRuntime, resolveNpmRoot, type AgentRunInput, type RuntimeCommand, type StopReason } from "./base-runtime";
import { AGENT_SYSTEM_PROMPTS } from "./agent-prompts";

function resolveClaudeCommand() {
  // 1. npm 全局安装：cli.js 在 npm node_modules 里
  const npmRoot = resolveNpmRoot();
  const cliJs = npmRoot ? path.join(npmRoot, "node_modules", "@anthropic-ai", "claude-code", "cli.js") : "";
  if (cliJs && existsSync(cliJs)) {
    return { command: process.execPath, prefixArgs: [cliJs], shell: false };
  }

  // 2. PowerShell / standalone 安装：claude.exe 在 ~/.local/bin/
  const homeDir = process.env.USERPROFILE || process.env.HOME || "";
  const standaloneExe = path.join(homeDir, ".local", "bin", "claude.exe");
  if (existsSync(standaloneExe)) {
    return { command: standaloneExe, prefixArgs: [], shell: false };
  }

  // 3. 兜底：shell 模式（避免 --append-system-prompt 换行符被截断，不推荐）
  return { command: "claude", prefixArgs: [], shell: true };
}

function formatClaudeToolInput(name: string, input: Record<string, unknown>): string {
  try {
    if (name === "Bash") {
      const cmd = String(input.command ?? "").split("\n")[0].slice(0, 80);
      return `$ ${cmd}`;
    }

    if (["Read", "Write", "Edit", "NotebookEdit"].includes(name)) {
      const filePath = String(input.file_path ?? "");
      return filePath.split(/[/\\]/).slice(-2).join("/");
    }

    if (name === "Glob") {
      return String(input.pattern ?? "");
    }

    if (name === "Grep") {
      return String(input.pattern ?? "").slice(0, 40);
    }

    if (name === "Task" || name === "Agent") {
      return String(input.description ?? "").slice(0, 60);
    }

    // Default: first string value in input
    for (const value of Object.values(input)) {
      if (typeof value === "string") {
        return value.slice(0, 60);
      }
    }

    return "";
  } catch {
    return "";
  }
}

export class ClaudeRuntime extends BaseCliRuntime {
  readonly agentId = "claude";

  private thinkingBuffer = "";
  private currentMessageId: string | undefined;
  private partialTextMessageIds = new Set<string>();

  private unwrapStreamEvent(event: Record<string, unknown>): Record<string, unknown> | null {
    if (event.type === "stream_event") {
      return (event.event ?? event.stream_event) as Record<string, unknown> | null;
    }
    return null;
  }

  protected buildCommand(input: AgentRunInput): RuntimeCommand {
    const runtime = resolveClaudeCommand();
    const model = input.env?.MULTI_AGENT_MODEL;
    const effort = input.env?.MULTI_AGENT_EFFORT;
    const sessionId = input.env?.MULTI_AGENT_NATIVE_SESSION_ID;
    // 会话已恢复时不重复附加 system prompt，避免冗余 token。
    const args = ["--output-format", "stream-json", "--include-partial-messages", "--verbose"];
    if (!sessionId) {
      const systemPrompt = input.env?.MULTI_AGENT_SYSTEM_PROMPT || AGENT_SYSTEM_PROMPTS.claude;
      args.push("--append-system-prompt", systemPrompt);
    }
    const mcpServerPath = path.join(__dirname, "..", "mcp", "server.js");

    const mcpConfigObj = {
      mcpServers: {
        multi_agent_room: {
          command: process.execPath,
          args: [mcpServerPath],
          env: {
            MULTI_AGENT_API_URL: input.env?.MULTI_AGENT_API_URL ?? "",
            MULTI_AGENT_INVOCATION_ID: input.env?.MULTI_AGENT_INVOCATION_ID ?? "",
            MULTI_AGENT_CALLBACK_TOKEN: input.env?.MULTI_AGENT_CALLBACK_TOKEN ?? ""
          }
        }
      }
    };
    let cleanup: (() => void) | undefined;
    if (process.platform === "win32") {
      const dir = mkdtempSync(path.join(tmpdir(), "multi-agent-mcp-"));
      const configPath = path.join(dir, "mcp-config.json");
      writeFileSync(configPath, JSON.stringify(mcpConfigObj), "utf-8");
      args.push("--mcp-config", configPath);
      cleanup = () => {
        try { require("node:fs").rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      };
    } else {
      args.push("--mcp-config", JSON.stringify(mcpConfigObj));
    }

    args.push("--permission-mode", "bypassPermissions");

    if (model) {
      args.push("--model", model);
    }
    if (effort) {
      args.push("--effort", effort);
    }
    if (sessionId) {
      args.push("--resume", sessionId);
    }
    args.push("-p", input.prompt);

    return {
      command: runtime.command,
      args: [...runtime.prefixArgs, ...args],
      shell: runtime.shell,
      cleanup,
    };
  }

  parseActivityLine(event: Record<string, unknown>): string | null {
    try {
      const inner = this.unwrapStreamEvent(event);
      if (inner) {
        if (inner.type === "content_block_start") {
          const block = inner.content_block as Record<string, unknown> | undefined;
          if (block?.type === "thinking") this.thinkingBuffer = "";
          return null;
        }
        if (inner.type === "content_block_delta") {
          const delta = inner.delta as Record<string, unknown> | undefined;
          if (delta?.type === "thinking_delta") {
            this.thinkingBuffer += (delta.thinking as string) ?? "";
            return null;
          }
          return null;
        }
        if (inner.type === "content_block_stop") {
          if (this.thinkingBuffer.length > 0) {
            const text = this.thinkingBuffer;
            this.thinkingBuffer = "";
            return text;
          }
          return null;
        }
        if (inner.type === "message_start") {
          const msg = inner.message as Record<string, unknown> | undefined;
          this.currentMessageId = msg?.id as string | undefined;
          return null;
        }
        if (inner.type === "message_stop") {
          this.currentMessageId = undefined;
          return null;
        }
        return null;
      }

      if (event.type === "system") {
        const subtype = (event as Record<string, unknown>).subtype ?? (event as Record<string, unknown>).event;
        if (subtype === "compact_boundary") return "[context compacted]";
      }
      if (event.type === "rate_limit_event") return "[rate limited]";

      if (event.type === "content_block_delta") {
        const delta = event.delta as { type?: string; thinking?: string } | undefined;
        if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
          return delta.thinking;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  transformToolEvent(event: Record<string, unknown>): ToolEvent | null {
    try {
      if (event.type === "assistant") {
        const message = event.message as { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> } | undefined;
        const toolUse = message?.content?.find((item) => item.type === "tool_use");
        if (toolUse?.name) {
          return {
            type: "tool_use",
            toolName: toolUse.name,
            toolInput: formatClaudeToolInput(toolUse.name, toolUse.input ?? {}),
            status: "started",
            timestamp: new Date().toISOString(),
          };
        }
        return null;
      }

      if (event.type === "user") {
        const message = event.message as { content?: Array<{ type?: string; content?: unknown; is_error?: boolean }> } | undefined;
        const toolResult = message?.content?.find((item) => item.type === "tool_result");
        if (toolResult) {
          const resultContent = toolResult.content;
          let text = "";
          if (typeof resultContent === "string") {
            text = resultContent.split("\n")[0].slice(0, 200);
          } else if (Array.isArray(resultContent)) {
            for (const part of resultContent) {
              if (typeof part === "object" && part && typeof (part as { text?: string }).text === "string") {
                text = (part as { text: string }).text.split("\n")[0].slice(0, 200);
                break;
              }
            }
          }
          return {
            type: "tool_result",
            toolName: "",
            content: text || "done",
            status: toolResult.is_error ? "error" : "completed",
            timestamp: new Date().toISOString(),
          };
        }
        return null;
      }

      return null;
    } catch {
      return null;
    }
  }

  parseUsage(event: Record<string, unknown>): { totalTokens: number; contextWindow: number | null } | null {
    const readUsage = (raw: unknown) => {
      if (!raw || typeof raw !== "object") return null;
      const usage = raw as Record<string, unknown>;
      const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
      const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
      const cacheRead = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
      const cacheCreate = typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
      const total = input + output + cacheRead + cacheCreate;
      return total > 0 ? total : null;
    };

    const inner = this.unwrapStreamEvent(event);
    if (inner) {
      if (inner.type === "message_start") {
        const msg = inner.message as Record<string, unknown> | undefined;
        this.currentMessageId = msg?.id as string | undefined;
        const total = readUsage((msg as { usage?: unknown } | undefined)?.usage);
        return total != null ? { totalTokens: total, contextWindow: null } : null;
      }
      if (inner.type === "message_delta") {
        const total = readUsage((inner as { usage?: unknown }).usage);
        return total != null ? { totalTokens: total, contextWindow: null } : null;
      }
      return null;
    }

    if (event.type === "message_start") {
      const message = event.message as { usage?: unknown } | undefined;
      const total = readUsage(message?.usage);
      return total != null ? { totalTokens: total, contextWindow: null } : null;
    }
    if (event.type === "message_delta") {
      const total = readUsage((event as { usage?: unknown }).usage);
      return total != null ? { totalTokens: total, contextWindow: null } : null;
    }
    if (event.type === "result") {
      const total = readUsage((event as { usage?: unknown }).usage);
      return total != null ? { totalTokens: total, contextWindow: null } : null;
    }
    return null;
  }

  parseStopReason(event: Record<string, unknown>): StopReason | null {
    const inner = this.unwrapStreamEvent(event);
    if (inner?.type === "message_delta") {
      const delta = inner.delta as Record<string, unknown> | undefined;
      const reason = delta?.stop_reason;
      return reason ? this.mapClaudeStopReason(reason) : null;
    }

    if (event.type === "result") {
      if (event.is_error) {
        const subtype = event.subtype as string | undefined;
        if (subtype === "error_max_turns" || subtype === "error_max_budget_usd") return "truncated";
        return "aborted";
      }
      return this.mapClaudeStopReason(event.stop_reason);
    }
    if (event.type === "message_delta") {
      const delta = event.delta as { stop_reason?: unknown } | undefined;
      return this.mapClaudeStopReason(delta?.stop_reason);
    }
    return null;
  }

  private mapClaudeStopReason(raw: unknown): StopReason | null {
    if (typeof raw !== "string") return null;
    switch (raw) {
      case "end_turn":
      case "stop_sequence":
        return "complete";
      case "max_tokens":
        return "truncated";
      case "refusal":
        return "refused";
      case "tool_use":
        return "tool_wait";
      default:
        return null;
    }
  }

  parseAssistantDelta(event: Record<string, unknown>) {
    const inner = this.unwrapStreamEvent(event);
    if (inner) {
      if (inner.type === "content_block_delta") {
        const delta = inner.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta") {
          if (this.currentMessageId) {
            this.partialTextMessageIds.add(this.currentMessageId);
          }
          return (delta.text as string) ?? "";
        }
        return "";
      }
      return "";
    }

    if (event.type === "content_block_delta") {
      const delta = event.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        return delta.text;
      }
    }

    if (event.type === "message_delta" && typeof event.delta === "string") {
      return event.delta;
    }

    if (event.type !== "assistant") {
      return "";
    }

    const message = event.message as { id?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
    const messageId = message?.id;
    const skipText = messageId ? this.partialTextMessageIds.has(messageId) : false;
    if (skipText && messageId) this.partialTextMessageIds.delete(messageId);

    return (
      message?.content
        ?.filter((item) => item.type === "text" && typeof item.text === "string" && !skipText)
        .map((item) => item.text)
        .join("") ?? ""
    );
  }
}

export const claudeRuntime = new ClaudeRuntime();
