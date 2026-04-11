import { existsSync } from "node:fs";
import path from "node:path";
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

  protected buildCommand(input: AgentRunInput): RuntimeCommand {
    const runtime = resolveCodexCommand();
    const model = input.env?.MULTI_AGENT_MODEL;
    const effort = input.env?.MULTI_AGENT_EFFORT;
    const sessionId = input.env?.MULTI_AGENT_NATIVE_SESSION_ID;
    // 会话已恢复时模型已有指令，不重复附加，减少每轮 ~500 token 的额外开销。
    const systemPrompt = input.env?.MULTI_AGENT_SYSTEM_PROMPT || AGENT_SYSTEM_PROMPTS.codex;
    const prompt = sessionId
      ? input.prompt
      : wrapPromptWithInstructions(systemPrompt, input.prompt);
    const topLevelArgs = [
      ...(model ? ["-m", model] : []),
      ...(effort ? ["--config", `model_reasoning_effort="${effort}"`] : []),
      "--config", 'approval_policy="on-request"',
      "--sandbox", "workspace-write",
    ];
    const baseArgs = sessionId
      ? ["exec", "resume", "--skip-git-repo-check", "--json", sessionId, prompt]
      : ["exec", "--skip-git-repo-check", "--json", prompt];

    return {
      command: runtime.command,
      args: [...runtime.prefixArgs, ...topLevelArgs, ...baseArgs],
      shell: runtime.shell
    };
  }

  parseActivityLine(event: Record<string, unknown>): string | null {
    try {
      const type = event.type as string | undefined;
      const item = event.item as { type?: string; command?: string; output?: string; path?: string; text?: string } | undefined;

      if (!type || !item) {
        return null;
      }

      const itemType = item.type;

      if (itemType === "todo_list") {
        return null;
      }

      if (type === "turn.completed") {
        return null;
      }

      // Reasoning models (gpt-5/5.4) silently think for seconds before first output token.
      // Surfacing the started marker + the final reasoning text into the thinking bubble
      // gives the user visible feedback during what would otherwise be a dead-air gap.
      if (type === "item.started" && itemType === "reasoning") {
        return "🧠 正在推理...";
      }

      if (type === "item.completed" && itemType === "reasoning") {
        const text = (item.text ?? "").trim();
        return text ? text : null;
      }

      if ((type === "item.started") && itemType === "command_execution") {
        const cmd = (item.command ?? "").split("\n")[0].slice(0, 100);
        return `$ ${cmd}`;
      }

      if (type === "item.completed" && itemType === "command_execution") {
        const cmd = (item.command ?? "").split("\n")[0].slice(0, 100);
        const output = item.output ?? "";
        const firstOutputLine = output.split("\n")[0].slice(0, 60);
        return firstOutputLine ? `✓ ${cmd} → ${firstOutputLine}` : `✓ ${cmd}`;
      }

      if (type === "item.completed" && itemType === "file_change") {
        const filePath = item.path ?? "";
        const shortPath = filePath.split(/[/\\]/).slice(-2).join("/");
        return `📝 ${shortPath}`;
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
      return item.text;
    }

    return "";
  }
}

export const codexRuntime = new CodexRuntime();
