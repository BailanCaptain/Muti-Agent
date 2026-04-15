import { existsSync } from "node:fs";
import path from "node:path";
import type { ToolEvent } from "@multi-agent/shared";
import { BaseCliRuntime, resolveNpmRoot, wrapPromptWithInstructions, type AgentRunInput, type RuntimeCommand, type StopReason } from "./base-runtime";
import { AGENT_SYSTEM_PROMPTS } from "./agent-prompts";

function resolveCodexCommand() {
  const npmRoot = resolveNpmRoot();
  const codexJs = npmRoot ? path.join(npmRoot, "node_modules", "@openai", "codex", "bin", "codex.js") : "";

  if (codexJs && existsSync(codexJs)) {
    return { command: process.execPath, prefixArgs: [codexJs], shell: false };
  }

  return { command: "codex.cmd", prefixArgs: [], shell: true };
}

export class CodexRuntime extends BaseCliRuntime {
  readonly agentId = "codex";
  private hadPriorTextTurn = false;

  protected buildCommand(input: AgentRunInput): RuntimeCommand {
    const runtime = resolveCodexCommand();
    const model = input.env?.MULTI_AGENT_MODEL;
    const effort = input.env?.MULTI_AGENT_EFFORT;
    const sessionId = input.env?.MULTI_AGENT_NATIVE_SESSION_ID;
    const systemPrompt = input.env?.MULTI_AGENT_SYSTEM_PROMPT || AGENT_SYSTEM_PROMPTS.codex;
    const prompt = sessionId
      ? input.prompt
      : wrapPromptWithInstructions(systemPrompt, input.prompt);
    const cwd = input.cwd ?? ".";
    const hasGit = existsSync(path.join(cwd, ".git"));
    const topLevelArgs = [
      ...(model ? ["-m", model] : []),
      ...(effort ? ["--config", `model_reasoning_effort="${effort}"`] : []),
      "--config", 'approval_policy="on-request"',
      "--sandbox", "danger-full-access",
      "--add-dir", ".git",
    ];
    const baseArgs = sessionId
      ? ["exec", "resume", ...(hasGit ? [] : ["--skip-git-repo-check"]), "--json", sessionId]
      : ["exec", ...(hasGit ? [] : ["--skip-git-repo-check"]), "--json"];

    return {
      command: runtime.command,
      args: [...runtime.prefixArgs, ...topLevelArgs, ...baseArgs, "--", prompt],
      shell: runtime.shell,
    };
  }

  parseActivityLine(event: Record<string, unknown>): string | null {
    try {
      const type = event.type as string | undefined;
      if (!type) return null;
      const item = (event.item ?? event) as Record<string, unknown>;
      const itemType = item.type as string | undefined;

      if (type === "item.started" && itemType === "reasoning") {
        return "🧠 正在推理...";
      }
      if (type === "item.completed" && itemType === "reasoning") {
        const directText = typeof item.text === "string" ? item.text.trim() : "";
        if (directText) return directText;
        const summaryArr = Array.isArray(item.summary) ? (item.summary as Array<Record<string, unknown>>) : [];
        const summaryText = summaryArr
          .filter((s) => s.type === "summary_text" && typeof s.text === "string")
          .map((s) => s.text as string)
          .join("\n")
          .trim();
        return summaryText || null;
      }

      if (itemType === "todo_list") {
        const items = (Array.isArray(item.todo_items) ? item.todo_items : Array.isArray(item.items) ? item.items : []) as Array<Record<string, unknown>>;
        const summary = items.map((t) => `[${(t.status as string) ?? "?"}] ${((t.content as string) ?? (t.text as string) ?? "").slice(0, 80)}`).join("; ");
        return `Tasks: ${summary}`;
      }

      if (type === "item.completed" && itemType === "web_search") {
        return "[web search completed]";
      }

      if (type === "item.completed" && itemType === "error") {
        return `[warning] ${(item.message as string) ?? "unknown error"}`;
      }

      if (type === "error") {
        const msg = ((event.message as string) ?? "").trim();
        if (msg.startsWith("Reconnecting")) return `[${msg}]`;
        return null;
      }

      return null;
    } catch {
      return null;
    }
  }

  transformToolEvent(event: Record<string, unknown>): ToolEvent | null {
    try {
      const type = event.type as string | undefined;
      const item = event.item as Record<string, unknown> | undefined;
      if (!type || !item) return null;
      const itemType = item.type as string | undefined;

      if (type === "item.started" && itemType === "mcp_tool_call") {
        const server = typeof item.server === "string" ? item.server : "unknown";
        const tool = typeof item.tool === "string" ? item.tool : "unknown";
        return {
          type: "tool_use",
          toolName: `mcp:${server}/${tool}`,
          toolInput: JSON.stringify(item.arguments ?? {}).slice(0, 100),
          status: "started",
          timestamp: new Date().toISOString(),
          source: "mcp",
        };
      }

      if (type === "item.completed" && itemType === "mcp_tool_call") {
        const status = (item.status as string) ?? "unknown";
        const result = item.result as Record<string, unknown> | undefined;
        const content = Array.isArray(result?.content)
          ? (result!.content as Array<Record<string, unknown>>).filter((c) => c.type === "text").map((c) => c.text as string).join("\n")
          : String(result ?? "");
        return {
          type: "tool_result",
          toolName: "",
          content: `[${status}] ${content.slice(0, 500)}` || "done",
          status: status === "error" ? "error" : "completed",
          timestamp: new Date().toISOString(),
          source: "mcp",
        };
      }

      if (type === "item.started" && itemType === "command_execution") {
        const cmd = (item.command as string) ?? "";
        const skillMatch = cmd.match(/multi-agent-skills[\/\\]+([a-z0-9-]+)/i);
        if (skillMatch) {
          return {
            type: "tool_use",
            toolName: "Skill",
            toolInput: skillMatch[1],
            status: "started",
            timestamp: new Date().toISOString(),
            source: "skill",
          };
        }
        return {
          type: "tool_use",
          toolName: "Bash",
          toolInput: cmd.split("\n")[0].slice(0, 100),
          status: "started",
          timestamp: new Date().toISOString(),
          source: "tool",
        };
      }

      if (type === "item.completed" && itemType === "command_execution") {
        const cmd = (item.command as string) ?? "";
        const output = (item.aggregated_output as string) ?? (item.output as string) ?? "";
        const isSkill = /multi-agent-skills[\/\\]+[a-z0-9-]+/i.test(cmd);
        return {
          type: "tool_result",
          toolName: isSkill ? "Skill" : "Bash",
          content: output.split("\n")[0].slice(0, 200) || "done",
          status: "completed",
          timestamp: new Date().toISOString(),
          source: isSkill ? "skill" : "tool",
        };
      }

      if (type === "item.completed" && itemType === "file_change") {
        const filePath = (item.path as string) ?? "";
        const shortPath = filePath.split(/[/\\]/).slice(-2).join("/");
        const isSkill = /multi-agent-skills[\/\\]/i.test(filePath);
        return {
          type: "tool_use",
          toolName: isSkill ? "Skill" : "Edit",
          toolInput: shortPath,
          status: "completed",
          timestamp: new Date().toISOString(),
          source: isSkill ? "skill" : "tool",
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  parseUsage(event: Record<string, unknown>): { totalTokens: number; contextWindow: number | null } | null {
    // Codex exec --json emits `{ type: "turn.completed", usage: {...} }` per turn.
    // Total context fill ≈ input_tokens + cached_input_tokens (Codex's `input_tokens` is
    // the *new* input only; cached inputs are billed separately but still occupy the window).
    // No context_window field is emitted — orchestrator will fall back to the model lookup.
    if (event.type !== "turn.completed") {
      return null;
    }
    const usage = event.usage as Record<string, unknown> | undefined;
    if (!usage) {
      return null;
    }
    const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const cached = typeof usage.cached_input_tokens === "number" ? usage.cached_input_tokens : 0;
    const total = input + cached;
    if (total <= 0) {
      return null;
    }
    return { totalTokens: total, contextWindow: null };
  }

  parseStopReason(event: Record<string, unknown>): StopReason | null {
    if (event.type === "turn.completed") {
      return "complete";
    }
    if (event.type === "turn.failed") {
      const error = event.error as { type?: string } | undefined;
      if (
        error?.type === "context_length_exceeded" ||
        error?.type === "max_output_tokens"
      ) {
        return "truncated";
      }
      return "aborted";
    }
    return null;
  }

  parseAssistantDelta(event: Record<string, unknown>) {
    const item = event.item as { type?: string; text?: string } | undefined;

    // Reasoning items are surfaced via parseActivityLine into the thinking bubble,
    // so they must not leak into the assistant's visible text output.
    if (item?.type === "reasoning") {
      return "";
    }

    const delta =
      typeof event.delta === "string"
        ? event.delta
        : typeof event.text === "string"
          ? event.text
          : typeof (event.output_text as string | undefined) === "string"
            ? (event.output_text as string)
            : "";

    if (
      (event.type === "response.output_text.delta" || event.type === "item.delta" || event.type === "agent_message.delta") &&
      delta
    ) {
      return delta;
    }

    if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
      const text = item.text.trim();
      if (text.length === 0) return "";
      const prefix = this.hadPriorTextTurn ? "\n\n" : "";
      this.hadPriorTextTurn = true;
      return prefix + text;
    }

    return "";
  }
}

export const codexRuntime = new CodexRuntime();
