import crypto from "node:crypto";
import type { Provider, TokenUsageSnapshot, ToolEvent } from "@multi-agent/shared";
import { SEAL_THRESHOLDS_BY_PROVIDER, getContextWindowForModel } from "@multi-agent/shared";
import {
  findSessionId,
  parseEventModel,
  type AgentRunInput,
  type BaseCliRuntime,
  type RuntimeLifecycleConfig,
  type StopReason,
} from "./base-runtime";
import type { LivenessWarning } from "./liveness-probe";
import { claudeRuntime } from "./claude-runtime";
import { codexRuntime } from "./codex-runtime";
import { createEventRecorder } from "./event-recorder";
import { geminiRuntime } from "./gemini-runtime";
import { buildSystemPromptWithHints } from "./agent-prompts";

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
  /**
   * F019 P3: Per-invocation 告示牌 hint. When set (and systemPrompt is NOT
   * explicitly provided), cli-orchestrator builds the effective system prompt
   * via buildSystemPromptWithHints so the SOP one-liner appears at the end.
   * When systemPrompt is explicitly set by caller (e.g., A2A fan-out path),
   * sopStageHint is ignored — caller is fully responsible.
   */
  sopStageHint?: {
    featureId: string;
    stage: string;
    suggestedSkill: string | null;
  };
  onAssistantDelta: (delta: string) => void;
  onSession: (nativeSessionId: string) => void;
  onModel: (model: string) => void;
  onActivity?: (activity: { stream: "stdout" | "stderr"; at: string; chunk: string }) => void;
  onToolActivity?: (line: string) => void;
  onToolEvent?: (event: ToolEvent) => void;
  onLivenessWarning?: (warning: LivenessWarning) => void;
  onUsageSnapshot?: (snapshot: TokenUsageSnapshot) => void;
  /**
   * Test hook: override the provider-keyed runtime adapter with a specific
   * instance. Production callers should omit this — the provider field selects
   * the singleton adapter by default.
   */
  runtime?: BaseCliRuntime;
  /**
   * Test hook: override the default 5-minute inactivity lifecycle so tests
   * don't hang waiting for the heartbeat timer.
   */
  lifecycle?: Partial<RuntimeLifecycleConfig>;
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
  stopReason: StopReason | null;
  /** Set by message-service when CLI self-compression detected (F-BLOAT) */
  fBloatDetected?: boolean;
  toolEvents: ToolEvent[];
};

const runtimeAdapters = {
  codex: codexRuntime,
  claude: claudeRuntime,
  gemini: geminiRuntime
} as const;

export function runTurn(options: RunTurnOptions) {
  const prompt = options.userMessage;

  const runtime = options.runtime ?? runtimeAdapters[options.provider];

  // F019 P3: Resolve the effective system prompt.
  // sopStageHint, when present, is ALWAYS appended as a 告示牌 one-liner —
  // whether the base prompt came from options.systemPrompt (A2A / direct-turn
  // assembled) or from AGENT_SYSTEM_PROMPTS[provider] fallback. The hint is
  // additive, not overriding.
  let effectiveSystemPrompt = options.systemPrompt ?? "";
  if (options.sopStageHint) {
    const { featureId, stage, suggestedSkill } = options.sopStageHint;
    const suffix = suggestedSkill ? ` → load skill: ${suggestedSkill}` : "";
    const sopLine = `SOP: ${featureId} stage=${stage}${suffix}`;
    if (effectiveSystemPrompt) {
      // Append to caller-provided base (direct-turn or A2A path).
      effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n${sopLine}`;
    } else {
      // Fallback path: start from the static provider base and add hint.
      effectiveSystemPrompt = buildSystemPromptWithHints(options.provider, {
        sopStageHint: options.sopStageHint,
      });
    }
  }

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
      MULTI_AGENT_SYSTEM_PROMPT: effectiveSystemPrompt
    }
  };

  let cancelled = false;
  let content = "";
  let currentModel = options.model;
  let currentSessionId = options.nativeSessionId;
  let latestUsage: TokenUsageSnapshot | null = null;
  let latestStopReason: StopReason | null = null;
  const toolEvents: ToolEvent[] = [];
  const { record } = createEventRecorder(options.provider);

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
        const toolEvent = runtime.transformToolEvent(event);
        if (toolEvent) {
          toolEvents.push(toolEvent);
          options.onToolEvent?.(toolEvent);
        }
        const sessionId = findSessionId(event);
        const eventModel = parseEventModel(event);
        const usageRaw = runtime.parseUsage(event);
        const stopReason = runtime.parseStopReason(event);
        if (stopReason !== null) {
          latestStopReason = stopReason;
        }

        record({
          ts: new Date().toISOString(),
          stream: "stdout",
          raw: event,
          classified: {
            delta: delta ? `[${delta.length} chars]` : null,
            activity: activityLine || null,
            toolEvent: toolEvent || null,
            sessionId: sessionId || null,
            model: eventModel || null,
            hasUsage: !!usageRaw,
            stopReason: stopReason ?? null,
          },
        });

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
        record({ ts: new Date().toISOString(), stream: "stdout_unparsed", line });
      }
    },
    onActivity(activity) {
      record({ ts: new Date().toISOString(), stream: activity.stream, chunk: activity.chunk });
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
    promise: handle.promise.then(async (output) => {
      // Post-run hook: runtimes that carry thinking/activity outside the stdout
      // stream (Gemini's local session file) emit it here into the same
      // onToolActivity pipe Claude/Codex thinking uses.
      try {
        await runtime.afterRun({ sessionId: currentSessionId }, (line) => {
          options.onToolActivity?.(line);
        });
      } catch {
        // afterRun is best-effort; never let post-run bookkeeping fail the turn.
      }
      return {
        content,
        nativeSessionId: currentSessionId,
        currentModel,
        stopped: cancelled,
        rawStdout: output.rawStdout,
        rawStderr: output.rawStderr,
        exitCode: output.exitCode,
        usage: latestUsage,
        sealDecision: computeSealDecision(options.provider, latestUsage),
        stopReason: latestStopReason ?? output.stopReason,
        toolEvents,
      };
    })
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
