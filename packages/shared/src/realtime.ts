import type { Provider } from "./constants"

export type TimelineMessage = {
  id: string
  provider: Provider
  alias: string
  role: "user" | "assistant"
  content: string
  model: string | null
  createdAt: string
}

export type SessionGroupSummary = {
  id: string
  title: string
  updatedAtLabel: string
  previews: Array<{ provider: Provider; alias: string; text: string }>
}

export type ProviderCatalog = {
  provider: Provider
  alias: string
  currentModel: string | null
  modelSuggestions: string[]
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
      payload: { threadId: string }
    }

export type RealtimeServerEvent =
  | {
      type: "assistant_delta"
      payload: { messageId: string; delta: string }
    }
  | {
      type: "thread_snapshot"
      payload: {
        activeGroup: {
          id: string
          title: string
          meta: string
          timeline: TimelineMessage[]
          providers: Record<
            Provider,
            {
              threadId: string
              alias: string
              currentModel: string | null
              quotaSummary: string
              preview: string
              running: boolean
            }
          >
        }
      }
    }
  | {
      type: "status"
      payload: { message: string }
    }
