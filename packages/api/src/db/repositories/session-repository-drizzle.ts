import crypto from "node:crypto"
import type { Provider } from "@multi-agent/shared"
import { PROVIDERS, PROVIDER_ALIASES, stripRichFencesForPreview } from "@multi-agent/shared"
import { and, asc, desc, eq, like, lt, or, sql } from "drizzle-orm"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import {
  a2aCalls,
  agentEvents,
  invocations,
  messages,
  sessionGroups,
  sessionMemories,
  tasks,
  threads,
} from "../schema"
import type {
  ConnectorSourceRecord,
  InvocationRecord,
  MessageRecord,
  MessageType,
  ProviderThreadRecord,
  SessionMemoryRecord,
} from "../sqlite"
import { mergeRuntimeConfigFieldwise } from "./runtime-config-merge"

type DrizzleDb = BetterSQLite3Database<typeof import("../schema")>

export type GroupMessageCursor = {
  createdAt: string
  rowid: number
}

export type GroupMessagesPage = {
  messages: MessageRecord[]
  hasMore: boolean
  nextCursor: GroupMessageCursor | null
}

// F026 P5 in-flight · drizzle 路径补 LEFT JOIN a2a_calls 后的合并行类型。
// 4 个 list* 方法显式 select 同一份字段集（messages 全列 + a2a_calls 6 个协议列），
// 然后统一过 hydrateMessage。LEFT JOIN 时 a2a_calls 无匹配 → 6 字段为 null（非 a2a 消息正常态）。
type MessageRowWithA2a = {
  id: string
  threadId: string
  role: string
  content: string
  thinking: string
  messageType: string
  connectorSource: string | null
  groupId: string | null
  groupRole: string | null
  toolEvents: string
  contentBlocks: string
  createdAt: string
  model: string | null
  retryCount: number
  retryReasons: string
  senderDisplayName: string | null
  // F043 AC5 · turn 聚合 token 明细（NULL=无数据）
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheCreationTokens: number | null
  a2aCallId: string | null
  a2aParentCallId: string | null
  a2aRootCallId: string | null
  a2aOnBehalfOf: string | null
  a2aConvenerId: string | null
  a2aCallStatus: string | null
  a2aDeadlineAt: string | null
}

function hydrateMessage(row: MessageRowWithA2a): MessageRecord {
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
    model: row.model ?? null,
    retryCount: row.retryCount ?? 0,
    retryReasons: row.retryReasons ?? "[]",
    senderDisplayName: row.senderDisplayName ?? null,
    // F043 AC5 · NULL 原样透传（≠0，MessageMeta 据此决定渲染）
    inputTokens: row.inputTokens ?? null,
    outputTokens: row.outputTokens ?? null,
    cacheReadTokens: row.cacheReadTokens ?? null,
    cacheCreationTokens: row.cacheCreationTokens ?? null,
    a2aCallId: row.a2aCallId ?? null,
    a2aParentCallId: row.a2aParentCallId ?? null,
    a2aRootCallId: row.a2aRootCallId ?? null,
    a2aOnBehalfOf: row.a2aOnBehalfOf ?? null,
    a2aConvenerId: row.a2aConvenerId ?? null,
    a2aCallStatus: row.a2aCallStatus ?? null,
    a2aDeadlineAt: row.a2aDeadlineAt ?? null,
  }
}

const MESSAGE_WITH_A2A_SELECT = {
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
  model: messages.model,
  retryCount: messages.retryCount,
  retryReasons: messages.retryReasons,
  // F040 P2 T11 · 群桥接归因真名（user 消息；历史/web 消息 NULL → timeline 回落村长）
  senderDisplayName: messages.senderDisplayName,
  inputTokens: messages.inputTokens,
  outputTokens: messages.outputTokens,
  cacheReadTokens: messages.cacheReadTokens,
  cacheCreationTokens: messages.cacheCreationTokens,
  a2aCallId: messages.a2aCallId,
  a2aParentCallId: a2aCalls.parentCallId,
  a2aRootCallId: a2aCalls.rootCallId,
  a2aOnBehalfOf: a2aCalls.onBehalfOf,
  a2aConvenerId: a2aCalls.convenerId,
  a2aCallStatus: a2aCalls.status,
  a2aDeadlineAt: a2aCalls.deadlineAt,
} as const

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
      .map((r) => r.id)

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
        lastMessage: sql<
          string | null
        >`(SELECT content FROM messages WHERE thread_id = ${threads.id} ORDER BY created_at DESC LIMIT 1)`,
        msgCount: sql<number>`(SELECT COUNT(*) FROM messages WHERE thread_id = ${threads.id})`,
      })
      .from(sessionGroups)
      .leftJoin(threads, eq(threads.sessionGroupId, sessionGroups.id))
      .where(
        sql`${sessionGroups.id} IN (${sql.join(
          groupIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      )
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
          // F030 r4 P2：剔除 cc_rich 围栏再截断，防未闭合卡片 JSON 漏进侧栏（/api/bootstrap 走此路径）
          text: stripRichFencesForPreview(row.lastMessage ?? "").slice(0, 80),
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

  // F021 Phase 2.2 / 3.3: per-session runtime-config overrides.
  // Stored as JSON blob `{active, pending}`; legacy flat blobs read as
  // `{active: <flat>, pending: {}}` so existing rows keep working.
  private readRuntimeConfigBlob(groupId: string): {
    active: Record<string, unknown>
    pending: Record<string, unknown>
  } {
    const rows = this.db
      .select({ runtimeConfig: sessionGroups.runtimeConfig })
      .from(sessionGroups)
      .where(eq(sessionGroups.id, groupId))
      .limit(1)
      .all()
    if (rows.length === 0) return { active: {}, pending: {} }
    const raw = rows[0]?.runtimeConfig
    if (!raw) return { active: {}, pending: {} }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { active: {}, pending: {} }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { active: {}, pending: {} }
    }
    const obj = parsed as Record<string, unknown>
    if ("active" in obj || "pending" in obj) {
      const active =
        obj.active && typeof obj.active === "object" && !Array.isArray(obj.active)
          ? (obj.active as Record<string, unknown>)
          : {}
      const pending =
        obj.pending && typeof obj.pending === "object" && !Array.isArray(obj.pending)
          ? (obj.pending as Record<string, unknown>)
          : {}
      return { active, pending }
    }
    return { active: obj, pending: {} }
  }

  private writeRuntimeConfigBlob(
    groupId: string,
    blob: { active: Record<string, unknown>; pending: Record<string, unknown> },
  ): void {
    this.db
      .update(sessionGroups)
      .set({ runtimeConfig: JSON.stringify(blob) })
      .where(eq(sessionGroups.id, groupId))
      .run()
  }

  getSessionRuntimeConfig(groupId: string): Record<string, unknown> {
    return this.readRuntimeConfigBlob(groupId).active
  }

  setSessionRuntimeConfig(groupId: string, config: Record<string, unknown>): void {
    const { pending } = this.readRuntimeConfigBlob(groupId)
    this.writeRuntimeConfigBlob(groupId, { active: config ?? {}, pending })
  }

  getSessionPendingConfig(groupId: string): Record<string, unknown> {
    return this.readRuntimeConfigBlob(groupId).pending
  }

  setSessionPendingConfig(groupId: string, pending: Record<string, unknown>): void {
    const { active } = this.readRuntimeConfigBlob(groupId)
    this.writeRuntimeConfigBlob(groupId, { active, pending: pending ?? {} })
  }

  flushSessionPending(groupId: string): Record<string, unknown> {
    // F021 P1 (范德彪 二轮 review): provider 内按字段 merge，不能 provider 级浅覆盖。
    const { active, pending } = this.readRuntimeConfigBlob(groupId)
    const merged = mergeRuntimeConfigFieldwise(active, pending)
    this.writeRuntimeConfigBlob(groupId, { active: merged, pending: {} })
    return merged
  }

  // F022 Phase 3.5 (AC-14g): manual=true 时写 title_locked_at，SessionTitler 跳过覆盖。
  updateSessionGroupTitle(groupId: string, title: string, opts: { manual?: boolean } = {}) {
    const now = new Date().toISOString()
    const patch: { title: string; updatedAt: string; titleLockedAt?: string } = {
      title,
      updatedAt: now,
    }
    if (opts.manual) patch.titleLockedAt = now
    this.db.update(sessionGroups).set(patch).where(eq(sessionGroups.id, groupId)).run()
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

  // F022 Phase 3.5 (AC-14i/j) — 归档列表
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
    return rows.map((r) => ({
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

  createSessionGroupWithDefaults(
    defaults: Record<Provider, string | null>,
    title?: string,
  ): string {
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
    return this.db
      .select()
      .from(threads)
      .where(eq(threads.sessionGroupId, sessionGroupId))
      .orderBy(asc(threads.provider))
      .all() as ProviderThreadRecord[]
  }

  getThreadById(threadId: string): ProviderThreadRecord | undefined {
    const rows = this.db.select().from(threads).where(eq(threads.id, threadId)).limit(1).all()
    return rows[0] as ProviderThreadRecord | undefined
  }

  listMessages(threadId: string, limit?: number): MessageRecord[] {
    // F011 originally added `limit = 1000` as a memory guard, but every caller
    // ("getActiveGroup", "context-assembler", "chain-starter-resolver", titler …)
    // wants the FULL conversation. Combined with `ORDER BY createdAt ASC` this
    // silently truncated the NEWEST messages once a thread crossed 1000, so the
    // UI stopped showing fresh user/assistant messages. Default is now unlimited;
    // callers needing a cap pass it explicitly.
    // F026 P13 · `, messages.rowid` 显式 tiebreaker — 同 ms 多条 message 保插入顺序
    // F026 P5 in-flight · LEFT JOIN a2a_calls hydrate 6 协议字段（前端 AtPill 反查必需）
    const query = this.db
      .select(MESSAGE_WITH_A2A_SELECT)
      .from(messages)
      .leftJoin(a2aCalls, eq(a2aCalls.callId, messages.a2aCallId))
      .where(eq(messages.threadId, threadId))
      .orderBy(asc(messages.createdAt), sql`messages.rowid ASC`)
    const rows = limit !== undefined ? query.limit(limit).all() : query.all()
    return rows.map(hydrateMessage)
  }

  listGroupMessagesPage(
    sessionGroupId: string,
    options: { limit: number; before?: GroupMessageCursor | null },
  ): GroupMessagesPage {
    const limit = Math.max(1, Math.floor(options.limit))
    const before = options.before ?? null
    const cursorWhere = before
      ? or(
          lt(messages.createdAt, before.createdAt),
          and(
            eq(messages.createdAt, before.createdAt),
            sql`messages.rowid < ${before.rowid}`,
          ),
        )
      : undefined
    const rows = this.db
      .select({
        ...MESSAGE_WITH_A2A_SELECT,
        rowid: sql<number>`messages.rowid`,
      })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .leftJoin(a2aCalls, eq(a2aCalls.callId, messages.a2aCallId))
      .where(and(eq(threads.sessionGroupId, sessionGroupId), cursorWhere))
      .orderBy(desc(messages.createdAt), sql`messages.rowid DESC`)
      .limit(limit + 1)
      .all()

    const hasMore = rows.length > limit
    const selectedRows = rows.slice(0, limit)
    const oldestSelected = selectedRows.at(-1)

    return {
      messages: selectedRows.reverse().map(hydrateMessage),
      hasMore,
      nextCursor:
        hasMore && oldestSelected
          ? { createdAt: oldestSelected.createdAt, rowid: oldestSelected.rowid }
          : null,
    }
  }

  listMessagesSince(threadId: string, sinceTimestamp: string): MessageRecord[] {
    const rows = this.db
      .select(MESSAGE_WITH_A2A_SELECT)
      .from(messages)
      .leftJoin(a2aCalls, eq(a2aCalls.callId, messages.a2aCallId))
      .where(and(eq(messages.threadId, threadId), sql`${messages.createdAt} > ${sinceTimestamp}`))
      .orderBy(asc(messages.createdAt), sql`messages.rowid ASC`)
      .all()
    return rows.map(hydrateMessage)
  }

  listRecentMessages(threadId: string, limit: number): MessageRecord[] {
    const rows = this.db
      .select(MESSAGE_WITH_A2A_SELECT)
      .from(messages)
      .leftJoin(a2aCalls, eq(a2aCalls.callId, messages.a2aCallId))
      .where(eq(messages.threadId, threadId))
      .orderBy(desc(messages.createdAt), sql`messages.rowid DESC`)
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
    model: string | null = null,
    a2aCallId: string | null = null,
    senderDisplayName: string | null = null,
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
      model,
      retryCount: 0,
      retryReasons: "[]",
      senderDisplayName,
      // F043 AC5 · append 时无 token 数据（turn 收尾 overwriteMessage 回填）
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      a2aCallId,
      a2aParentCallId: null,
      a2aRootCallId: null,
      a2aOnBehalfOf: null,
      a2aConvenerId: null,
      a2aCallStatus: null,
      a2aDeadlineAt: null,
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
        model,
        a2aCallId,
        senderDisplayName,
      })
      .run()

    this.touchThread(threadId, now)
    return message
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
      // F043 AC5 · turn 聚合 token 明细（"in updates" 三态：值/null 清列/缺省保持）
      inputTokens?: number | null
      outputTokens?: number | null
      cacheReadTokens?: number | null
      cacheCreationTokens?: number | null
    },
  ) {
    this.db.transaction((tx) => {
      const current = tx
        .select({
          content: messages.content,
          thinking: messages.thinking,
          toolEvents: messages.toolEvents,
          contentBlocks: messages.contentBlocks,
          retryCount: messages.retryCount,
          retryReasons: messages.retryReasons,
          inputTokens: messages.inputTokens,
          outputTokens: messages.outputTokens,
          cacheReadTokens: messages.cacheReadTokens,
          cacheCreationTokens: messages.cacheCreationTokens,
        })
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1)
        .all()

      if (current.length === 0) return

      tx.update(messages)
        .set({
          content: updates.content ?? current[0].content,
          thinking: updates.thinking ?? current[0].thinking,
          toolEvents: updates.toolEvents ?? current[0].toolEvents,
          contentBlocks: updates.contentBlocks ?? current[0].contentBlocks,
          retryCount: updates.retryCount ?? current[0].retryCount,
          retryReasons: updates.retryReasons ?? current[0].retryReasons,
          inputTokens: "inputTokens" in updates ? updates.inputTokens : current[0].inputTokens,
          outputTokens: "outputTokens" in updates ? updates.outputTokens : current[0].outputTokens,
          cacheReadTokens:
            "cacheReadTokens" in updates ? updates.cacheReadTokens : current[0].cacheReadTokens,
          cacheCreationTokens:
            "cacheCreationTokens" in updates
              ? updates.cacheCreationTokens
              : current[0].cacheCreationTokens,
        })
        .where(eq(messages.id, messageId))
        .run()
    })
  }

  /**
   * F026 P11 · 单独读 content_blocks JSON（不走 listMessages 全量 hydrate）。
   * 用于 message-service final flush 时 derive + merge 现存 image / 其他独立块。
   */
  getContentBlocksJson(messageId: string): string | null {
    const rows = this.db
      .select({ contentBlocks: messages.contentBlocks })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
      .all()
    return rows[0]?.contentBlocks ?? null
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

      tx.update(messages)
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
        configSnapshot: record.configSnapshot ?? null,
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
      .where(and(eq(invocations.id, invocationId), eq(invocations.callbackToken, callbackToken)))
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
      // F043 AC5/AC7 · 面板真值三列（三态：值/null 清列/缺省不动）
      lastUsedTokens?: number | null
      lastWindowTokens?: number | null
      lastUsageSource?: "exact" | "approx" | null
    },
  ) {
    const updatedAt = new Date().toISOString()
    const setValues: Record<string, unknown> = { updatedAt }

    if ("currentModel" in updates) setValues.currentModel = updates.currentModel ?? null
    if ("nativeSessionId" in updates) setValues.nativeSessionId = updates.nativeSessionId ?? null
    if ("sopBookmark" in updates) setValues.sopBookmark = updates.sopBookmark ?? null
    if ("lastFillRatio" in updates) setValues.lastFillRatio = updates.lastFillRatio ?? null
    if ("lastUsedTokens" in updates) setValues.lastUsedTokens = updates.lastUsedTokens ?? null
    if ("lastWindowTokens" in updates) setValues.lastWindowTokens = updates.lastWindowTokens ?? null
    if ("lastUsageSource" in updates) setValues.lastUsageSource = updates.lastUsageSource ?? null

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

        tx.update(threads)
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
        tx.update(sessionGroups)
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

  listAllMessagesForGroup(
    sessionGroupId: string,
    limit = 1000,
  ): Array<MessageRecord & { alias: string }> {
    // F026 P5 in-flight · 同样补 LEFT JOIN a2a_calls — 群级 timeline 也走 envelope 协议字段
    const rows = this.db
      .select({
        ...MESSAGE_WITH_A2A_SELECT,
        alias: threads.alias,
      })
      .from(messages)
      .innerJoin(threads, eq(messages.threadId, threads.id))
      .leftJoin(a2aCalls, eq(a2aCalls.callId, messages.a2aCallId))
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

    return {
      id,
      sessionGroupId,
      assignee,
      description,
      priority,
      status: "pending" as const,
      createdBy,
      createdAt: now,
    }
  }
}
