import { existsSync } from "node:fs";
import path from "node:path";
import { BaseCliRuntime, resolveNpmRoot, wrapPromptWithInstructions, type AgentRunInput, type RuntimeCommand } from "./base-runtime";
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
    const sessionId = input.env?.MULTI_AGENT_NATIVE_SESSION_ID;
    // 会话已恢复时模型已有指令，不重复附加，减少每轮 ~500 token 的额外开销。
    const prompt = sessionId
      ? input.prompt
      : wrapPromptWithInstructions(AGENT_SYSTEM_PROMPTS.codex, input.prompt);
    const topLevelArgs = [
      ...(model ? ["-m", model] : []),
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
      const item = event.item as { type?: string; command?: string; output?: string; path?: string } | undefined;

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

  parseAssistantDelta(event: Record<string, unknown>) {
    const item = event.item as { type?: string; text?: string } | undefined;
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
