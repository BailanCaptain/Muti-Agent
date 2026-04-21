import type {
  ActiveGroupView,
  ConnectorSource,
  ContentBlock,
  Provider,
  ProviderCatalog,
  RealtimeServerEvent,
  SessionGroupSummary,
  ThreadSnapshotDelta,
  TimelineMessage,
  ToolEvent,
} from "@multi-agent/shared"
import { perfCollector } from "../lib/perf-collector"
import type { ProviderProfile } from "../runtime/provider-profiles"
import type { SessionRepository } from "../storage/repositories"

type ProviderView = {
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

type DispatchState = {
  hasPendingDispatches: boolean
  dispatchBarrierActive: boolean
}

export class SessionService {
  private lastSentTimestamps = new Map<string, string>()
  private emit: ((event: RealtimeServerEvent) => void) | null = null

  constructor(
    private readonly repository: SessionRepository,
    private readonly providerProfiles: ProviderProfile[],
    private readonly sessionTitler?: { schedule(sessionGroupId: string): void },
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
        from: ["gemini-3.1-pro", "gemini-3-flash", "gemini-3.1-pro-preview", "gemini-3-flash-preview"],
        to:
          this.providerProfiles.find((profile) => profile.provider === "gemini")?.currentModel ??
          null,
      },
    })
  }

  listSessionGroups(): SessionGroupSummary[] {
    return this.repository.listSessionGroups().map((group) => ({
      id: group.id,
      roomId: group.roomId ?? null,
      title: group.title,
      updatedAt: new Date(group.updatedAt).toISOString(),
      updatedAtLabel: new Date(group.updatedAt).toLocaleString("zh-CN"),
      createdAt: new Date(group.createdAt).toISOString(),
      createdAtLabel: new Date(group.createdAt).toLocaleString("zh-CN"),
      projectTag: group.projectTag ?? undefined,
      titleLockedAt: group.titleLockedAt ?? null,
      participants: group.participants ?? [],
      messageCount: group.messageCount ?? 0,
      previews: group.previews,
    }))
  }

  // F022 Phase 3.5 (AC-14i/j): 归档列表 — 含归档和软删，前端一起展示。
  listArchivedSessionGroups(): SessionGroupSummary[] {
    return this.repository.listArchivedSessionGroups().map((group) => ({
      id: group.id,
      roomId: group.roomId ?? null,
      title: group.title,
      updatedAt: new Date(group.updatedAt).toISOString(),
      updatedAtLabel: new Date(group.updatedAt).toLocaleString("zh-CN"),
      createdAt: new Date(group.createdAt).toISOString(),
      createdAtLabel: new Date(group.createdAt).toLocaleString("zh-CN"),
      projectTag: group.projectTag ?? undefined,
      titleLockedAt: group.titleLockedAt ?? null,
      archivedAt: group.archivedAt ?? null,
      deletedAt: group.deletedAt ?? null,
      participants: [],
      messageCount: 0,
      previews: [],
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
    const t0 = performance.now()

    const group = this.repository.getSessionGroupById(groupId)
    const threads = this.repository.listThreadsByGroup(groupId)
    const tThreads = performance.now()

    const threadMessages = new Map<string, ReturnType<SessionRepository["listMessages"]>>()
    for (const thread of threads) {
      threadMessages.set(thread.id, this.repository.listMessages(thread.id))
    }
    const tMessages = performance.now()

    const providers = Object.fromEntries(
      threads.map((thread) => {
        let sopSkill: string | null = null
        let sopPhase: string | null = null
        let sopNext: string | null = null
        if (thread.sopBookmark) {
          try {
            const bm = JSON.parse(thread.sopBookmark) as { skill?: string; phase?: string; nextExpectedAction?: string }
            sopSkill = bm.skill ?? null
            sopPhase = bm.phase ?? null
            sopNext = bm.nextExpectedAction ?? null
          } catch { /* ignore malformed JSON */ }
        }
        const msgs = threadMessages.get(thread.id) ?? []
        const lastMsg = msgs[msgs.length - 1]
        return [
          thread.provider,
          {
            threadId: thread.id,
            alias: thread.alias,
            currentModel: thread.currentModel,
            quotaSummary: "额度信息待接入",
            preview: lastMsg?.content.slice(0, 80) ?? "",
            running: runningThreadIds.has(thread.id),
            sopSkill,
            sopPhase,
            sopNext,
            fillRatio: thread.lastFillRatio ?? null,
          },
        ]
      }),
    ) as Record<Provider, ProviderView>
    const tProviders = performance.now()

    const timeline = threads
      .flatMap((thread) =>
        (threadMessages.get(thread.id) ?? []).map((message) => {
            const parsedCB = JSON.parse(message.contentBlocks || "[]")
            return this.mapTimelineMessage(
              thread,
              message.id,
              message.role,
              message.content,
              message.thinking,
              message.createdAt,
              message.messageType,
              message.connectorSource ?? undefined,
              message.groupId,
              message.groupRole,
              JSON.parse(message.toolEvents || "[]") as ToolEvent[],
              parsedCB.length ? parsedCB : undefined,
            )
          }),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    const tTimeline = performance.now()

    const total = tTimeline - t0
    console.log(`[perf] getActiveGroup(${groupId.slice(0, 8)}): group+threads=${(tThreads - t0).toFixed(1)}ms messages=${(tMessages - tThreads).toFixed(1)}ms providers=${(tProviders - tMessages).toFixed(1)}ms timeline=${(tTimeline - tProviders).toFixed(1)}ms total=${total.toFixed(1)}ms`)
    perfCollector.record("getActiveGroup", total)
    perfCollector.record("getActiveGroup.group+threads", tThreads - t0)
    perfCollector.record("getActiveGroup.messages", tMessages - tThreads)
    perfCollector.record("getActiveGroup.providers", tProviders - tMessages)
    perfCollector.record("getActiveGroup.timeline", tTimeline - tProviders)

    return {
      id: groupId,
      title: group?.title ?? "新会话",
      meta: `最近更新时间：${group ? new Date(group.updatedAt).toLocaleString("zh-CN") : "--"}，消息会按统一时间线展示。`,
      timeline,
      hasPendingDispatches: dispatchState?.hasPendingDispatches ?? false,
      dispatchBarrierActive: dispatchState?.dispatchBarrierActive ?? false,
      providers,
    }
  }

  isFirstSnapshot(groupId: string): boolean {
    return !this.lastSentTimestamps.has(groupId)
  }

  getActiveGroupDelta(
    groupId: string,
    runningThreadIds: Set<string>,
    dispatchState?: DispatchState,
  ): ThreadSnapshotDelta {
    const lastTimestamp = this.lastSentTimestamps.get(groupId)
    const threads = this.repository.listThreadsByGroup(groupId)

    const providers = Object.fromEntries(
      threads.map((thread) => {
        let sopSkill: string | null = null
        let sopPhase: string | null = null
        let sopNext: string | null = null
        if (thread.sopBookmark) {
          try {
            const bm = JSON.parse(thread.sopBookmark) as { skill?: string; phase?: string; nextExpectedAction?: string }
            sopSkill = bm.skill ?? null
            sopPhase = bm.phase ?? null
            sopNext = bm.nextExpectedAction ?? null
          } catch { /* ignore malformed JSON */ }
        }
        const recentMsgs = this.repository.listRecentMessages(thread.id, 1)
        const lastMsg = recentMsgs[0]
        return [
          thread.provider,
          {
            threadId: thread.id,
            alias: thread.alias,
            currentModel: thread.currentModel,
            quotaSummary: "额度信息待接入",
            preview: lastMsg?.content.slice(0, 80) ?? "",
            running: runningThreadIds.has(thread.id),
            sopSkill,
            sopPhase,
            sopNext,
            fillRatio: thread.lastFillRatio ?? null,
          },
        ]
      }),
    ) as Record<string, ProviderView>

    const newMessages = threads.flatMap((thread) => {
      const msgs = lastTimestamp
        ? this.repository.listMessagesSince(thread.id, lastTimestamp)
        : this.repository.listMessages(thread.id)
      return msgs.map((message) => {
        const parsedCB = JSON.parse(message.contentBlocks || "[]")
        return this.mapTimelineMessage(
          thread,
          message.id,
          message.role,
          message.content,
          message.thinking,
          message.createdAt,
          message.messageType,
          message.connectorSource ?? undefined,
          message.groupId,
          message.groupRole,
          JSON.parse(message.toolEvents || "[]") as ToolEvent[],
          parsedCB.length ? parsedCB : undefined,
        )
      })
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    if (newMessages.length > 0) {
      const latest = newMessages.reduce((a, b) =>
        a.createdAt > b.createdAt ? a : b,
      )
      this.lastSentTimestamps.set(groupId, latest.createdAt)
    }

    return {
      sessionGroupId: groupId,
      newMessages,
      providers: providers as ThreadSnapshotDelta["providers"],
      invocationStats: [],
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

  appendUserMessage(threadId: string, content: string, contentBlocks = "[]") {
    return this.repository.appendMessage(threadId, "user", content, "", "final", null, null, null, "[]", contentBlocks)
  }

  appendAssistantMessage(
    threadId: string,
    content: string,
    thinking = "",
    messageType: "progress" | "final" | "a2a_handoff" = "final",
    groupId: string | null = null,
    groupRole: "header" | "member" | "convergence" | null = null,
    toolEvents = "[]",
  ) {
    const result = this.repository.appendMessage(threadId, "assistant", content, thinking, messageType, null, groupId, groupRole, toolEvents)
    if (messageType === "final" && this.sessionTitler) {
      const thread = this.repository.getThreadById(threadId)
      if (thread?.sessionGroupId) {
        this.sessionTitler.schedule(thread.sessionGroupId)
      }
    }
    return result
  }

  appendConnectorMessage(
    threadId: string,
    content: string,
    connectorSource: ConnectorSource,
    groupId: string | null = null,
    groupRole: "header" | "member" | "convergence" | null = null,
  ) {
    return this.repository.appendMessage(threadId, "assistant", content, "", "connector", connectorSource, groupId, groupRole)
  }

  overwriteMessage(messageId: string, updates: { content?: string; thinking?: string; toolEvents?: string; contentBlocks?: string }) {
    this.repository.overwriteMessage(messageId, updates)
  }

  appendContentBlock(messageId: string, block: import("@multi-agent/shared").ContentBlock) {
    this.repository.appendContentBlock(messageId, block as { type: string; [key: string]: unknown })
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

    const parsedContentBlocks = JSON.parse(message.contentBlocks || "[]")
    return this.mapTimelineMessage(
      thread,
      message.id,
      message.role,
      message.content,
      message.thinking,
      message.createdAt,
      message.messageType,
      message.connectorSource ?? undefined,
      message.groupId,
      message.groupRole,
      JSON.parse(message.toolEvents || "[]") as ToolEvent[],
      parsedContentBlocks.length ? parsedContentBlocks : undefined,
    )
  }

  updateSessionGroupProjectTag(groupId: string, tag: string | null) {
    this.repository.updateSessionGroupProjectTag(groupId, tag)
  }

  // F022 Phase 3.5 (AC-14k): wire the broadcaster so rename + Haiku update
  // push `session.title_updated` to connected clients.
  setBroadcaster(emit: (event: RealtimeServerEvent) => void) {
    this.emit = emit
  }

  // F022 Phase 3.5 (AC-14g): 手动重命名 — 写 title_locked_at 防 Haiku 覆盖
  renameSessionGroup(groupId: string, title: string) {
    this.repository.updateSessionGroupTitle(groupId, title, { manual: true })
    const row = this.repository.getSessionGroupById(groupId)
    this.emit?.({
      type: "session.title_updated",
      payload: {
        sessionGroupId: groupId,
        title,
        titleLockedAt: row?.titleLockedAt ?? null,
      },
    })
  }

  // F022 Phase 3.5 (review 2nd round P1): 服务端 send guard —
  // 归档/软删/不存在的会话不再接收新消息。前端切换/禁发是第一道防线，
  // 这里是第二道；即使远端标签页漏切，服务端也不会往失效会话写入。
  isSessionGroupSendable(
    groupId: string,
  ): { sendable: true } | { sendable: false; reason: "archived" | "deleted" } {
    const row = this.repository.getSessionGroupById(groupId)
    if (!row) return { sendable: false, reason: "deleted" }
    if (row.deletedAt != null) return { sendable: false, reason: "deleted" }
    if (row.archivedAt != null) return { sendable: false, reason: "archived" }
    return { sendable: true }
  }

  // F022 Phase 3.5 (AC-14i)
  archiveSessionGroup(groupId: string) {
    this.repository.archiveSessionGroup(groupId)
    this.emitArchiveStateChanged(groupId)
  }

  // F022 Phase 3.5 (AC-14j) — 软删
  softDeleteSessionGroup(groupId: string) {
    this.repository.softDeleteSessionGroup(groupId)
    this.emitArchiveStateChanged(groupId)
  }

  // F022 Phase 3.5 (AC-14i/j) — 恢复：清 archived_at 和 deleted_at
  restoreSessionGroup(groupId: string) {
    this.repository.restoreSessionGroup(groupId)
    this.emitArchiveStateChanged(groupId)
  }

  // F022 Phase 3.5 (review P2-3): 广播归档/软删/恢复状态变更 —
  // 多端场景下让其他已连接客户端同步主列表 ↔ 归档列表，不再依赖手动刷新。
  private emitArchiveStateChanged(groupId: string) {
    if (!this.emit) return
    const row = this.repository.getSessionGroupById(groupId)
    if (!row) return
    this.emit({
      type: "session.archive_state_changed",
      payload: {
        sessionGroupId: groupId,
        archivedAt: row.archivedAt ?? null,
        deletedAt: row.deletedAt ?? null,
      },
    })
  }

  updateThread(threadId: string, model: string | null, nativeSessionId: string | null, sopBookmark?: string | null, lastFillRatio?: number | null) {
    this.repository.updateThread(threadId, {
      currentModel: model,
      nativeSessionId,
      ...(sopBookmark !== undefined ? { sopBookmark } : {}),
      ...(lastFillRatio !== undefined ? { lastFillRatio } : {}),
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
    groupId?: string | null,
    groupRole?: "header" | "member" | "convergence" | null,
    toolEvents?: ToolEvent[],
    contentBlocks?: ContentBlock[],
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
      toolEvents: role === "assistant" && toolEvents?.length ? toolEvents : undefined,
      contentBlocks: contentBlocks?.length ? contentBlocks : undefined,
      groupId: groupId ?? undefined,
      groupRole: groupRole ?? undefined,
      model: role === "user" ? null : thread.currentModel,
      createdAt,
    }
  }

  // F018 P3/P4: SessionBootstrap 持久化访问器（pass-through to repository）
  getThreadMemory(threadId: string) {
    return this.repository.getThreadMemory(threadId)
  }

  setThreadMemory(
    threadId: string,
    memory: { summary: string; sessionCount: number; lastUpdatedAt: string },
  ): void {
    this.repository.setThreadMemory(threadId, memory)
  }

  getSessionChainIndex(threadId: string): number {
    return this.repository.getSessionChainIndex(threadId)
  }

  incrementSessionChainIndex(threadId: string): void {
    this.repository.incrementSessionChainIndex(threadId)
  }
}
