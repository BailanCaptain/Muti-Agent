import { BaseCliRuntime, resolveNodeScript, wrapPromptWithInstructions, type AgentRunInput, type RuntimeCommand, type StopReason } from "./base-runtime";
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

// Gemini CLI enters a 10-attempt backoff loop (5-30s between tries, ~4 minutes total)
// when the API returns 429 RESOURCE_EXHAUSTED. The liveness probe will eventually kill
// it on CPU-idle stall, but we can do better: the very first stderr line carries the
// exhausted-quota reason, so we can abort on sight and hand control back to the user.
//
// Patterns cover the common variants we've seen: Google API error envelope, Gemini
// CLI's own retry log line, and the short-form RESOURCE_EXHAUSTED token.
const GEMINI_FAST_FAIL_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  { regex: /RESOURCE_EXHAUSTED/i, reason: "Google API RESOURCE_EXHAUSTED（配额/容量耗尽）" },
  { regex: /MODEL_CAPACITY_EXHAUSTED/i, reason: "模型容量已打满（MODEL_CAPACITY_EXHAUSTED）" },
  { regex: /quota exceeded for quota metric/i, reason: "配额已超上限（quota exceeded）" },
  { regex: /429 Too Many Requests/i, reason: "上游 429 限流（Too Many Requests）" }
];

export class GeminiRuntime extends BaseCliRuntime {
  readonly agentId = "gemini";

  classifyStderrChunk(chunk: string): { reason: string } | null {
    for (const { regex, reason } of GEMINI_FAST_FAIL_PATTERNS) {
      if (regex.test(chunk)) {
        return { reason };
      }
    }
    return null;
  }

  protected buildCommand(input: AgentRunInput): RuntimeCommand {
    const runtime = resolveNodeScript(
      "@google/gemini-cli",
      [["dist", "index.js"], ["bundle", "gemini.js"]],
      "gemini",
    );
    const sessionId = input.env?.MULTI_AGENT_NATIVE_SESSION_ID;
    // 会话已恢复时模型已有指令，不重复附加，减少每轮 ~500 token 的额外开销。
    const systemPrompt = input.env?.MULTI_AGENT_SYSTEM_PROMPT || AGENT_SYSTEM_PROMPTS.gemini;
    const prompt = sessionId
      ? input.prompt
      : wrapPromptWithInstructions(systemPrompt, input.prompt);
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

  parseUsage(event: Record<string, unknown>): { totalTokens: number; contextWindow: number | null } | null {
    // Gemini CLI emits a final `{ type: "result", status: "success", stats: {...} }` event
    // at turn close. `stats.total_tokens` is the cumulative usage; `stats.context_window`
    // (when present) is the model's window — use it verbatim because it reflects the
    // exact model variant the CLI routed to, not our guess.
    if (event.type !== "result" || event.status !== "success") {
      return null;
    }
    const stats = event.stats as Record<string, unknown> | undefined;
    if (!stats) {
      return null;
    }
    const total = typeof stats.total_tokens === "number" ? stats.total_tokens : null;
    if (total == null || total <= 0) {
      return null;
    }
    const windowRaw =
      (typeof stats.context_window === "number" ? stats.context_window : undefined) ??
      (typeof stats.contextWindow === "number" ? stats.contextWindow : undefined);
    const contextWindow = typeof windowRaw === "number" && windowRaw > 0 ? windowRaw : null;
    return { totalTokens: total, contextWindow };
  }

  parseStopReason(event: Record<string, unknown>): StopReason | null {
    if (event.type !== "result") return null;
    const topLevel =
      typeof event.finishReason === "string" ? (event.finishReason as string) : null;
    const stats = event.stats as Record<string, unknown> | undefined;
    const nested =
      typeof stats?.finishReason === "string" ? (stats.finishReason as string) : null;
    const raw = topLevel ?? nested;
    if (!raw) return null;
    switch (raw.toUpperCase()) {
      case "STOP":
      case "END_TURN":
        return "complete";
      case "MAX_TOKENS":
        return "truncated";
      case "SAFETY":
      case "RECITATION":
        return "refused";
      default:
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
