import type { ToolEvent } from "@multi-agent/shared";
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

// F004/B006 第三版：不再对 Gemini stderr 做 RESOURCE_EXHAUSTED fast-fail。
// 历史：B002 时基于"RESOURCE_EXHAUSTED 不可恢复"的假设加了 match-once-kill；
//       F004 第二版把 threshold 放宽到 2 想救 transient 抖动；
//       实测（Codex 2026-04-11 6/6 PowerShell 直跑）发现 Gemini CLI 内置 retry
//       循环（10 次 × 5-30s）可以跨越 2 次甚至 3 次连续 429 自行恢复。
//       我们的 fast-fail 和 CLI 的 retry 在抢同一个语义，任何有限 threshold 都会
//       把本可恢复的请求提前砍掉。上一层的修复是相信 CLI 的 retry 循环，由
//       liveness probe 兜底真正卡死（B002 原始症状）的场景。
//
// GeminiRuntime 因此不覆写 classifyStderrChunk —— 继承 base 的 return null。

export class GeminiRuntime extends BaseCliRuntime {
  readonly agentId = "gemini";

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
    const args = ["--output-format", "stream-json", "--approval-mode", "yolo"];
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
      shell: runtime.shell,
      stdinContent: prompt,
    };
  }

  parseActivityLine(_event: Record<string, unknown>): string | null {
    return null;
  }

  transformToolEvent(event: Record<string, unknown>): ToolEvent | null {
    try {
      if (event.type === "tool_use") {
        const toolName = String(event.tool_name ?? "");
        const params = (event.parameters ?? {}) as Record<string, unknown>;
        return {
          type: "tool_use",
          toolName,
          toolInput: formatGeminiParams(toolName, params),
          status: "started",
          timestamp: new Date().toISOString(),
        };
      }

      if (event.type === "tool_result") {
        const status = event.status as string | undefined;
        const output = event.output as string | undefined;
        return {
          type: "tool_result",
          toolName: "",
          content: (output ?? "").split("\n")[0].slice(0, 200) || "done",
          status: status === "error" ? "error" : "completed",
          timestamp: new Date().toISOString(),
        };
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
