import crypto from "node:crypto"
import type { Provider } from "@multi-agent/shared"
import { PROVIDERS, PROVIDER_ALIASES } from "@multi-agent/shared"
import { eq, desc, asc, like, or, and, sql } from "drizzle-orm"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import {
  sessionGroups,
  threads,
  messages,
  invocations,
  agentEvents,
  sessionMemories,
  tasks,
} from "../schema"
import type {
  ConnectorSourceRecord,
  InvocationRecord,
  MessageRecord,
  MessageType,
  ProviderThreadRecord,
  SessionMemoryRecord,
} from "../sqlite"

type DrizzleDb = BetterSQLite3Database<typeof import("../schema")>

function hydrateMessage(row: typeof messages.$inferSelect): MessageRecord {
  return {
    id: row.id,
    threadId: row.threadId,
    role: row.role as "user" | "assistant",
    content: row.content,
    thinking: row.thinking,
    messageType: row.messageType as MessageType,
    connectorSource: row.connectorSource
      ? (JSON.parse(row.connectorSource) as ConnectorSourceRecord)
      : null,
    groupId: row.groupId ?? null,
    groupRole: (row.groupRole as MessageRecord["groupRole"]) ?? null,
    toolEvents: row.toolEvents ?? "[]",
    contentBlocks: row.contentBlocks ?? "[]",
    createdAt: row.createdAt,
  }
}

export class DrizzleSessionRepository {
  // F022 Phase 3.5 (review P1-2): Haiku 命名失败的 session 最多重试 N 次；
  // 超过后 backfill 永久跳过，防止 Haiku 不可用时重启风暴。
  // 手动重命名（titleLockedAt）会直接让 SessionTitler.skip.locked，不需要清 attempts。
  // 若未来提供"重新命名"入口想恢复 Haiku，应同步在对应 service 层调 resetTitleBackfillAttempts。
  static readonly MAX_TITLE_BACKFILL_ATTEMPTS = 3

  constructor(private readonly db: DrizzleDb) {}

  runTx<T>(fn: () => T): T {
    return this.db.transaction(() => fn())
  }

  getSessionGroupById(groupId: string) {
    const rows = this.db
      .select()
      .from(sessionGroups)
      .where(eq(sessionGroups.id, groupId))
      .limit(1)
      .all()
    if (rows.length === 0) return undefined
    const r = rows[0]
    return {
      id: r.id,
      roomId: r.roomId,
      title: r.title,
      projectTag: r.projectTag,
      titleLockedAt: r.titleLockedAt ?? null,
      archivedAt: r.archivedAt ?? null,
      deletedAt: r.deletedAt ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }
  }

  // F022 Phase 1: 全局递增 ROOM ID 分配。
  // MAX 扫全表 + 1；格式 `R-{padStart(3)}`，超过 999 自然扩位。
  // SQLite WAL 单写进程场景下串行执行，无需额外锁。
  private allocateNextRoomId(): string {
    const rows = this.db
      .select({
        maxSeq: sql<number | null>`MAX(CAST(SUBSTR(room_id, 3) AS INTEGER))`,
      })
      .from(sessionGroups)
      .where(sql`room_id IS NOT NULL AND room_id LIKE 'R-%'`)
      .all()
    const next = (rows[0]?.maxSeq ?? 0) + 1
    return `R-${String(next).padStart(3, "0")}`
  }

  // F022 Phase 3.5 (AC-14i/j): 主列表只看活跃项；归档/软删进归档列表。
  listSessionGroups(limit = 200) {
    const groupIds = this.db
      .select({ id: sessionGroups.id })
      .from(sessionGroups)
      .where(sql`archived_at IS NULL AND deleted_at IS NULL`)
      .orderBy(desc(sessionGroups.updatedAt))
      .limit(limit)
      .all()
      .map(r => r.id)

    if (groupIds.length === 0) return []

    const rows = this.db
      .select({
        id: sessionGroups.id,
        roomId: sessionGroups.roomId,
        title: sessionGroups.title,
        projectTag: sessionGroups.projectTag,
        titleLockedAt: sessionGroups.titleLockedAt,
        archivedAt: sessionGroups.archivedAt,
        deletedAt: sessionGroups.deletedAt,
        createdAt: sessionGroups.createdAt,
        updatedAt: sessionGroups.updatedAt,
        provider: threads.provider,
        alias: threads.alias,
        lastMessage: sql<string | null>`(SELECT content FROM messages WHERE thread_id = ${threads.id} ORDER BY created_at DESC LIMIT 1)`,
        msgCount: sql<number>`(SELECT COUNT(*) FROM messages WHERE thread_id = ${threads.id})`,
      })
      .from(sessionGroups)
      .leftJoin(threads, eq(threads.sessionGroupId, sessionGroups.id))
      .where(sql`${sessionGroups.id} IN (${sql.join(groupIds.map(id => sql`${id}`), sql`, `)})`)
      .orderBy(desc(sessionGroups.updatedAt), asc(threads.provider))
      .all()

    const groupMap = new Map<
      string,
      {
        id: string
        roomId: string | null
        title: string
        projectTag: string | null
        titleLockedAt: string | null
        archivedAt: string | null
        deletedAt: string | null
        createdAt: string
        updatedAt: string
        previews: Array<{ provider: Provider; alias: string; text: string }>
        participants: Provider[]
        messageCount: number
      }
    >()

    for (const row of rows) {
      let group = groupMap.get(row.id)
      if (!group) {
        group = {
          id: row.id,
          roomId: row.roomId ?? null,
          title: row.title,
          projectTag: row.projectTag ?? null,
          titleLockedAt: row.titleLockedAt ?? null,
          archivedAt: row.archivedAt ?? null,
          deletedAt: row.deletedAt ?? null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          previews: [],
          participants: [],
          messageCount: 0,
        }
        groupMap.set(row.id, group)
      }
      if (row.provider) {
        group.previews.push({
          provider: row.provider as Provider,
          alias: row.alias!,
          text: (row.lastMessage ?? "").slice(0, 80),
        })
        const count = Number(row.msgCount ?? 0)
        group.messageCount += count
        if (count > 0 && !group.participants.includes(row.provider as Provider)) {
          group.participants.push(row.provider as Provider)
        }
      }
    }

    for (const g of groupMap.values()) g.participants.sort()
    return Array.from(groupMap.values())
  }

  createSessionGroup(title?: string) {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    const roomId = this.allocateNextRoomId()

    this.db
      .insert(sessionGroups)
      .values({
        id,
        roomId,
        title: title ?? `新会话 ${now.slice(0, 19).replace("T", " ")}`,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    return id
  }

  updateSessionGroupProjectTag(groupId: string, tag: string | null) {
    this.db
      .update(sessionGroups)
      .set({ projectTag: tag })
      .where(eq(sessionGroups.id, groupId))
      .run()
  }

  // F022 Phase 3.5 (AC-14g): manual=true 时写 title_locked_at，SessionTitler 看 lock 跳过覆盖。
  // 自动命名（Haiku）调用保持原 behavior — 不写 lock。
  updateSessionGroupTitle(
    groupId: string,
    title: string,
    opts: { manual?: boolean } = {},
  ) {
    const now = new Date().toISOString()
    const patch: { title: string; updatedAt: string; titleLockedAt?: string } = {
      title,
      updatedAt: now,
    }
    if (opts.manual) patch.titleLockedAt = now
    this.db
      .update(sessionGroups)
      .set(patch)
      .where(eq(sessionGroups.id, groupId))
      .run()
  }

  // F022 Phase 3.5 (AC-14i)
  archiveSessionGroup(groupId: string) {
    const now = new Date().toISOString()
    this.db
      .update(sessionGroups)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(sessionGroups.id, groupId))
      .run()
  }

  // F022 Phase 3.5 (AC-14j) — 软删，禁物删
  softDeleteSessionGroup(groupId: string) {
    const now = new Date().toISOString()
    this.db
      .update(sessionGroups)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(sessionGroups.id, groupId))
      .run()
  }

  // F022 Phase 3.5 (AC-14i/j) — 恢复：清 archived_at 和 deleted_at 回到主列表
  restoreSessionGroup(groupId: string) {
    const now = new Date().toISOString()
    this.db
      .update(sessionGroups)
      .set({ archivedAt: null, deletedAt: null, updatedAt: now })
      .where(eq(sessionGroups.id, groupId))
      .run()
  }

  // F022 Phase 3.5 (review P1-1/P1-2): title backfill 专用扫描。
  // - 不分页：listSessionGroups 默认 200 会让历史规模大时漏扫老会话
  // - 只过滤软删（deleted_at）；归档会话允许 backfill（归档≠不命名）
  // - 过滤 title_backfill_attempts < MAX：防止 Haiku 永久挂时每次启动风暴
  // - 只取 id + title 两列，前端永远不消费这条路径
  listSessionGroupsForBackfill(): Array<{ id: string; title: string | null }> {
    const rows = this.db
      .select({ id: sessionGroups.id, title: sessionGroups.title })
      .from(sessionGroups)
      .where(
        sql`deleted_at IS NULL AND title_backfill_attempts < ${DrizzleSessionRepository.MAX_TITLE_BACKFILL_ATTEMPTS}`,
      )
      .all()
    return rows.map((r) => ({ id: r.id, title: r.title }))
  }

  incrementTitleBackfillAttempts(id: string): void {
    this.db
      .update(sessionGroups)
      .set({ titleBackfillAttempts: sql`title_backfill_attempts + 1` })
      .where(eq(sessionGroups.id, id))
      .run()
  }

  resetTitleBackfillAttempts(id: string): void {
    this.db
      .update(sessionGroups)
      .set({ titleBackfillAttempts: 0 })
      .where(eq(sessionGroups.id, id))
      .run()
  }

  // F022 Phase 3.5 (AC-14i/j) — 归档列表：archived_at 或 deleted_at 非 NULL。
  // 按更新时间降序，最新动的排前面。
  listArchivedSessionGroups(limit = 200) {
    const rows = this.db
      .select({
        id: sessionGroups.id,
        roomId: sessionGroups.roomId,
        title: sessionGroups.title,
        projectTag: sessionGroups.projectTag,
        titleLockedAt: sessionGroups.titleLockedAt,
        archivedAt: sessionGroups.archivedAt,
        deletedAt: sessionGroups.deletedAt,
        createdAt: sessionGroups.createdAt,
        updatedAt: sessionGroups.updatedAt,
      })
      .from(sessionGroups)
      .where(sql`archived_at IS NOT NULL OR deleted_at IS NOT NULL`)
      .orderBy(desc(sessionGroups.updatedAt))
      .limit(limit)
      .all()
    return rows.map(r => ({
      id: r.id,
      roomId: r.roomId ?? null,
      title: r.title,
      projectTag: r.projectTag ?? null,
      titleLockedAt: r.titleLockedAt ?? null,
      archivedAt: r.archivedAt ?? null,
      deletedAt: r.deletedAt ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }))
  }

  createThread(sessionGroupId: string, provider: Provider, currentModel: string | null) {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()

    this.db
      .insert(threads)
      .values({
        id,
        sessionGroupId,
        provider,
        alias: PROVIDER_ALIASES[provider],
        currentModel,
        updatedAt: now,
      })
      .run()

    return id
  }

  ensureDefaultThreads(sessionGroupId: string, defaults: Record<Provider, string | null>) {
    for (const provider of PROVIDERS) {
      const existing = this.db
        .select({ id: threads.id })
        .from(threads)
        .where(and(eq(threads.sessionGroupId, sessionGroupId), eq(threads.provider, provider)))
        .limit(1)
        .all()

      if (existing.length === 0) {
        this.createThread(sessionGroupId, provider, defaults[provider])
      }
    }
  }


  createSessionGroupWithDefaults(defaults: Record<Provider, string | null>, title?: string): string {
    const roomId = this.allocateNextRoomId()
    return this.db.transaction((tx) => {
      const now = new Date().toISOString()
      const id = crypto.randomUUID()

      tx.insert(sessionGroups)
        .values({
          id,
          roomId,
          title: title ?? `新会话 ${now.slice(0, 19).replace("T", " ")}`,
          createdAt: now,
          updatedAt: now,
        })
        .run()

      for (const provider of PROVIDERS) {
        tx.insert(threads)
          .values({
            id: crypto.randomUUID(),
            sessionGroupId: id,
            provider,
            alias: PROVIDER_ALIASES[provider],
            currentModel: defaults[provider],
            updatedAt: now,
          })
          .run()
      }

      return id
    }) as string
  }

  listThreadsByGroup(sessionGroupId: string): ProviderThreadRecord[] {
    return (this.db
      .select()
      .from(threads)
      .where(eq(threads.sessionGroupId, sessionGroupId))
      .orderBy(asc(threads.provider))
      .all()) as ProviderThreadRecord[]
  }

  getThreadById(threadId: string): ProviderThreadRecord | undefined {
    const rows = this.db
      .select()
      .from(threads)
      .where(eq(threads.id, threadId))
      .limit(1)
      .all()
    return rows[0] as ProviderThreadRecord | undefined
  }

  listMessages(threadId: string, limit = 1000): MessageRecord[] {
    const rows = this.db
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(asc(messages.createdAt))
      .limit(limit)
      .all()
    return rows.map(hydrateMessage)
  }

  listMessagesSince(threadId: string, sinceTimestamp: string): MessageRecord[] {
    const rows = this.db
      .select()
      .from(messages)
      .where(and(eq(messages.threadId, threadId), sql`${messages.createdAt} > ${sinceTimestamp}`))
      .orderBy(asc(messages.createdAt))
      .all()
    return rows.map(hydrateMessage)
  }

  listRecentMessages(threadId: string, limit: number): MessageRecord[] {
    const rows = this.db
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(desc(messages.createdAt))
      .limit(limit)
      .all()
    return rows.map(hydrateMessage)
  }

  appendMessage(
    threadId: string,
    role: "user" | "assistant",
    content: string,
    thinking = "",
    messageType: MessageType = "final",
    connectorSource: ConnectorSourceRecord | null = null,
    groupId: string | null = null,
    groupRole: MessageRecord["groupRole"] = null,
    toolEvents = "[]",
    contentBlocks = "[]",
  ): MessageRecord {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()

    const message: MessageRecord = {
      id,
      threadId,
      role,
      content,
      thinking,
      messageType,
      connectorSource,
      groupId,
      groupRole,
      toolEvents,
      contentBlocks,
      createdAt: now,
    }

    this.db
      .insert(messages)
      .values({
        id,
        threadId,
        role,
        content,
        thinking,
        messageType,
        connectorSource: connectorSource ? JSON.stringify(connectorSource) : null,
        groupId,
        groupRole,
        toolEvents,
        contentBlocks,
        createdAt: now,
      })
      .run()

    this.touchThread(threadId, now)
    return message
  }

  overwriteMessage(messageId: string, updates: { content?: string; thinking?: string; toolEvents?: string; contentBlocks?: string }) {
    this.db.transaction((tx) => {
      const current = tx
      .select({ content: messages.content, thinking: messages.thinking, toolEvents: messages.toolEvents, contentBlocks: messages.contentBlocks })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
      .all()

    if (current.length === 0) return

      tx
      .update(messages)
      .set({
        content: updates.content ?? current[0].content,
        thinking: updates.thinking ?? current[0].thinking,
        toolEvents: updates.toolEvents ?? current[0].toolEvents,
        contentBlocks: updates.contentBlocks ?? current[0].contentBlocks,
      })
      .where(eq(messages.id, messageId))
      .run()
    })
  }

  appendContentBlock(messageId: string, block: { type: string; [key: string]: unknown }) {
    this.db.transaction((tx) => {
      const current = tx
        .select({ contentBlocks: messages.contentBlocks })
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1)
        .all()

      if (current.length === 0) return

      const blocks = JSON.parse(current[0].contentBlocks || "[]") as unknown[]
      blocks.push(block)

      tx
        .update(messages)
        .set({ contentBlocks: JSON.stringify(blocks) })
        .where(eq(messages.id, messageId))
        .run()
    })
  }

  createInvocation(record: InvocationRecord) {
    this.db
      .insert(invocations)
      .values({
        id: record.id,
        threadId: record.threadId,
        agentId: record.agentId,
        callbackToken: record.callbackToken,
        status: record.status,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        exitCode: record.exitCode,
        lastActivityAt: record.lastActivityAt,
      })
      .run()
  }

  getInvocationById(invocationId: string) {
    const rows = this.db
      .select()
      .from(invocations)
      .where(eq(invocations.id, invocationId))
      .limit(1)
      .all()
    return rows[0]
  }

  getInvocationByCredentials(invocationId: string, callbackToken: string) {
    const rows = this.db
      .select()
      .from(invocations)
      .where(
        and(eq(invocations.id, invocationId), eq(invocations.callbackToken, callbackToken)),
      )
      .limit(1)
      .all()
    return rows[0]
  }

  updateInvocation(
    invocationId: string,
    updates: {
      status?: string
      finishedAt?: string | null
      exitCode?: number | null
      lastActivityAt?: string | null
    },
  ) {
    const current = this.getInvocationById(invocationId)
    if (!current) return

    this.db
      .update(invocations)
      .set({
        status: updates.status ?? current.status,
        finishedAt: updates.finishedAt ?? current.finishedAt,
        exitCode: updates.exitCode ?? current.exitCode,
        lastActivityAt: updates.lastActivityAt ?? current.lastActivityAt,
      })
      .where(eq(invocations.id, invocationId))
      .run()
  }

  appendAgentEvent(record: {
    id: string
    invocationId: string
    threadId: string
    agentId: string
    eventType: string
    payload: string
    createdAt: string
  }) {
    this.db
      .insert(agentEvents)
      .values({
        id: record.id,
        invocationId: record.invocationId,
        threadId: record.threadId,
        agentId: record.agentId,
        eventType: record.eventType,
        payload: record.payload,
        createdAt: record.createdAt,
      })
      .run()
  }

  // F018 P3: ThreadMemory rolling summary persistence
  getThreadMemory(
    threadId: string,
  ): { summary: string; sessionCount: number; lastUpdatedAt: string } | null {
    const rows = this.db
      .select({ threadMemory: threads.threadMemory })
      .from(threads)
      .where(eq(threads.id, threadId))
      .limit(1)
      .all()
    const raw = rows[0]?.threadMemory
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  setThreadMemory(
    threadId: string,
    memory: { summary: string; sessionCount: number; lastUpdatedAt: string },
  ): void {
    this.db
      .update(threads)
      .set({ threadMemory: JSON.stringify(memory) })
      .where(eq(threads.id, threadId))
      .run()
  }

  // F018 P3 AC3.5: Session chain index for Bootstrap identity section
  getSessionChainIndex(threadId: string): number {
    const rows = this.db
      .select({ sessionChainIndex: threads.sessionChainIndex })
      .from(threads)
      .where(eq(threads.id, threadId))
      .limit(1)
      .all()
    return rows[0]?.sessionChainIndex ?? 1
  }

  incrementSessionChainIndex(threadId: string): void {
    this.db
      .update(threads)
      .set({ sessionChainIndex: sql`${threads.sessionChainIndex} + 1` })
      .where(eq(threads.id, threadId))
      .run()
  }

  updateThread(
    threadId: string,
    updates: {
      currentModel?: string | null
      nativeSessionId?: string | null
      sopBookmark?: string | null
      lastFillRatio?: number | null
    },
  ) {
    const updatedAt = new Date().toISOString()
    const setValues: Record<string, unknown> = { updatedAt }

    if ("currentModel" in updates) setValues.currentModel = updates.currentModel ?? null
    if ("nativeSessionId" in updates) setValues.nativeSessionId = updates.nativeSessionId ?? null
    if ("sopBookmark" in updates) setValues.sopBookmark = updates.sopBookmark ?? null
    if ("lastFillRatio" in updates) setValues.lastFillRatio = updates.lastFillRatio ?? null

    this.db.update(threads).set(setValues).where(eq(threads.id, threadId)).run()
    this.touchThread(threadId, updatedAt)
  }

  reconcileLegacyDefaultModels(
    replacements: Record<Provider, { from: string[]; to: string | null }>,
  ) {
    this.db.transaction((tx) => {
    const updatedAt = new Date().toISOString()

    for (const provider of PROVIDERS) {
      const replacement = replacements[provider]
      if (!replacement?.to || !replacement.from.length) continue

      tx
        .update(threads)
        .set({ currentModel: replacement.to, updatedAt })
        .where(
          and(
            eq(threads.provider, provider),
            sql`${threads.currentModel} IN (${sql.join(
              replacement.from.map((v) => sql`${v}`),
              sql`, `,
            )})`,
          ),
        )
        .run()
    }
    })
}

  private touchThread(threadId: string, updatedAt: string) {
    this.db.transaction((tx) => {
      tx.update(threads).set({ updatedAt }).where(eq(threads.id, threadId)).run()

      const row = tx
      .select({ sessionGroupId: threads.sessionGroupId })
      .from(threads)
      .where(eq(threads.id, threadId))
      .limit(1)
      .all()

      if (row.length > 0) {
        tx
        .update(sessionGroups)
        .set({ updatedAt })
        .where(eq(sessionGroups.id, row[0].sessionGroupId))
        .run()
      }
    })
  }

  createMemory(sessionGroupId: string, summary: string, keywords: string): SessionMemoryRecord {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    this.db
      .insert(sessionMemories)
      .values({ id, sessionGroupId, summary, keywords, createdAt: now })
      .run()

    return { id, sessionGroupId, summary, keywords, createdAt: now }
  }

  listMemories(sessionGroupId: string, limit = 100): SessionMemoryRecord[] {
    return this.db
      .select()
      .from(sessionMemories)
      .where(eq(sessionMemories.sessionGroupId, sessionGroupId))
      .orderBy(desc(sessionMemories.createdAt))
      .limit(limit)
      .all()
  }

  searchMemories(keyword: string, limit = 50): SessionMemoryRecord[] {
    const pattern = `%${keyword}%`
    return this.db
      .select()
      .from(sessionMemories)
      .where(or(like(sessionMemories.keywords, pattern), like(sessionMemories.summary, pattern)))
      .orderBy(desc(sessionMemories.createdAt))
      .limit(limit)
      .all()
  }

  getLatestMemory(sessionGroupId: string): SessionMemoryRecord | null {
    const rows = this.db
      .select()
      .from(sessionMemories)
      .where(eq(sessionMemories.sessionGroupId, sessionGroupId))
      .orderBy(desc(sessionMemories.createdAt))
      .limit(1)
      .all()
    return rows[0] ?? null
  }


  listAllMessagesForGroup(sessionGroupId: string, limit = 1000): Array<MessageRecord & { alias: string }> {
    const rows = this.db
      .select({
        id: messages.id,
        threadId: messages.threadId,
        role: messages.role,
        content: messages.content,
        thinking: messages.thinking,
        messageType: messages.messageType,
        connectorSource: messages.connectorSource,
        groupId: messages.groupId,
        groupRole: messages.groupRole,
        toolEvents: messages.toolEvents,
        contentBlocks: messages.contentBlocks,
        createdAt: messages.createdAt,
        alias: threads.alias,
      })
      .from(messages)
      .innerJoin(threads, eq(messages.threadId, threads.id))
      .where(eq(threads.sessionGroupId, sessionGroupId))
      .orderBy(asc(messages.createdAt))
      .limit(limit)
      .all()
    return rows.map((row) => ({
      ...hydrateMessage(row),
      alias: row.alias,
    }))
  }

  countUserMessagesSince(sessionGroupId: string, sinceTimestamp: string): number {
    const rows = this.db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .innerJoin(threads, eq(messages.threadId, threads.id))
      .where(
        and(
          eq(threads.sessionGroupId, sessionGroupId),
          eq(messages.role, sql`'user'`),
          sql`${messages.createdAt} > ${sinceTimestamp}`,
        ),
      )
      .all()
    return rows[0]?.count ?? 0
  }

  createTask(
    sessionGroupId: string,
    assignee: string,
    description: string,
    createdBy: string,
    priority = "medium",
  ) {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    this.db
      .insert(tasks)
      .values({
        id,
        sessionGroupId,
        assigneeAgentId: assignee,
        description,
        priority,
        status: "pending",
        createdBy,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    return { id, sessionGroupId, assignee, description, priority, status: "pending" as const, createdBy, createdAt: now }
  }
}
