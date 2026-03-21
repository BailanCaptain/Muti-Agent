import { BaseCliRuntime, resolveNodeScript, wrapPromptWithInstructions, type AgentRunInput, type RuntimeCommand } from "./base-runtime";
import { AGENT_SYSTEM_PROMPTS } from "./agent-prompts";

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
