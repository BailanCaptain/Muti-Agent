import type {
  ActiveGroupView,
  ConnectorSource,
  Provider,
  ProviderCatalog,
  SessionGroupSummary,
  TimelineMessage,
} from "@multi-agent/shared"
import type { ProviderProfile } from "../runtime/provider-profiles"
import type { SessionRepository } from "../storage/repositories"

type ProviderView = {
  threadId: string
  alias: string
  currentModel: string | null
  quotaSummary: string
  preview: string
  running: boolean
}

type DispatchState = {
  hasPendingDispatches: boolean
  dispatchBarrierActive: boolean
}

export class SessionService {
  constructor(
    private readonly repository: SessionRepository,
    private readonly providerProfiles: ProviderProfile[],
  ) {
    this.repository.reconcileLegacyDefaultModels({
      codex: {
        from: ["gpt-5-codex", "gpt-5", "o3"],
        to:
          this.providerProfiles.find((profile) => profile.provider === "codex")?.currentModel ??
          null,
      },
      claude: {
        from: ["claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-opus-4-1"],
        to:
          this.providerProfiles.find((profile) => profile.provider === "claude")?.currentModel ??
          null,
      },
      gemini: {
        from: ["gemini-3.1-pro", "gemini-3-flash"],
        to:
          this.providerProfiles.find((profile) => profile.provider === "gemini")?.currentModel ??
          null,
      },
    })
  }

  listSessionGroups(): SessionGroupSummary[] {
    return this.repository.listSessionGroups().map((group) => ({
      id: group.id,
      title: group.title,
      updatedAtLabel: new Date(group.updatedAt).toLocaleString("zh-CN"),
      previews: group.previews,
    }))
  }

  listProviderCatalog(): ProviderCatalog[] {
    return this.providerProfiles.map((profile) => ({
      provider: profile.provider,
      alias: profile.alias,
      currentModel: profile.currentModel,
      modelSuggestions: profile.modelSuggestions,
    }))
  }

  createSessionGroup() {
    const groupId = this.repository.createSessionGroup()
    this.repository.ensureDefaultThreads(
      groupId,
      Object.fromEntries(
        this.providerProfiles.map((profile) => [profile.provider, profile.currentModel]),
      ) as Record<Provider, string | null>,
    )
    return groupId
  }

  getActiveGroup(
    groupId: string,
    runningThreadIds: Set<string>,
    dispatchState?: DispatchState,
  ): ActiveGroupView {
    const groups = this.repository.listSessionGroups()
    const summary = groups.find((group) => group.id === groupId)
    const threads = this.repository.listThreadsByGroup(groupId)

    const providers = Object.fromEntries(
      threads.map((thread) => [
        thread.provider,
        {
          threadId: thread.id,
          alias: thread.alias,
          currentModel: thread.currentModel,
          quotaSummary: "额度信息待接入",
          preview: summary?.previews.find((item) => item.provider === thread.provider)?.text ?? "",
          running: runningThreadIds.has(thread.id),
        },
      ]),
    ) as Record<Provider, ProviderView>

    const timeline = threads
      .flatMap((thread) =>
        this.repository
          .listMessages(thread.id)
          .map((message) =>
            this.mapTimelineMessage(
              thread,
              message.id,
              message.role,
              message.content,
              message.thinking,
              message.createdAt,
              message.messageType,
              message.connectorSource ?? undefined,
            ),
          ),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))

    return {
      id: groupId,
      title: summary?.title ?? "新会话",
      meta: `最近更新时间：${summary ? new Date(summary.updatedAt).toLocaleString("zh-CN") : "--"}，消息会按统一时间线展示。`,
      timeline,
      hasPendingDispatches: dispatchState?.hasPendingDispatches ?? false,
      dispatchBarrierActive: dispatchState?.dispatchBarrierActive ?? false,
      providers,
    }
  }

  findThread(threadId: string) {
    return this.repository.getThreadById(threadId) ?? null
  }

  findThreadByGroupAndProvider(sessionGroupId: string, provider: Provider) {
    return (
      this.repository
        .listThreadsByGroup(sessionGroupId)
        .find((thread) => thread.provider === provider) ?? null
    )
  }

  listGroupThreads(sessionGroupId: string) {
    return this.repository.listThreadsByGroup(sessionGroupId)
  }

  listThreadMessages(threadId: string) {
    return this.repository.listMessages(threadId)
  }

  appendUserMessage(threadId: string, content: string) {
    return this.repository.appendMessage(threadId, "user", content, "", "final")
  }

  appendAssistantMessage(threadId: string, content: string, thinking = "", messageType: "progress" | "final" | "a2a_handoff" = "final") {
    return this.repository.appendMessage(threadId, "assistant", content, thinking, messageType)
  }

  appendConnectorMessage(threadId: string, content: string, connectorSource: ConnectorSource) {
    return this.repository.appendMessage(threadId, "assistant", content, "", "connector", connectorSource)
  }

  overwriteMessage(messageId: string, updates: { content?: string; thinking?: string }) {
    this.repository.overwriteMessage(messageId, updates)
  }

  toTimelineMessage(threadId: string, messageId: string): TimelineMessage | null {
    const thread = this.repository.getThreadById(threadId)
    if (!thread) {
      return null
    }

    const message = this.repository.listMessages(threadId).find((item) => item.id === messageId)
    if (!message) {
      return null
    }

    return this.mapTimelineMessage(
      thread,
      message.id,
      message.role,
      message.content,
      message.thinking,
      message.createdAt,
      message.messageType,
      message.connectorSource ?? undefined,
    )
  }

  updateThread(threadId: string, model: string | null, nativeSessionId: string | null) {
    this.repository.updateThread(threadId, {
      currentModel: model,
      nativeSessionId,
    })
  }

  private mapTimelineMessage(
    thread: { provider: Provider; alias: string; currentModel: string | null },
    id: string,
    role: "user" | "assistant",
    content: string,
    thinking: string,
    createdAt: string,
    messageType: "progress" | "final" | "a2a_handoff" | "connector" = "final",
    connectorSource?: ConnectorSource,
  ): TimelineMessage {
    const isConnector = messageType === "connector"
    return {
      id,
      provider: thread.provider,
      alias: role === "user" ? "村长" : thread.alias,
      role,
      content:
        role === "user"
          ? content.includes(`@${thread.alias}`)
            ? content
            : `@${thread.alias} ${content}`
          : content,
      thinking: role === "assistant" && thinking && !isConnector ? thinking : undefined,
      messageType,
      connectorSource: isConnector ? connectorSource : undefined,
      model: role === "user" ? null : thread.currentModel,
      createdAt,
    }
  }
}
