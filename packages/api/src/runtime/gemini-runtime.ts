import { BaseCliRuntime, resolveNodeScript, wrapPromptWithInstructions, type AgentRunInput, type RuntimeCommand } from "./base-runtime";
import { AGENT_SYSTEM_PROMPTS } from "./agent-prompts";

function formatGeminiParams(toolName: string, params: Record<string, unknown>): string {
  try {
    if ("command" in params) {
      return `$ ${String(params.command).split("\n")[0].slice(0, 80)}`;
    }

    if ("file_path" in params) {
      const fp = String(params.file_path);
      return fp.split(/[/\\]/).slice(-2).join("/");
    }

    if ("path" in params) {
      const p = String(params.path);
      return p.split(/[/\\]/).slice(-2).join("/");
    }

    if ("pattern" in params) {
      return String(params.pattern).slice(0, 40);
    }

    if ("query" in params) {
      return String(params.query).slice(0, 60);
    }

    // Default: first string value
    for (const value of Object.values(params)) {
      if (typeof value === "string") {
        return value.slice(0, 60);
      }
    }

    return "";
  } catch {
    return "";
  }
}

export class GeminiRuntime extends BaseCliRuntime {
  readonly agentId = "gemini";

  protected buildCommand(input: AgentRunInput): RuntimeCommand {
    const runtime = resolveNodeScript("@google/gemini-cli", ["dist", "index.js"]);
    const sessionId = input.env?.MULTI_AGENT_NATIVE_SESSION_ID;
    // 会话已恢复时模型已有指令，不重复附加，减少每轮 ~500 token 的额外开销。
    const prompt = sessionId
      ? input.prompt
      : wrapPromptWithInstructions(AGENT_SYSTEM_PROMPTS.gemini, input.prompt);
    const args = ["-p", prompt, "--output-format", "stream-json", "--approval-mode", "yolo"];
    const model = input.env?.MULTI_AGENT_MODEL;

    if (model) {
      args.push("--model", model);
    }
    if (sessionId) {
      args.push("--resume", sessionId);
    }

    return {
      command: runtime.command,
      args: [...runtime.prefixArgs, ...args],
      shell: runtime.shell
    };
  }

  parseActivityLine(event: Record<string, unknown>): string | null {
    try {
      if (event.type === "tool_use") {
        const toolName = String(event.tool_name ?? "");
        const params = (event.parameters ?? {}) as Record<string, unknown>;
        const summary = formatGeminiParams(toolName, params);
        return `⚡ ${toolName} ${summary}`.trimEnd();
      }

      if (event.type === "tool_result") {
        const status = event.status as string | undefined;
        const output = event.output as string | undefined;
        if (status === "error") {
          const firstLine = (output ?? "").split("\n")[0].slice(0, 100);
          return `✗ ${firstLine}`;
        }
        if (output && output.trim()) {
          return `✓ ${output.split("\n")[0].slice(0, 100)}`;
        }
        return "✓ done";
      }

      return null;
    } catch {
      return null;
    }
  }

  parseAssistantDelta(event: Record<string, unknown>) {
    if (typeof event.delta === "string") {
      return event.delta;
    }

    if (event.type === "content" && typeof event.value === "string") {
      return event.value;
    }

    if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
      return event.content;
    }

    if (
      event.type === "message" &&
      typeof event.content === "object" &&
      event.content &&
      typeof (event.content as { text?: string }).text === "string"
    ) {
      return (event.content as { text: string }).text;
    }

    if (
      event.type === "message" &&
      typeof event.delta === "object" &&
      event.delta &&
      typeof (event.delta as { text?: string }).text === "string"
    ) {
      return (event.delta as { text: string }).text;
    }

    return "";
  }
}

export const geminiRuntime = new GeminiRuntime();
