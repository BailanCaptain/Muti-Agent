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
  sealed?: boolean
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
        from: [
          "gemini-3.1-pro",
          "gemini-3-flash",
          "gemini-3.1-pro-preview",
          "gemini-3-flash-preview",
        ],
        to:
          this.providerProfiles.find((profile) => profile.provider === "gemini")?.currentModel ??
          null,
      },
    })
  }

  /**
   * F027 Phase 3 P20 Week 2 r2 (范-r1 P1) — 解析 sessionGroupId → canonical roomId。
   *
   * 用途：A2A 拼装路径（message-service.ts）需要给 AdaptiveRecallCoordinator /
   * PromptAuditWriter 传 R-### 形式的 canonical roomId（而非 sessionGroup UUID），
   * 让 prompt-inspector endpoint 按 R-### 查 prompt_audit row 能命中。
   *
   * 返回 null：sessionGroup 不存在 / roomId 字段未填（旧数据 / 测试 fixture）。
   * caller 应把 null 解释为"无 canonical room"，prompt_audit.room_id 写 null。
   */
  getRoomId(sessionGroupId: string): string | null {
    const row = this.repository.getSessionGroupById(sessionGroupId)
    return row?.roomId ?? null
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

  // F021 Phase 6 (AC-32) review fix: full snapshot 和 delta 共用同一套 sealed 派生，
  // 否则刷新页面/重选会话只走 full snapshot 时 sealed badge 丢失。
  private deriveSealed(threadId: string): boolean {
    const recentMsgs = this.repository.listRecentMessages(threadId, 10)
    const lastSystemNotice = recentMsgs.find((m) => m.messageType === "system_notice")
    const lastUserMsg = recentMsgs.find((m) => m.role === "user")
    return Boolean(
      lastSystemNotice && (!lastUserMsg || lastSystemNotice.createdAt > lastUserMsg.createdAt),
    )
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
            const bm = JSON.parse(thread.sopBookmark) as {
              skill?: string
              phase?: string
              nextExpectedAction?: string
            }
            sopSkill = bm.skill ?? null
            sopPhase = bm.phase ?? null
            sopNext = bm.nextExpectedAction ?? null
          } catch {
            /* ignore malformed JSON */
          }
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
            sealed: this.deriveSealed(thread.id),
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
            message.model,
            message.retryCount,
            message.retryReasons,
            // F026 P5 T0 · 透传 LEFT JOIN a2a_calls 协议字段
            {
              a2aCallId: message.a2aCallId,
              a2aParentCallId: message.a2aParentCallId,
              a2aRootCallId: message.a2aRootCallId,
              a2aOnBehalfOf: message.a2aOnBehalfOf,
              a2aConvenerId: message.a2aConvenerId,
              a2aCallStatus: message.a2aCallStatus,
              a2aDeadlineAt: message.a2aDeadlineAt,
            },
          )
        }),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    const tTimeline = performance.now()

    const total = tTimeline - t0
    console.log(
      `[perf] getActiveGroup(${groupId.slice(0, 8)}): group+threads=${(tThreads - t0).toFixed(1)}ms messages=${(tMessages - tThreads).toFixed(1)}ms providers=${(tProviders - tMessages).toFixed(1)}ms timeline=${(tTimeline - tProviders).toFixed(1)}ms total=${total.toFixed(1)}ms`,
    )
    perfCollector.record("getActiveGroup", total)
    perfCollector.record("getActiveGroup.group+threads", tThreads - t0)
    perfCollector.record("getActiveGroup.messages", tMessages - tThreads)
    perfCollector.record("getActiveGroup.providers", tProviders - tMessages)
    perfCollector.record("getActiveGroup.timeline", tTimeline - tProviders)

    return {
      id: groupId,
      roomId: group?.roomId ?? null,
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
            const bm = JSON.parse(thread.sopBookmark) as {
              skill?: string
              phase?: string
              nextExpectedAction?: string
            }
            sopSkill = bm.skill ?? null
            sopPhase = bm.phase ?? null
            sopNext = bm.nextExpectedAction ?? null
          } catch {
            /* ignore malformed JSON */
          }
        }
        // F021 Phase 6 (AC-32): sealed 复用 deriveSealed helper，与 full snapshot 同源。
        const recentMsgs = this.repository.listRecentMessages(thread.id, 10)
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
            sealed: this.deriveSealed(thread.id),
          },
        ]
      }),
    ) as Record<string, ProviderView>

    const newMessages = threads
      .flatMap((thread) => {
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
            message.model,
            message.retryCount,
            message.retryReasons,
            // F026 P5 T0 · delta 路径也要透传 a2a 字段
            {
              a2aCallId: message.a2aCallId,
              a2aParentCallId: message.a2aParentCallId,
              a2aRootCallId: message.a2aRootCallId,
              a2aOnBehalfOf: message.a2aOnBehalfOf,
              a2aConvenerId: message.a2aConvenerId,
              a2aCallStatus: message.a2aCallStatus,
              a2aDeadlineAt: message.a2aDeadlineAt,
            },
          )
        })
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    if (newMessages.length > 0) {
      const latest = newMessages.reduce((a, b) => (a.createdAt > b.createdAt ? a : b))
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
    return this.repository.appendMessage(
      threadId,
      "user",
      content,
      "",
      "final",
      null,
      null,
      null,
      "[]",
      contentBlocks,
    )
  }

  appendAssistantMessage(
    threadId: string,
    content: string,
    thinking = "",
    messageType: "progress" | "final" = "final",
    groupId: string | null = null,
    groupRole: "header" | "member" | "convergence" | null = null,
    toolEvents = "[]",
    model: string | null = null,
    a2aCallId: string | null = null,
  ) {
    const result = this.repository.appendMessage(
      threadId,
      "assistant",
      content,
      thinking,
      messageType,
      null,
      groupId,
      groupRole,
      toolEvents,
      "[]",
      model,
      a2aCallId,
    )
    // F026 P2 v2 Step 7: titler 触发由 messageType 判定改为内容前缀判定。
    // `[Call: @x ...]` 起头的 final 是 MCP / assistant 派发指令（旧 union
    // 标识符 a2a_handoff / a2a_handoff_mcp 已退役统一为 final），它们不属
    // 用户可见 final，不应作为 Haiku 标题计算源。
    if (
      messageType === "final" &&
      !content.trimStart().startsWith("[Call:") &&
      this.sessionTitler
    ) {
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
    a2aCallId: string | null = null,
  ) {
    return this.repository.appendMessage(
      threadId,
      "assistant",
      content,
      "",
      "connector",
      connectorSource,
      groupId,
      groupRole,
      "[]",
      "[]",
      null,
      a2aCallId,
    )
  }

  // F021 Phase 6 (AC-32): seal 触发 → 持久化系统通知到 thread 消息流。
  // role 沿用 "assistant"（schema enum），messageType="system_notice" 让前端
  // timeline-panel 走专属分支（SystemNoticeBubble），与普通 assistant final 区分。
  appendSystemNoticeMessage(threadId: string, content: string) {
    return this.repository.appendMessage(threadId, "assistant", content, "", "system_notice")
  }

  overwriteMessage(
    messageId: string,
    updates: {
      content?: string
      thinking?: string
      toolEvents?: string
      contentBlocks?: string
      retryCount?: number
      retryReasons?: string
    },
  ) {
    this.repository.overwriteMessage(messageId, updates)
  }

  /**
   * F026 P3.1: 派发协议 retry 事件持久化（dispatch_validation_retry）。
   * 与 buildDispatchRetryAgentEventRow 配合使用，message-service 入库前命中即调用。
   */
  appendAgentEvent(record: {
    id: string
    invocationId: string
    threadId: string
    agentId: string
    eventType: string
    payload: string
    createdAt: string
  }) {
    this.repository.appendAgentEvent(record)
  }

  /**
   * F026 P11 · 暴露给 message-service 在 final flush 时读现存 content_blocks
   * 做 derive+merge（保留 image 块），不要回填覆盖独立路径写入的块。
   */
  getContentBlocksJson(messageId: string): string | null {
    return this.repository.getContentBlocksJson(messageId)
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
      message.model,
      message.retryCount,
      message.retryReasons,
      // F026 P5 T0 · 把 LEFT JOIN 出来的 a2a_calls 字段透传到 mapper
      {
        a2aCallId: message.a2aCallId,
        a2aParentCallId: message.a2aParentCallId,
        a2aRootCallId: message.a2aRootCallId,
        a2aOnBehalfOf: message.a2aOnBehalfOf,
        a2aConvenerId: message.a2aConvenerId,
        a2aCallStatus: message.a2aCallStatus,
        a2aDeadlineAt: message.a2aDeadlineAt,
      },
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

  updateThread(
    threadId: string,
    model: string | null,
    nativeSessionId: string | null,
    sopBookmark?: string | null,
    lastFillRatio?: number | null,
  ) {
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
    messageType:
      | "progress"
      | "final"
      | "a2a_handoff"
      | "a2a_handoff_mcp"
      | "connector"
      | "system_notice" = "final",
    connectorSource?: ConnectorSource,
    groupId?: string | null,
    groupRole?: "header" | "member" | "convergence" | null,
    toolEvents?: ToolEvent[],
    contentBlocks?: ContentBlock[],
    messageModel: string | null = null,
    retryCount: number = 0,
    retryReasonsJson: string = "[]",
    a2aMeta: {
      a2aCallId?: string | null
      a2aParentCallId?: string | null
      a2aRootCallId?: string | null
      a2aOnBehalfOf?: string | null
      a2aConvenerId?: string | null
      a2aCallStatus?: string | null
      a2aDeadlineAt?: string | null
    } = {},
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
      // F021 Phase 5: prefer per-message snapshot. Fallback to thread.currentModel
      // for legacy rows persisted before the messages.model column existed.
      model: role === "user" ? null : (messageModel ?? thread.currentModel),
      // F026 P3.1: 派发协议 retry 计数 + 原因（assistant final 入库前 hook 写入）
      retryCount: retryCount > 0 ? retryCount : undefined,
      retryReasons: (() => {
        if (retryCount === 0) return undefined
        try {
          const parsed = JSON.parse(retryReasonsJson)
          return Array.isArray(parsed) && parsed.length > 0
            ? (parsed as import("@multi-agent/shared").DispatchValidationRetryReason[])
            : undefined
        } catch {
          return undefined
        }
      })(),
      // F026 P5 T0 · A2A 协议字段（LEFT JOIN a2a_calls 取自 mapper 入参；
      //   不带 a2aCallId 的老消息 / 非 a2a 派发，所有字段为 undefined → 前端不渲染原语）
      a2aCallId: a2aMeta.a2aCallId ?? undefined,
      a2aParentCallId: a2aMeta.a2aParentCallId ?? undefined,
      a2aRootCallId: a2aMeta.a2aRootCallId ?? undefined,
      a2aOnBehalfOf: a2aMeta.a2aOnBehalfOf ?? undefined,
      a2aConvenerId: a2aMeta.a2aConvenerId ?? undefined,
      a2aCallStatus: a2aMeta.a2aCallStatus ?? undefined,
      a2aDeadlineAt: a2aMeta.a2aDeadlineAt ?? undefined,
      // displayMode 从 envelope-builder.ts:30 同款 derive：parentCallId 非空 → nested
      a2aDisplayMode: a2aMeta.a2aCallId
        ? a2aMeta.a2aParentCallId
          ? "nested"
          : "inline"
        : undefined,
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

  // F021 Phase 3.3: merge session's pending runtime-config into active,
  // clear pending, return the resulting active. Called at invocation start.
  flushSessionPending(sessionGroupId: string): Record<string, unknown> {
    return this.repository.flushSessionPending(sessionGroupId)
  }
}
