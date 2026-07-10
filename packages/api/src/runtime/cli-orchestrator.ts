import crypto from "node:crypto"
import type { Provider, TokenUsageSnapshot, ToolEvent, UsageDetail } from "@multi-agent/shared"
import { SEAL_THRESHOLDS_BY_PROVIDER, getContextWindowForModel } from "@multi-agent/shared"
import { buildSystemPromptWithHints } from "./agent-prompts"
import {
  type AgentRunInput,
  type BaseCliRuntime,
  type ParsedUsage,
  type RuntimeLifecycleConfig,
  type StopReason,
  findSessionId,
  parseEventModel,
} from "./base-runtime"
import { claudeRuntime } from "./claude-runtime"
import { codexRuntime } from "./codex-runtime"
import { createEventRecorder } from "./event-recorder"
import { geminiRuntime } from "./gemini-runtime"
import type { LivenessWarning } from "./liveness-probe"
import type { ResolvedSealThresholds } from "./seal-config-resolver"

export type RunTurnOptions = {
  invocationId?: string
  threadId: string
  provider: Provider
  agentId?: string
  apiBaseUrl?: string
  callbackToken?: string
  model: string | null
  effort: string | null
  nativeSessionId: string | null
  userMessage: string
  systemPrompt?: string
  /**
   * F019 P3: Per-invocation 告示牌 hint. When set (and systemPrompt is NOT
   * explicitly provided), cli-orchestrator builds the effective system prompt
   * via buildSystemPromptWithHints so the SOP one-liner appears at the end.
   * When systemPrompt is explicitly set by caller (e.g., A2A fan-out path),
   * sopStageHint is ignored — caller is fully responsible.
   */
  sopStageHint?: {
    featureId: string
    stage: string
    suggestedSkill: string | null
  }
  onAssistantDelta: (delta: string) => void
  onSession: (nativeSessionId: string) => void
  onModel: (model: string) => void
  onActivity?: (activity: { stream: "stdout" | "stderr"; at: string; chunk: string }) => void
  onToolActivity?: (line: string) => void
  onToolEvent?: (event: ToolEvent) => void
  onLivenessWarning?: (warning: LivenessWarning) => void
  onUsageSnapshot?: (snapshot: TokenUsageSnapshot) => void
  /**
   * F021 Phase 6: User-resolved seal thresholds (会话覆盖 → 全局 → 代码 fallback).
   * When omitted, computeSealDecision falls back to SEAL_THRESHOLDS_BY_PROVIDER.
   * message-service is responsible for calling resolveSealThresholds and passing
   * the resolved value here.
   */
  sealThresholds?: ResolvedSealThresholds
  /**
   * F021 Phase 6: User-set context window override (session > global). When set,
   * trumps both the CLI's self-reported window and the model-prefix fallback.
   * Reasoning: user override expresses an explicit intent ("model upgraded, the
   * real window is 2M now") and shouldn't be silently overridden by stale CLI
   * mappings.
   */
  contextWindowOverride?: number
  /**
   * Test hook: override the provider-keyed runtime adapter with a specific
   * instance. Production callers should omit this — the provider field selects
   * the singleton adapter by default.
   */
  runtime?: BaseCliRuntime
  /**
   * Test hook: override the default 5-minute inactivity lifecycle so tests
   * don't hang waiting for the heartbeat timer.
   */
  lifecycle?: Partial<RuntimeLifecycleConfig>
}

export type SealDecision = {
  shouldSeal: boolean
  reason: "threshold" | "warn" | null
  fillRatio: number
  usage: TokenUsageSnapshot
}

export type RunTurnResult = {
  content: string
  nativeSessionId: string | null
  currentModel: string | null
  stopped: boolean
  rawStdout: string
  rawStderr: string
  exitCode: number | null
  usage: TokenUsageSnapshot | null
  /**
   * F043：整轮累计计费值（claude result.usage 求和口径）。与 usage（当前上下文足迹）
   * 语义不同源 —— 只供统计/落库展示（P1），绝不参与 seal 判定。
   */
  turnTotals?: { totalTokens: number; detail?: UsageDetail } | null
  sealDecision: SealDecision | null
  stopReason: StopReason | null
  /** Set by message-service when CLI self-compression detected (F-BLOAT) */
  fBloatDetected?: boolean
  toolEvents: ToolEvent[]
}

const runtimeAdapters = {
  codex: codexRuntime,
  claude: claudeRuntime,
  gemini: geminiRuntime,
} as const

export function runTurn(options: RunTurnOptions) {
  const prompt = options.userMessage

  const runtime = options.runtime ?? runtimeAdapters[options.provider]

  // F019 P3: Resolve the effective system prompt.
  // sopStageHint, when present, is ALWAYS appended as a 告示牌 one-liner —
  // whether the base prompt came from options.systemPrompt (A2A / direct-turn
  // assembled) or from AGENT_SYSTEM_PROMPTS[provider] fallback. The hint is
  // additive, not overriding.
  let effectiveSystemPrompt = options.systemPrompt ?? ""
  if (options.sopStageHint) {
    const { featureId, stage, suggestedSkill } = options.sopStageHint
    const suffix = suggestedSkill ? ` → load skill: ${suggestedSkill}` : ""
    const sopLine = `SOP: ${featureId} stage=${stage}${suffix}`
    if (effectiveSystemPrompt) {
      // Append to caller-provided base (direct-turn or A2A path).
      effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n${sopLine}`
    } else {
      // Fallback path: start from the static provider base and add hint.
      effectiveSystemPrompt = buildSystemPromptWithHints(options.provider, {
        sopStageHint: options.sopStageHint,
      })
    }
  }

  const input: AgentRunInput = {
    invocationId: options.invocationId ?? crypto.randomUUID(),
    threadId: options.threadId,
    agentId: options.agentId ?? options.provider,
    prompt,
    // F023 Task 7 根因 A：runtime spawn 必须显式传当前进程 cwd，才能让
    // 三家 CLI 解析项目级 MCP 配置（.mcp.json / .codex/config.toml /
    // .gemini/settings.json）里的相对路径到本 worktree 自己的 dist。
    cwd: process.cwd(),
    env: {
      // Callback credentials and model/session context travel through env because each CLI exposes a different shell surface.
      MULTI_AGENT_API_URL: options.apiBaseUrl ?? "",
      MULTI_AGENT_INVOCATION_ID: options.invocationId ?? "",
      MULTI_AGENT_CALLBACK_TOKEN: options.callbackToken ?? "",
      MULTI_AGENT_MODEL: options.model ?? "",
      MULTI_AGENT_EFFORT: options.effort ?? "",
      MULTI_AGENT_NATIVE_SESSION_ID: options.nativeSessionId ?? "",
      MULTI_AGENT_SYSTEM_PROMPT: effectiveSystemPrompt,
    },
  }

  let cancelled = false
  let content = ""
  let currentModel = options.model
  let currentSessionId = options.nativeSessionId
  let latestUsage: TokenUsageSnapshot | null = null
  let latestStopReason: StopReason | null = null
  // F043 scope 路由三状态：context 足迹与 turn_total 计费分域，绝不混装。
  // latestExactWindow 跨事件保持 —— result 的 modelUsage 窗口常晚于末次 message_start
  // 到达，重建式 buildSnapshot 保证窗口升级不丢已有足迹。
  let latestContextParsed: ParsedUsage | null = null
  let latestExactWindow: number | null = null
  let turnTotals: ParsedUsage | null = null
  const toolEvents: ToolEvent[] = []
  const { record } = createEventRecorder(options.provider)

  // F021 Phase 6 优先级保持：user override（会话>全局）> CLI 自报 > model 兜底表。
  // F043 source 语义升级：exact 仅当分子为真足迹（parsed.exact）且窗口来自 CLI 自报。
  const buildSnapshot = (): TokenUsageSnapshot | null => {
    if (!latestContextParsed || latestContextParsed.totalTokens <= 0) {
      return null
    }
    const windowTokens =
      options.contextWindowOverride ?? latestExactWindow ?? getContextWindowForModel(currentModel)
    if (!windowTokens || windowTokens <= 0) {
      return null
    }
    return {
      usedTokens: latestContextParsed.totalTokens,
      windowTokens,
      source: latestContextParsed.exact && latestExactWindow != null ? "exact" : "approx",
      ...(latestContextParsed.detail ? { detail: latestContextParsed.detail } : {}),
    }
  }

  const ingestParsedUsage = (parsed: ParsedUsage) => {
    if (parsed.contextWindow != null && parsed.contextWindow > 0) {
      latestExactWindow = parsed.contextWindow
    }
    if (parsed.modelWindows) {
      const matched = pickModelWindow(parsed.modelWindows, currentModel)
      if (matched != null) {
        latestExactWindow = matched
      }
    }
    if (parsed.scope === "turn_total") {
      turnTotals = parsed
    } else {
      latestContextParsed = parsed
    }
    const rebuilt = buildSnapshot()
    if (rebuilt) {
      latestUsage = rebuilt
      options.onUsageSnapshot?.(rebuilt)
    }
  }

  const handle = runtime.runStream(input, {
    onStdoutLine(line) {
      if (!line.trim()) {
        return
      }

      try {
        const event = JSON.parse(line) as Record<string, unknown>
        const delta = runtime.parseAssistantDelta(event)
        const activityLine = runtime.parseActivityLine(event)
        if (activityLine) {
          options.onToolActivity?.(activityLine)
        }
        const toolEvent = runtime.transformToolEvent(event)
        if (toolEvent) {
          toolEvents.push(toolEvent)
          options.onToolEvent?.(toolEvent)
        }
        const sessionId = findSessionId(event)
        const eventModel = parseEventModel(event)
        const usageRaw = runtime.parseUsage(event)
        const stopReason = runtime.parseStopReason(event)
        if (stopReason !== null) {
          latestStopReason = stopReason
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
        })

        if (delta) {
          content += delta
          options.onAssistantDelta(delta)
        }

        if (sessionId && sessionId !== currentSessionId) {
          currentSessionId = sessionId
          options.onSession(sessionId)
        }

        if (eventModel && eventModel !== currentModel) {
          currentModel = eventModel
          options.onModel(eventModel)
        }

        if (usageRaw) {
          ingestParsedUsage(usageRaw)
        }
      } catch {
        record({ ts: new Date().toISOString(), stream: "stdout_unparsed", line })
      }
    },
    onActivity(activity) {
      record({ ts: new Date().toISOString(), stream: activity.stream, chunk: activity.chunk })
      options.onActivity?.(activity)
    },
    onLivenessWarning(warning) {
      options.onLivenessWarning?.(warning)
    },
  })

  return {
    cancel() {
      cancelled = true
      handle.cancel()
    },
    promise: handle.promise.then(async (output) => {
      // Post-run hook: runtimes that carry thinking/activity outside the stdout
      // stream (Gemini's local session file) emit it here into the same
      // onToolActivity pipe Claude/Codex thinking uses.
      try {
        await runtime.afterRun({ sessionId: currentSessionId }, (line) => {
          options.onToolActivity?.(line)
        })
      } catch {
        // afterRun is best-effort; never let post-run bookkeeping fail the turn.
      }
      // F043 AC2: post-run usage 回读（codex 真足迹只在 rollout 文件里）。非空则覆盖
      // 流内退化值；失败保留流内值 —— best-effort，绝不 fail turn。
      try {
        const resolved = await runtime.resolveUsage({ sessionId: currentSessionId })
        if (resolved && resolved.scope === "context" && resolved.totalTokens > 0) {
          ingestParsedUsage(resolved)
        }
      } catch {
        // resolveUsage is best-effort; degraded stream snapshot survives.
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
        turnTotals: turnTotals
          ? {
              totalTokens: turnTotals.totalTokens,
              ...(turnTotals.detail ? { detail: turnTotals.detail } : {}),
            }
          : null,
        // F043：seal 判定在 resolveUsage 合并之后 —— 用最终真值，不用流内中间值
        sealDecision: computeSealDecision(options.provider, latestUsage, options.sealThresholds),
        stopReason: latestStopReason ?? output.stopReason,
        toolEvents,
      }
    }),
  }
}

/**
 * F043 AC3：从 claude result.modelUsage 提炼的窗口表里挑当前模型的账户生效窗口。
 * key 是完整模型名（如 claude-haiku-4-5-20251001）：精确命中 → 双向前缀 → 单条目
 * 直取 → 多条目取最大（宁可晚封不误封 —— 分母偏大只会推迟 seal，不会假阳性）。
 */
export function pickModelWindow(
  windows: Record<string, number>,
  model: string | null,
): number | null {
  const entries = Object.entries(windows).filter(([, w]) => typeof w === "number" && w > 0)
  if (entries.length === 0) {
    return null
  }
  if (model) {
    const exact = windows[model]
    if (typeof exact === "number" && exact > 0) {
      return exact
    }
    const prefix = entries.find(([name]) => name.startsWith(model) || model.startsWith(name))
    if (prefix) {
      return prefix[1]
    }
  }
  if (entries.length === 1) {
    return entries[0][1]
  }
  return entries.reduce((max, entry) => (entry[1] > max[1] ? entry : max))[1]
}

export function computeSealDecision(
  provider: Provider,
  usage: TokenUsageSnapshot | null,
  resolvedThresholds?: ResolvedSealThresholds,
): SealDecision | null {
  if (!usage) {
    return null
  }
  const thresholds = resolvedThresholds ?? SEAL_THRESHOLDS_BY_PROVIDER[provider]
  const fillRatio = Math.min(usage.usedTokens / usage.windowTokens, 1.0)
  if (fillRatio >= thresholds.action) {
    // F043 AC3：gemini fail-open —— usedTokens 仍是 CLI 累计口径（stats.total_tokens，
    // 非当前足迹）且地区墙无法活测，approx 数据不触发硬动作（对标 clowder F062 原则）。
    // 阈值来源（默认/用户自定义）不影响该闸：病在数据质量不在阈值。
    // 解封条件：gemini CLI 恢复后活测 usage 口径，确认足迹语义再放行 seal。
    if (provider === "gemini") {
      return { shouldSeal: false, reason: "warn", fillRatio, usage }
    }
    return { shouldSeal: true, reason: "threshold", fillRatio, usage }
  }
  if (fillRatio >= thresholds.warn) {
    return { shouldSeal: false, reason: "warn", fillRatio, usage }
  }
  return { shouldSeal: false, reason: null, fillRatio, usage }
}
