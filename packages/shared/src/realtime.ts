import type { Provider } from "./constants"
import type { ToolEvent } from "./tool-event"

export type ConnectorSource = {
  kind: "multi_mention_result"
  label: string
  initiator?: Provider
  targets: Provider[]
  fromAlias?: string
  toAlias?: string
}

// ── Inline Confirmation ─────────────────────────────────────────────

/**
 * A confirmation card embedded inside an agent's message bubble.
 * The agent raises a question that requires user decision; the card
 * renders inline (not as a standalone system card).
 */
export type InlineConfirmation = {
  /** Unique ID for this confirmation request */
  confirmationId: string
  /** Which agent raised this */
  raisedBy: Provider
  /** The question / decision point */
  question: string
  /** Selectable options (at least 2) */
  options: Array<{ id: string; label: string; description?: string }>
  /** Allow multiple selections */
  multiSelect?: boolean
  /** Current status */
  status: "pending" | "resolved" | "expired"
  /** How it was resolved */
  resolvedBy?: "user" | "consensus"
  /** The selected option IDs */
  selectedIds?: string[]
  /** Free-text user input */
  userInput?: string
}

/**
 * A pending confirmation item that must be resolved before proceeding.
 * Tracked per session-group across phases.
 */
export type PendingConfirmationItem = {
  id: string
  raisedBy: Provider
  raisedInPhase: "phase1" | "phase2" | "normal"
  question: string
  options?: string[]
  status: "pending" | "resolved" | "deferred"
  resolvedBy?: "user" | "consensus"
  resolution?: string
  /** The message ID where this confirmation card is embedded */
  messageId: string
  createdAt: string
}

// ── Content Blocks (F008: 图片一等公民) ─────────────────────────────

export type ImageMeta = {
  source?: string
  timestamp?: string
  viewport?: { width: number; height: number }
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; url: string; alt?: string; meta?: ImageMeta }

export type SkillEvent = {
  skillName: string
  matchType: "slash" | "auto"
  timestamp: string
}

export type TimelineMessage = {
  id: string
  provider: Provider
  alias: string
  role: "user" | "assistant"
  content: string
  thinking?: string
  messageType: "progress" | "final" | "a2a_handoff" | "connector"
  connectorSource?: ConnectorSource
  /** Inline confirmation cards embedded in this message bubble */
  inlineConfirmations?: InlineConfirmation[]
  toolEvents?: ToolEvent[]
  skillEvents?: SkillEvent[]
  contentBlocks?: ContentBlock[]
  groupId?: string
  groupRole?: "header" | "member" | "convergence"
  inputTokens?: number
  outputTokens?: number
  cachedPercent?: number
  model: string | null
  createdAt: string
}

export interface InvocationStats {
  sessionId: string
  agentId: string
  provider: Provider
  model: string
  startedAt: string
  status: "ACTIVE" | "IDLE" | "ERROR"
  inputTokens: number
  outputTokens: number
  cachedTokens: number
}

export type SessionGroupSummary = {
  id: string
  roomId: string | null
  title: string
  updatedAtLabel: string
  createdAtLabel: string
  projectTag?: string
  participants: Provider[]
  messageCount: number
  previews: Array<{
    provider: Provider
    alias: string
    text: string
  }>
}

export type ProviderCatalog = {
  provider: Provider
  alias: string
  currentModel: string | null
  modelSuggestions: string[]
}

export type ProviderThreadView = {
  threadId: string
  alias: string
  currentModel: string | null
  quotaSummary: string
  preview: string
  running: boolean
  sopSkill?: string | null
  sopPhase?: string | null
  sopNext?: string | null
  fillRatio?: number | null
}

export type ThreadSnapshotDelta = {
  sessionGroupId: string
  newMessages: TimelineMessage[]
  removedMessageIds?: string[]
  providers: Record<Provider, ProviderThreadView>
  invocationStats: InvocationStats[]
}

export type ActiveGroupView = {
  id: string
  title: string
  meta: string
  timeline: TimelineMessage[]
  hasPendingDispatches: boolean
  dispatchBarrierActive: boolean
  providers: Record<Provider, ProviderThreadView>
}

export type ApprovalFingerprint = {
  tool: string
  target?: string
  risk: "low" | "medium" | "high"
}

export type ApprovalRequest = {
  requestId: string
  provider: Provider
  agentAlias: string
  threadId: string
  sessionGroupId: string
  action: string
  fingerprint: ApprovalFingerprint
  reason: string
  context?: string
  createdAt: string
}

export type ApprovalScope = "once" | "thread" | "global"

export type AuthorizationRule = {
  id: string
  provider: Provider | "*"
  action: string
  scope: "thread" | "global"
  decision: "allow" | "deny"
  threadId?: string
  sessionGroupId?: string
  createdAt: string
  createdBy: string
  reason?: string
}

export type DecisionOption = {
  id: string
  label: string
  description?: string
  provider?: Provider
}

export type DecisionRequest = {
  requestId: string
  kind: "multi_choice" | "fan_in_selector" | "inline_confirmation"
  title: string
  description?: string
  options: DecisionOption[]
  sessionGroupId: string
  sourceProvider?: Provider
  sourceAlias?: string
  multiSelect?: boolean
  /**
   * When true, the card renders a free-text input alongside the option list.
   * User can submit text without selecting an option, or combine both.
   */
  allowTextInput?: boolean
  textInputPlaceholder?: string
  /**
   * The message ID this decision card is attached to.
   * When set, the frontend renders the card inline inside the agent's
   * message bubble instead of as a standalone system card.
   */
  anchorMessageId?: string
  createdAt: string
}

export type OptionVerdict = "approved" | "rejected" | "modified"

export type DecisionVerdict = {
  optionId: string
  verdict: OptionVerdict
  modification?: string
}

export type BlockedDispatchAttempt = {
  sessionGroupId: string
  rootMessageId: string
  from: { agentId: string; messageId: string; provider: Provider }
  to: { agentId: string; provider: Provider }
  reason: "group_cancelled" | "max_hops" | "dedup"
  taskSnippet: string
}

export type RealtimeClientEvent =
  | {
      type: "send_message"
      payload: {
        threadId: string
        provider: Provider
        content: string
        alias: string
        contentBlocks?: ContentBlock[]
        clientMessageId?: string
      }
    }
  | {
      type: "stop_thread"
      payload: {
        threadId: string
      }
    }
  | {
      type: "end_session"
      payload: {
        sessionGroupId: string
      }
    }
  | {
      type: "approval.respond"
      payload: {
        requestId: string
        granted: boolean
        scope: ApprovalScope
      }
    }
  | {
      type: "decision.respond"
      payload: {
        requestId: string
        decisions: DecisionVerdict[]
        userInput?: string
      }
    }

export type RealtimeServerEvent =
  | {
      type: "assistant_delta"
      payload: {
        sessionGroupId: string
        messageId: string
        delta: string
      }
    }
  | {
      type: "assistant_thinking_delta"
      payload: {
        sessionGroupId: string
        messageId: string
        delta: string
      }
    }
  | {
      type: "message.created"
      payload: {
        threadId: string
        sessionGroupId?: string
        message: TimelineMessage
        clientMessageId?: string
      }
    }
  | {
      type: "thread_snapshot"
      payload: {
        sessionGroupId: string
        activeGroup: ActiveGroupView
      }
    }
  | {
      type: "thread_snapshot_delta"
      payload: ThreadSnapshotDelta
    }
  | {
      type: "status"
      payload: {
        sessionGroupId?: string
        message: string
      }
    }
  | {
      type: "dispatch.blocked"
      payload: {
        attempts: BlockedDispatchAttempt[]
      }
    }
  | {
      type: "approval.request"
      payload: ApprovalRequest
    }
  | {
      type: "approval.resolved"
      payload: {
        sessionGroupId: string
        requestId: string
        granted: boolean
      }
    }
  | {
      type: "approval.auto_granted"
      payload: {
        sessionGroupId: string
        provider: Provider
        action: string
        ruleId: string
      }
    }
  | {
      type: "decision.request"
      payload: DecisionRequest
    }
  | {
      type: "decision.resolved"
      payload: {
        sessionGroupId: string
        requestId: string
        decisions: DecisionVerdict[]
        userInput?: string
      }
    }
  | {
      type: "decision.board_flush"
      payload: {
        sessionGroupId: string
        items: DecisionBoardItem[]
        flushedAt: string
      }
    }
  | {
      type: "decision.board_item_resolved"
      payload: {
        sessionGroupId: string
        itemId: string
      }
    }
  | {
      type: "assistant_tool_event"
      payload: {
        sessionGroupId: string
        messageId: string
        event: ToolEvent
      }
    }
  | {
      type: "assistant_content_block"
      payload: {
        sessionGroupId: string
        messageId: string
        block: ContentBlock
      }
    }
  | {
      type: "preview.auto_open"
      payload: {
        port: number
        path?: string
        sessionGroupId?: string
        gatewayPort: number
      }
    }

/**
 * F002: A single question held by the Decision Board, sent to the frontend
 * when SettlementDetector decides the discussion has settled. Same shape
 * as DecisionBoardEntry on the backend but strips the internal questionHash
 * and exposes only display-safe fields for raisers.
 */
export type DecisionBoardItem = {
  id: string
  question: string
  options: { id: string; label: string }[]
  raisers: { alias: string; provider: Provider }[]
  firstRaisedAt: string
  /** True when team reached consensus during Phase 2 discussion. */
  converged?: boolean
}
