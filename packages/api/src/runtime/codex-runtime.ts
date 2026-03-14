import { existsSync } from "node:fs";
import path from "node:path";
import {
  BaseCliRuntime,
  buildCallbackPrompt,
  resolveNpmRoot,
  wrapPromptWithInstructions,
  type AgentRunInput,
  type RuntimeCommand
} from "./base-runtime";

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
      : (() => {
          const instructions = [input.env?.MULTI_AGENT_SYSTEM_PROMPT ?? "", buildCallbackPrompt("Codex")]
            .filter(Boolean)
            .join("\n\n");
          return wrapPromptWithInstructions(instructions, input.prompt);
        })();
    const topLevelArgs = [...(model ? ["-m", model] : []), "-a", "never", "-s", "workspace-write"];
    const baseArgs = sessionId
      ? ["exec", "resume", "--skip-git-repo-check", "--json", sessionId, prompt]
      : ["exec", "--skip-git-repo-check", "--json", prompt];

    return {
      command: runtime.command,
      args: [...runtime.prefixArgs, ...topLevelArgs, ...baseArgs],
      shell: runtime.shell
    };
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
