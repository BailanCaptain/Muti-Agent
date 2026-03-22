import type { Provider } from "./constants"

export type TimelineMessage = {
  id: string
  provider: Provider
  alias: string
  role: "user" | "assistant"
  content: string
  thinking?: string
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
  title: string
  updatedAtLabel: string
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

export type BlockedDispatchAttempt = {
  sessionGroupId: string
  rootMessageId: string
  sourceMessageId: string
  sourceProvider: Provider
  sourceAlias: string
  targetProvider: Provider
  targetAlias: string
  reason: "group_cancelled"
  content: string
}

export type RealtimeClientEvent =
  | {
      type: "send_message"
      payload: {
        threadId: string
        provider: Provider
        content: string
        alias: string
      }
    }
  | {
      type: "stop_thread"
      payload: {
        threadId: string
      }
    }

export type RealtimeServerEvent =
  | {
      type: "assistant_delta"
      payload: {
        messageId: string
        delta: string
      }
    }
  | {
      type: "assistant_thinking_delta"
      payload: {
        messageId: string
        delta: string
      }
    }
  | {
      type: "message.created"
      payload: {
        threadId: string
        message: TimelineMessage
      }
    }
  | {
      type: "thread_snapshot"
      payload: {
        activeGroup: ActiveGroupView
      }
    }
  | {
      type: "status"
      payload: {
        message: string
      }
    }
  | {
      type: "dispatch.blocked"
      payload: {
        attempts: BlockedDispatchAttempt[]
      }
    }
