import type { Provider } from "@multi-agent/shared"
import type { ContextPolicy } from "./context-policy"
import type { ContextMessage } from "./context-snapshot"
import { truncateHeadTail } from "./context-snapshot"
import { AGENT_SYSTEM_PROMPTS } from "../runtime/agent-prompts"
import type { MemoryService } from "../services/memory-service"

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
  /** Optional skill hint line */
  skillHint?: string | null
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

  const systemPrompt = systemParts.join("\n")

  // ── Content (user message) ─────────────────────────────────────────
  const contentSections: string[] = []

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

  // Skill hint
  if (input.skillHint) {
    contentSections.push(input.skillHint)
    contentSections.push("")
  }

  // Preamble (document-only mode)
  if (policy.injectPreamble && input.preamble) {
    contentSections.push("--- 需求文档 ---")
    contentSections.push(input.preamble)
    contentSections.push("---")
    contentSections.push("")
  }

  // Self history: skip if CLI can resume (nativeSessionId is set)
  const shouldInjectSelfHistory = policy.injectSelfHistory && !input.nativeSessionId
  if (shouldInjectSelfHistory) {
    const selfMessages = roomSnapshot.filter((m) => m.agentId === targetAlias)
    const recent = selfMessages.slice(-policy.selfHistoryLimit)
    if (recent.length > 0) {
      contentSections.push(`--- 你之前的发言 (${recent.length} 条) ---`)
      for (const m of recent) {
        contentSections.push(`[${m.role === "user" ? "收到" : "你"}]: ${m.content}`)
      }
      contentSections.push("---")
      contentSections.push("")
    }
  }

  // Shared history: other agents' messages
  if (policy.injectSharedHistory) {
    const otherMessages = roomSnapshot.filter((m) => m.agentId !== targetAlias)
    const recent = otherMessages.slice(-policy.sharedHistoryLimit)
    if (recent.length > 0) {
      contentSections.push(`--- 近期对话 (${recent.length} 条) ---`)
      for (const m of recent) {
        const truncated = truncateHeadTail(m.content, policy.maxContentLength)
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
 * Simplified assemblePrompt for direct user → single agent turns.
 * Uses POLICY_FULL, sourceAlias="user", no phase1 header.
 */
export async function assembleDirectTurnPrompt(
  provider: Provider,
  threadId: string,
  sessionGroupId: string,
  nativeSessionId: string | null,
  memoryService: MemoryService | null,
): Promise<string> {
  // For direct turns, we only need the system prompt with rolling summary.
  // The content is the user's raw message (no A2A wrapping needed).
  const systemParts: string[] = [AGENT_SYSTEM_PROMPTS[provider]]

  if (memoryService) {
    const summary = await memoryService.getOrCreateSummary(sessionGroupId)
    if (summary) {
      systemParts.push("")
      systemParts.push("## 本房间摘要")
      systemParts.push(summary)
      systemParts.push("请参考上述背景信息继续协作。")
    }
  }

  return systemParts.join("\n")
}
