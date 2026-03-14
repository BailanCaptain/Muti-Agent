import {
  BaseCliRuntime,
  buildCallbackPrompt,
  resolveNodeScript,
  wrapPromptWithInstructions,
  type AgentRunInput,
  type RuntimeCommand
} from "./base-runtime";

export class GeminiRuntime extends BaseCliRuntime {
  readonly agentId = "gemini";

  protected buildCommand(input: AgentRunInput): RuntimeCommand {
    const runtime = resolveNodeScript("@google/gemini-cli", ["dist", "index.js"]);
    const instructions = [input.env?.MULTI_AGENT_SYSTEM_PROMPT ?? "", buildCallbackPrompt("Gemini")].filter(Boolean).join(
      "\n\n"
    );
    const args = [
      "-p",
      wrapPromptWithInstructions(instructions, input.prompt),
      "--output-format",
      "stream-json",
      "--approval-mode",
      "yolo",
      "--sandbox",
      "true"
    ];
    const model = input.env?.MULTI_AGENT_MODEL;
    const sessionId = input.env?.MULTI_AGENT_NATIVE_SESSION_ID;

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
