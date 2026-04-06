import crypto from "node:crypto";
import type { Provider, TokenUsageSnapshot } from "@multi-agent/shared";
import { SEAL_THRESHOLDS_BY_PROVIDER, getContextWindowForModel } from "@multi-agent/shared";
import { findSessionId, parseEventModel, type AgentRunInput } from "./base-runtime";
import type { LivenessWarning } from "./liveness-probe";
import { claudeRuntime } from "./claude-runtime";
import { codexRuntime } from "./codex-runtime";
import { geminiRuntime } from "./gemini-runtime";

export type RunTurnOptions = {
  invocationId?: string;
  threadId: string;
  provider: Provider;
  agentId?: string;
  apiBaseUrl?: string;
  callbackToken?: string;
  model: string | null;
  effort: string | null;
  nativeSessionId: string | null;
  userMessage: string;
  systemPrompt?: string;
  onAssistantDelta: (delta: string) => void;
  onSession: (nativeSessionId: string) => void;
  onModel: (model: string) => void;
  onActivity?: (activity: { stream: "stdout" | "stderr"; at: string; chunk: string }) => void;
  onToolActivity?: (line: string) => void;
  onLivenessWarning?: (warning: LivenessWarning) => void;
  onUsageSnapshot?: (snapshot: TokenUsageSnapshot) => void;
};

export type SealDecision = {
  shouldSeal: boolean;
  reason: "threshold" | "warn" | null;
  fillRatio: number;
  usage: TokenUsageSnapshot;
};

export type RunTurnResult = {
  content: string;
  nativeSessionId: string | null;
  currentModel: string | null;
  stopped: boolean;
  rawStdout: string;
  rawStderr: string;
  exitCode: number | null;
  usage: TokenUsageSnapshot | null;
  sealDecision: SealDecision | null;
};

const runtimeAdapters = {
  codex: codexRuntime,
  claude: claudeRuntime,
  gemini: geminiRuntime
} as const;

export function runTurn(options: RunTurnOptions) {
  const prompt = options.userMessage;

  const runtime = runtimeAdapters[options.provider];

  const input: AgentRunInput = {
    invocationId: options.invocationId ?? crypto.randomUUID(),
    threadId: options.threadId,
    agentId: options.agentId ?? options.provider,
    prompt,
    env: {
      // Callback credentials and model/session context travel through env because each CLI exposes a different shell surface.
      MULTI_AGENT_API_URL: options.apiBaseUrl ?? "",
      MULTI_AGENT_INVOCATION_ID: options.invocationId ?? "",
      MULTI_AGENT_CALLBACK_TOKEN: options.callbackToken ?? "",
      MULTI_AGENT_MODEL: options.model ?? "",
      MULTI_AGENT_EFFORT: options.effort ?? "",
      MULTI_AGENT_NATIVE_SESSION_ID: options.nativeSessionId ?? "",
      MULTI_AGENT_SYSTEM_PROMPT: options.systemPrompt ?? ""
    }
  };

  let cancelled = false;
  let content = "";
  let currentModel = options.model;
  let currentSessionId = options.nativeSessionId;
  let latestUsage: TokenUsageSnapshot | null = null;

  const handle = runtime.runStream(input, {
    onStdoutLine(line) {
      if (!line.trim()) {
        return;
      }

      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const delta = runtime.parseAssistantDelta(event);
        const activityLine = runtime.parseActivityLine(event);
        if (activityLine) {
          options.onToolActivity?.(activityLine);
        }
        const sessionId = findSessionId(event);
        const eventModel = parseEventModel(event);
        const usageRaw = runtime.parseUsage(event);

        if (delta) {
          content += delta;
          options.onAssistantDelta(delta);
        }

        if (sessionId && sessionId !== currentSessionId) {
          currentSessionId = sessionId;
          options.onSession(sessionId);
        }

        if (eventModel && eventModel !== currentModel) {
          currentModel = eventModel;
          options.onModel(eventModel);
        }

        if (usageRaw) {
          // Resolve contextWindow: prefer the value the CLI echoed; fall back to the
          // per-model lookup; give up if neither is available (can't compute fillRatio
          // without a window, and guessing here would cause false-positive seals).
          const windowTokens = usageRaw.contextWindow ?? getContextWindowForModel(currentModel);
          if (windowTokens && windowTokens > 0 && usageRaw.totalTokens > 0) {
            const snapshot: TokenUsageSnapshot = {
              usedTokens: usageRaw.totalTokens,
              windowTokens,
              source: usageRaw.contextWindow != null ? "exact" : "approx"
            };
            latestUsage = snapshot;
            options.onUsageSnapshot?.(snapshot);
          }
        }
      } catch {
        // Non-JSON line: startup noise, debug output, or partial write — ignore.
      }
    },
    onActivity(activity) {
      options.onActivity?.(activity);
    },
    onLivenessWarning(warning) {
      options.onLivenessWarning?.(warning);
    }
  });

  return {
    cancel() {
      cancelled = true;
      handle.cancel();
    },
    promise: handle.promise.then((output) => ({
      content,
      nativeSessionId: currentSessionId,
      currentModel,
      stopped: cancelled,
      rawStdout: output.rawStdout,
      rawStderr: output.rawStderr,
      exitCode: output.exitCode,
      usage: latestUsage,
      sealDecision: computeSealDecision(options.provider, latestUsage)
    }))
  };
}

export function computeSealDecision(
  provider: Provider,
  usage: TokenUsageSnapshot | null
): SealDecision | null {
  if (!usage) {
    return null;
  }
  const thresholds = SEAL_THRESHOLDS_BY_PROVIDER[provider];
  const fillRatio = Math.min(usage.usedTokens / usage.windowTokens, 1.0);
  if (fillRatio >= thresholds.action) {
    return { shouldSeal: true, reason: "threshold", fillRatio, usage };
  }
  if (fillRatio >= thresholds.warn) {
    return { shouldSeal: false, reason: "warn", fillRatio, usage };
  }
  return { shouldSeal: false, reason: null, fillRatio, usage };
}
