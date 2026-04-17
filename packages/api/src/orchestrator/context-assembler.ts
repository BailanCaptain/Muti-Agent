import type { Provider } from "@multi-agent/shared"
import type { ContextPolicy } from "./context-policy"
import { POLICY_FULL } from "./context-policy"
import type { ContextMessage } from "./context-snapshot"
import { truncateHeadTail } from "./context-snapshot"
import { microcompact } from "./microcompact"
import { computeDynamicLimits } from "./dynamic-budget"
import type { SOPBookmark } from "./sop-bookmark"
import { formatBookmarkForInjection } from "./sop-bookmark"
import { buildSessionBootstrap } from "./session-bootstrap"
import { AGENT_SYSTEM_PROMPTS, ACCEPTANCE_GUARDIAN_PROMPT } from "../runtime/agent-prompts"
import type { MemoryService } from "../services/memory-service"
import type { ThreadMemory } from "../services/thread-memory"
import type { ExtractiveDigestV1 } from "../services/transcript-writer"

// Note: AGENT_SYSTEM_PROMPTS is Record<Provider, string> containing the base prompt
// (identity + roster + rules + callback API for codex/gemini).
// CALLBACK_API_PROMPT is already included in the codex/gemini entries.

export type AssemblePromptInput = {
  provider: Provider
  threadId: string
  sessionGroupId: string
  /** If set, CLI can --resume and self-history is redundant */
  nativeSessionId: string | null
  policy: ContextPolicy
  /** The task/user message content */
  task: string
  /** Optional preamble (requirements doc, etc.) for DOCUMENT_ONLY policy */
  preamble?: string
  /** Context snapshot from the room (all threads' messages merged) */
  roomSnapshot: readonly ContextMessage[]
  /** Who initiated: "user" or agent alias */
  sourceAlias: string
  /** Target agent's alias (e.g. "黄仁勋") */
  targetAlias: string
  /** Optional Phase 1 header text */
  phase1HeaderText?: string
  /** SOP bookmark for cross-seal skill state restoration */
  sopBookmark?: SOPBookmark | null
  /** Last fill ratio for dynamic budget computation */
  lastFillRatio?: number
  /** When true, replace system prompt with ACCEPTANCE_GUARDIAN_PROMPT (zero-context mode) */
  guardianMode?: boolean
  /** F018 AC3.5: Thread memory rolling summary for SessionBootstrap (new session only) */
  threadMemory?: ThreadMemory | null
  /** F018 AC3.5: Session chain index — Nth session under this thread */
  sessionChainIndex?: number
  /** F018 AC3.5: Available recall tools injected into Bootstrap tools section */
  recallTools?: string[]
  /** F018 AC3.5: Previous session's extractive digest (from TranscriptWriter) */
  previousDigest?: ExtractiveDigestV1 | null
}

export type AssemblePromptResult = {
  systemPrompt: string
  content: string
}

/**
 * Single entry point for building the complete prompt for any agent invocation.
 * Replaces: getSystemPromptForTurn, buildSystemPrompt, buildA2APrompt, captureSnapshot, truncateForA2A.
 *
 * System prompt = base identity + rolling summary (if policy allows)
 * Content = task + context layers determined by policy
 */
export async function assemblePrompt(
  input: AssemblePromptInput,
  memoryService: MemoryService | null,
): Promise<AssemblePromptResult> {
  const { provider, policy, roomSnapshot, targetAlias } = input

  // ── System Prompt ──────────────────────────────────────────────────
  // Guardian mode: zero-context custom prompt, no identity/team/rules injection.
  if (input.guardianMode) {
    return {
      systemPrompt: ACCEPTANCE_GUARDIAN_PROMPT,
      content: input.task,
    }
  }

  const systemParts: string[] = [AGENT_SYSTEM_PROMPTS[provider]]

  if (policy.injectRollingSummary && memoryService) {
    const summary = await memoryService.getOrCreateSummary(input.sessionGroupId)
    if (summary) {
      systemParts.push("")
      systemParts.push("## 本房间摘要")
      systemParts.push(summary)
      systemParts.push("请参考上述背景信息继续协作。")
    }
  }

  if (policy.injectRollingSummary && input.sopBookmark) {
    const bookmarkLine = formatBookmarkForInjection(input.sopBookmark)
    if (bookmarkLine) {
      systemParts.push("")
      systemParts.push("## 当前执行状态")
      systemParts.push(bookmarkLine)
    }
  }

  const systemPrompt = systemParts.join("\n")

  // ── Content (user message) ─────────────────────────────────────────
  const contentSections: string[] = []

  // F018 AC3.5: New session gets SessionBootstrap reference-only prelude
  // (Thread Memory / Previous Session / Task Snapshot / Recall Tools / Do NOT guess).
  // Injected only when nativeSessionId is null AND caller supplied bootstrap metadata —
  // this preserves existing callers that haven't been wired yet (P4 wires message-service).
  if (
    input.nativeSessionId === null &&
    (input.sessionChainIndex !== undefined ||
      input.threadMemory !== undefined ||
      input.previousDigest !== undefined ||
      input.recallTools !== undefined)
  ) {
    const bootstrap = buildSessionBootstrap({
      threadId: input.threadId,
      sessionChainIndex: input.sessionChainIndex ?? 1,
      threadMemory: input.threadMemory ?? null,
      previousDigest: input.previousDigest ?? null,
      taskSnapshot: input.sopBookmark
        ? (formatBookmarkForInjection(input.sopBookmark) ?? null)
        : null,
      recallTools: input.recallTools ?? [],
    })
    contentSections.push(bootstrap.text)
    contentSections.push("")
  }

  // Header
  const isUserInitiated = input.sourceAlias === "user"
  contentSections.push(
    isUserInitiated ? "[用户请求]" : `[A2A 协作请求 from ${input.sourceAlias}]`,
  )
  contentSections.push("")
  contentSections.push(`任务: ${input.task}`)
  contentSections.push("")

  // Phase 1 header (independent thinking mode)
  if (policy.phase1Header && input.phase1HeaderText) {
    contentSections.push(input.phase1HeaderText)
    contentSections.push("")
  }

  // F019 P4: skillHint keyword-injection layer removed — SOP direction now
  // comes from sopStageHint in the system prompt (see agent-prompts.ts
  // buildSystemPromptWithHints). CLI-native skill discovery handles the rest.

  // Preamble (document-only mode)
  if (policy.injectPreamble && input.preamble) {
    contentSections.push("--- 需求文档 ---")
    contentSections.push(input.preamble)
    contentSections.push("---")
    contentSections.push("")
  }

  // Self history: F004 — always inject when policy allows. Previously skipped
  // when nativeSessionId was set (trusting CLI --resume), but that proved
  // unreliable and caused direct-turn amnesia (B005). The API is now the
  // authoritative history source; CLI --resume is a performance optimization.
  const effectiveLimits = policy.dynamicBudget && input.lastFillRatio !== undefined
    ? computeDynamicLimits(input.lastFillRatio)
    : { sharedHistoryLimit: policy.sharedHistoryLimit, selfHistoryLimit: policy.selfHistoryLimit, maxContentLength: policy.maxContentLength }

  const shouldInjectSelfHistory = policy.injectSelfHistory
  if (shouldInjectSelfHistory) {
    const selfMessages = roomSnapshot.filter((m) => m.agentId === targetAlias)
    const recent = selfMessages.slice(-effectiveLimits.selfHistoryLimit)
    const compacted = microcompact(recent, { keepRecent: 5, keepLastFailure: true })
    if (compacted.length > 0) {
      contentSections.push(`--- 你之前的发言 (${compacted.length} 条) ---`)
      for (const m of compacted) {
        contentSections.push(`[${m.role === "user" ? "收到" : "你"}]: ${m.content}`)
      }
      contentSections.push("---")
      contentSections.push("")
    }
  }

  // Shared history: other agents' messages
  if (policy.injectSharedHistory) {
    const otherMessages = roomSnapshot.filter((m) => m.agentId !== targetAlias)
    const recent = otherMessages.slice(-effectiveLimits.sharedHistoryLimit)
    const compacted = microcompact(recent, { keepRecent: 5, keepLastFailure: true })
    if (compacted.length > 0) {
      contentSections.push(`--- 近期对话 (${compacted.length} 条) ---`)
      for (const m of compacted) {
        const truncated = truncateHeadTail(m.content, effectiveLimits.maxContentLength)
        contentSections.push(`[${m.agentId}]: ${truncated}`)
      }
      contentSections.push("---")
      contentSections.push("")
    }
  }

  // MCP hint
  contentSections.push("如需更早的上下文，可调用 MCP get_room_context 工具获取。")
  contentSections.push("")
  contentSections.push(`你是 ${targetAlias}。请完成上述任务。`)

  return {
    systemPrompt,
    content: contentSections.join("\n"),
  }
}

/**
 * Direct user → single agent turn prompt assembly.
 *
 * F004: promoted from "systemPrompt only" to full {systemPrompt, content}
 * assembly so direct-turn history is injected by the API (authoritative),
 * not left to CLI --resume (unreliable). Internally delegates to
 * `assemblePrompt` with POLICY_FULL, sourceAlias="user", no phase1 header,
 * no preamble, non-guardian mode.
 */
export type AssembleDirectTurnInput = {
  provider: Provider
  threadId: string
  sessionGroupId: string
  /** Only used by downstream runtime for CLI --resume; no longer gates history injection. */
  nativeSessionId: string | null
  task: string
  sourceAlias: "user"
  targetAlias: string
  roomSnapshot: readonly ContextMessage[]
  sopBookmark?: SOPBookmark | null
  lastFillRatio?: number
}

export async function assembleDirectTurnPrompt(
  input: AssembleDirectTurnInput,
  memoryService: MemoryService | null,
): Promise<AssemblePromptResult> {
  return assemblePrompt(
    {
      provider: input.provider,
      threadId: input.threadId,
      sessionGroupId: input.sessionGroupId,
      nativeSessionId: input.nativeSessionId,
      policy: POLICY_FULL,
      task: input.task,
      preamble: undefined,
      roomSnapshot: input.roomSnapshot,
      sourceAlias: input.sourceAlias,
      targetAlias: input.targetAlias,
      phase1HeaderText: undefined,
      sopBookmark: input.sopBookmark,
      lastFillRatio: input.lastFillRatio,
      guardianMode: false,
    },
    memoryService,
  )
}
