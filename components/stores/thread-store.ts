"use client"

import {
  applyMessageToSessionGroups,
  type ContentBlock,
  type DispatchValidationRetryReason,
  type InvocationStats,
  type PendingChangePayload,
  PROVIDERS,
  PROVIDER_ALIASES,
  type Provider,
  type ProviderCatalog,
  type SessionGroupSummary,
  type ThreadSnapshotDelta,
  type TimelineMessage,
  type ToolEvent,
  type WsWatermark,
} from "@multi-agent/shared"
import { create } from "zustand"
import { subscribeToRoom } from "@/components/ws/client"
// 循环仅存在于类型层（stream-monitor 只 type-import 本模块的 DeltaHoleInfo），运行时无环
import { streamMonitor } from "@/components/ws/stream-monitor"

type ProviderCardState = {
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

type ActiveGroupPayload = {
  id: string
  roomId: string | null
  title: string
  meta: string
  timeline: TimelineMessage[]
  hasPendingDispatches: boolean
  dispatchBarrierActive: boolean
  providers: Record<Provider, ProviderCardState>
}

type SessionListItem = {
  id: string
  roomId: string | null
  title: string
  updatedAt: string
  updatedAtLabel: string
  createdAt: string
  createdAtLabel: string
  projectTag?: string
  // F022 Phase 3.5 (AC-14g): 手动命名锁；非 null 时前端显示 🔒 图标
  titleLockedAt?: string | null
  pinned?: boolean
  unreadCount?: number
  participants: Provider[]
  messageCount: number
  previews: Array<{ provider: Provider; alias: string; text: string }>
}

type SendPayload = {
  threadId: string
  provider: Provider
  content: string
  alias: string
  contentBlocks?: ContentBlock[]
}

type ThreadStore = {
  providers: Record<Provider, ProviderCardState>
  catalogs: Record<Provider, ProviderCatalog>
  sessionGroups: SessionListItem[]
  activeGroupId: string | null
  activeGroup: {
    id: string
    roomId: string | null
    title: string
    meta: string
    hasPendingDispatches: boolean
    dispatchBarrierActive: boolean
  } | null
  timeline: TimelineMessage[]
  invocationStats: InvocationStats[]
  unreadCounts: Record<string, number>
  /**
   * F026 P5 F6 · pendingByRoot — 按 rootCallId 索引的 pendingSet 缓存。
   *
   * 后端 CallRegistry 每次 mutation 后 emit `pending_change`（带 rootCallId + 全量
   * pendingSet）。store 按 rootCallId 覆写 entry，空 set 时删除 key。F6 ListeningPulse
   * 取 active session 全部 rootCallId 的 pendingSet 合集 dedup by alias 渲染 banner。
   *
   * sessionGroupId 切换时由 selectSessionGroup 清空（避免跨房间状态泄漏）。
   * F1 @ pill 状态机也读这份缓存按 callId 反查 status。
   */
  pendingByRoot: Record<string, PendingChangePayload["pendingSet"]>
  /**
   * F026 review#4 fix · settledByRoot — terminal cache，按 rootCallId / callId 索引终态。
   *
   * 后端 CallRegistry settle / timeoutScan 后 emit pending.change 携带 settled =
   * [{callId, alias, status: "done"|"failed"|"timeout"|"cancelled"}]。store 累加写入
   * settledByRoot[rootCallId][callId] = status。AtPill 在 pendingByRoot 命不中时反查
   * 这里拿终态——connector message envelope 的 a2aCallStatus 是创建瞬间的快照，settle
   * 后不重发，直接 fallback snapshot 会让 AtPill 卡 ack/working 进不了 done/timeout/error。
   *
   * 清理时机（A' 关键）：
   *   - selectSessionGroup（active group 切换）→ 清空（避免跨房间状态泄漏）
   *   - replaceActiveGroup（snapshot 重载，新 timeline 已带最新 a2aCallStatus）→ 清空
   *   不在 root 收口（pendingSet 空 → 删 pendingByRoot[root]）时清——单 child settle
   *   场景下 settledByRoot 是 AtPill 终态唯一载体，清掉就回落 snapshot=pending = ack。
   */
  settledByRoot: Record<string, Record<string, "done" | "failed" | "timeout" | "cancelled">>
  // F022 Phase 3.5 (review P2 follow-up): 服务端收到 archive/softDelete/restore
  // 后广播 session.archive_state_changed；sidebar 订阅这个 version 变化重刷主列表
  // + 归档列表。多端/多标签场景下不再看陈旧态。
  archiveStateVersion: number
  bumpArchiveStateVersion: () => void
  // F022 review 2nd round P1: 远端标签页的 activeGroup 刚被归档/软删时，
  // 如果只刷 sidebar 不清 active，右侧面板仍停在失效会话上、还能继续发消息。
  // 该 action 负责在 activeGroupId 匹配时清空 active 态，让用户必须重新选会话。
  clearActiveGroupIfMatches: (groupId: string) => void
  bootstrap: () => Promise<void>
  createSessionGroup: () => Promise<void>
  selectSessionGroup: (groupId: string) => Promise<void>
  updateModel: (provider: Provider, model: string) => Promise<void>
  stopThread: (provider: Provider) => Promise<void>
  stopAgent: (provider: Provider) => Promise<void>
  replaceSessionGroups: (groups: SessionGroupSummary[]) => void
  // F022 Phase 3.5 (AC-14k): realtime push after Haiku renames or manual rename.
  applyTitleUpdate: (groupId: string, title: string, titleLockedAt: string | null) => void
  replaceActiveGroup: (group: ActiveGroupPayload) => void
  // F031 AC4 · offset = 服务端 append 前累计长度；缺省 = legacy 盲追加。
  // 幂等判定在 flushDeltas 时刻（segment 队列），不在此入口。
  applyAssistantDelta: (messageId: string, delta: string, offset?: number) => void
  applyThinkingDelta: (messageId: string, delta: string, offset?: number) => void
  /**
   * F026 P3.1 · AC-22 retry 触发时清空对应 messageId 的 streaming buffer
   * （pendingDeltas + timeline.content），防止 retry 后新 delta 与旧不合规内容拼接。
   */
  resetAssistantStream: (messageId: string) => void
  /**
   * F026 P3.1 review#2 fix · status="exhausted" 收尾时把 timeline message content
   * 用 payload.finalContent 重新填回去——exhausted 后没有新 delta，否则气泡就一直空白。
   * 同步丢掉残留 pendingDeltas，避免 RAF flush 把旧 delta 拼到回填内容后面。
   */
  restoreAssistantContent: (messageId: string, content: string) => void
  /**
   * F026 P4 follow-up · retry-badge-realtime fix:
   * settled / exhausted 收到 dispatch.validation_retry 终态事件时，把 retryCount +
   * retryReasons 同步到 timeline 对应 message，让 DispatchRetryBadge / ExhaustedBanner
   * 不刷新就能渲染（之前只入库不广播 → 必须刷新页面走 thread_snapshot 才补字段）。
   */
  applyMessageRetryFields: (
    messageId: string,
    retryCount: number,
    retryReasons: DispatchValidationRetryReason[],
  ) => void
  applyToolEvent: (messageId: string, event: ToolEvent) => void
  applyContentBlock: (messageId: string, block: ContentBlock) => void
  appendTimelineMessage: (message: TimelineMessage) => void
  applySnapshotDelta: (delta: ThreadSnapshotDelta) => void
  reconcileOptimisticMessage: (clientMessageId: string, serverMessage: TimelineMessage) => void
  recordMessageInGroup: (groupId: string, message: TimelineMessage) => void
  buildSendPayload: (input: string, contentBlocks?: ContentBlock[]) => SendPayload | null
  incrementUnread: (groupId: string) => void
  resetUnread: (groupId: string) => void
  /**
   * F026 P5 F6 · 处理 `pending_change` WS 事件 — 按 rootCallId 覆写 pendingByRoot。
   * 空 pendingSet 时删除 key（避免空状态 banner 抖动）。
   */
  applyPendingChange: (payload: PendingChangePayload) => void
}

const emptyProviders = Object.fromEntries(
  PROVIDERS.map((provider) => [
    provider,
    {
      threadId: "",
      alias: PROVIDER_ALIASES[provider],
      currentModel: null,
      quotaSummary: "额度信息待接入",
      preview: "还没有消息",
      running: false,
    },
  ]),
) as Record<Provider, ProviderCardState>

const emptyCatalogs = Object.fromEntries(
  PROVIDERS.map((provider) => [
    provider,
    {
      provider,
      alias: PROVIDER_ALIASES[provider],
      currentModel: null,
      modelSuggestions: [],
    },
  ]),
) as unknown as Record<Provider, ProviderCatalog>

// AC-14c: title 为 null / 空 / 旧占位格式时，fallback 到与 AC-08 失败回退一致的 `新会话 {createdAtLabel}`
const LEGACY_PLACEHOLDER_PATTERN = /·\s*未命名\s*$/
function fallbackTitle(title: string | null | undefined, createdAtLabel: string): string {
  const t = (title ?? "").trim()
  if (!t || LEGACY_PLACEHOLDER_PATTERN.test(t)) return `新会话 ${createdAtLabel}`
  return t
}

function normalizeSessionGroups(groups: SessionGroupSummary[]): SessionListItem[] {
  return groups.map((group) => ({
    id: group.id,
    roomId: group.roomId ?? null,
    title: fallbackTitle(group.title, group.createdAtLabel),
    updatedAt: group.updatedAt,
    updatedAtLabel: group.updatedAtLabel,
    createdAt: group.createdAt,
    createdAtLabel: group.createdAtLabel,
    projectTag: group.projectTag,
    titleLockedAt: group.titleLockedAt ?? null,
    participants: group.participants ?? [],
    messageCount: group.messageCount ?? 0,
    previews: group.previews,
  }))
}

const EVERYONE_TOKEN = "所有人"

type MentionToken =
  | { kind: "provider"; provider: Provider; raw: string; index: number }
  | { kind: "everyone"; raw: string; index: number }

// Match @ followed by CJK chars / ASCII letters / digits / underscore.
// Scans the whole string so every mention gets surfaced, not just the first.
const MENTION_SCAN_REGEX = /@([\p{L}\p{N}_]+)/gu

function resolveAliasToProvider(aliasLower: string): Provider | null {
  if (aliasLower === PROVIDER_ALIASES.codex.toLowerCase() || aliasLower === "codex") {
    return "codex"
  }
  if (
    aliasLower === PROVIDER_ALIASES.claude.toLowerCase() ||
    aliasLower === "claude" ||
    aliasLower === "claudecode"
  ) {
    return "claude"
  }
  if (aliasLower === PROVIDER_ALIASES.gemini.toLowerCase() || aliasLower === "gemini") {
    return "gemini"
  }
  return null
}

function parseMentions(input: string): MentionToken[] {
  const tokens: MentionToken[] = []
  for (const match of input.matchAll(MENTION_SCAN_REGEX)) {
    const alias = match[1]
    const raw = match[0]
    const index = match.index ?? -1
    if (alias === EVERYONE_TOKEN) {
      tokens.push({ kind: "everyone", raw, index })
      continue
    }
    const provider = resolveAliasToProvider(alias.toLowerCase())
    if (provider) {
      tokens.push({ kind: "provider", provider, raw, index })
    }
  }
  return tokens
}

/**
 * 将用户输入归一化成后端能识别的形式：
 * - @所有人 展开为三个规范中文名
 * - 英文 provider 名（@claude 等）替换成对应中文人名
 * - 其他 @xxx 原样保留（可能是 @所有人 之外的普通文本）
 */
function normalizeContentForBackend(input: string, tokens: MentionToken[]): string {
  // Replace the @所有人 token with the three canonical names; only the first occurrence gets expanded
  // to keep the content readable, the rest are simply dropped.
  let expanded = input
  const everyoneTokens = tokens.filter((t) => t.kind === "everyone")
  if (everyoneTokens.length > 0) {
    const all = `@${PROVIDER_ALIASES.claude} @${PROVIDER_ALIASES.codex} @${PROVIDER_ALIASES.gemini}`
    let replaced = false
    expanded = expanded.replace(new RegExp(`@${EVERYONE_TOKEN}`, "g"), () => {
      if (!replaced) {
        replaced = true
        return all
      }
      return ""
    })
  }

  // Normalize English provider aliases to Chinese names, and drop duplicate mentions of the same
  // provider (keeping only the first occurrence). Deduping matters because @所有人 expands into
  // all three names, which would collide with any explicit @name the user already typed.
  const seenProviders = new Set<Provider>()
  expanded = expanded.replace(MENTION_SCAN_REGEX, (raw, alias: string) => {
    if (alias === EVERYONE_TOKEN) return raw
    const provider = resolveAliasToProvider(alias.toLowerCase())
    if (!provider) return raw
    if (seenProviders.has(provider)) return ""
    seenProviders.add(provider)
    return `@${PROVIDER_ALIASES[provider]}`
  })

  // Collapse double spaces left behind by dropped duplicates.
  expanded = expanded.replace(/ {2,}/g, " ")

  return expanded
}

function mergeTimeline(existing: TimelineMessage[], incoming: TimelineMessage[]) {
  const existingById = new Map(existing.map((message) => [message.id, message]))

  const merged = incoming.map((message) => {
    const current = existingById.get(message.id)
    if (!current) {
      return message
    }

    const content =
      current.role === message.role &&
      current.provider === message.provider &&
      current.content.length > message.content.length
        ? current.content
        : message.content

    const currentThinkingVal = current.thinking ?? ""
    const incomingThinkingVal = message.thinking ?? ""
    const thinking =
      current.role === message.role &&
      current.provider === message.provider &&
      currentThinkingVal.length > incomingThinkingVal.length
        ? current.thinking
        : message.thinking

    const currentEvents = current.toolEvents ?? []
    const incomingEvents = message.toolEvents ?? []
    const toolEvents =
      currentEvents.length > incomingEvents.length ? current.toolEvents : message.toolEvents

    return { ...message, content, thinking, toolEvents }
  })

  const alreadySorted = merged.every((msg, i) => i === 0 || msg.createdAt >= merged[i - 1].createdAt)
  return alreadySorted ? merged : merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"
  const response = await fetch(`${baseUrl}${path}`, init)
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `请求失败: ${response.status}`)
  }

  return (await response.json()) as T
}

// F031 AC4 · pendingDeltas 改 offset segment 队列（德彪 r2 P1）：
// apply* 只入队 {offset, text}，幂等判定延迟到 flush 时刻以当时 timeline 长度为准——
// 入口判定拦不住"已入 RAF 队列、快照（replaceActiveGroup）换基线后才 flush"的重复段。
type DeltaSegment = { offset?: number; text: string }
type PendingDelta = { content: DeltaSegment[]; thinking: DeltaSegment[] }
let pendingDeltas = new Map<string, PendingDelta>()
let rafScheduled = false

export type DeltaHoleInfo = {
  messageId: string
  kind: "content" | "thinking"
  /** flush 时刻 timeline 当前长度（期望的下一段 offset） */
  expected: number
  /** 实际到达段的 offset */
  got: number
}

// 消息内空洞（offset > 当前长度 = 中间丢段）上报钩子；page.tsx 注册 → 触发 catch-up。
// 模块级回调而非 store state：flushDeltas 在 set() 归约器外调用，避免渲染期副作用。
let deltaHoleHandler: ((info: DeltaHoleInfo) => void) | null = null
export function setDeltaHoleHandler(fn: ((info: DeltaHoleInfo) => void) | null) {
  deltaHoleHandler = fn
}

/**
 * flush 时刻逐段幂等判定：
 *   offset 缺省（legacy 服务端）→ 盲追加（旧行为）
 *   offset === 当前长度 → 追加；offset < → 重复丢弃（快照已覆盖）；
 *   offset > → 丢段 + 上报 hole（不留队等序——catch-up 快照自带全量内容）
 */
function applySegments(
  base: string,
  segments: DeltaSegment[],
  messageId: string,
  kind: DeltaHoleInfo["kind"],
): string {
  let out = base
  for (const seg of segments) {
    if (seg.offset === undefined || seg.offset === out.length) {
      out += seg.text
      continue
    }
    if (seg.offset < out.length) continue
    deltaHoleHandler?.({ messageId, kind, expected: out.length, got: seg.offset })
  }
  return out
}

function flushDeltas(set: (fn: (state: ThreadStore) => Partial<ThreadStore>) => void) {
  rafScheduled = false
  if (pendingDeltas.size === 0) return
  const batch = pendingDeltas
  pendingDeltas = new Map()
  set((state) => ({
    timeline: state.timeline.map((msg) => {
      const delta = batch.get(msg.id)
      if (!delta) return msg
      return {
        ...msg,
        content: delta.content.length
          ? applySegments(msg.content, delta.content, msg.id, "content")
          : msg.content,
        thinking: delta.thinking.length
          ? applySegments(msg.thinking ?? "", delta.thinking, msg.id, "thinking")
          : msg.thinking,
      }
    }),
  }))
}

function scheduleDeltaFlush(set: (fn: (state: ThreadStore) => Partial<ThreadStore>) => void) {
  if (rafScheduled) return
  rafScheduled = true
  if (typeof requestAnimationFrame !== "undefined") {
    requestAnimationFrame(() => flushDeltas(set))
  } else {
    setTimeout(() => flushDeltas(set), 16)
  }
}

/**
 * F026 P0 Day1 · 并发 @ 解锁（plan A · scope isBusy to active group）
 *
 * 旧 isBusy 同时包含 `hasRunningProvider || hasPendingDispatches`，导致：
 *   当前 group 里 @仁勋 在 streaming → providers.claude.running=true
 *   → isBusy=true → 小孙无法在同房间发 @范德彪
 * 但后端 runningSlots 早就是 per-(sessionGroupId, provider) 维度并发，UI 的
 * hasRunningProvider 锁是多余的。scope 缩到 activeGroup.hasPendingDispatches
 * （queued 状态）后，"同房间 @ 不同 provider"立刻解锁；同 provider 连发两次
 * 由后端 runningSlots 处理（queue or reject），UI 不替后端做决策。
 *
 * providers[provider].running 仍用于决定是否显示 Stop 按钮（composer.tsx 里单独取）。
 */
export function selectIsBusyForActiveGroup(
  state: Pick<ThreadStore, "activeGroup" | "providers">,
): boolean {
  return Boolean(state.activeGroup?.hasPendingDispatches)
}

export const useThreadStore = create<ThreadStore>((set, get) => ({
  providers: emptyProviders,
  catalogs: emptyCatalogs,
  sessionGroups: [],
  activeGroupId: null,
  activeGroup: null,
  timeline: [],
  invocationStats: [],
  unreadCounts: {},
  pendingByRoot: {},
  settledByRoot: {},
  archiveStateVersion: 0,
  bumpArchiveStateVersion: () => {
    set((state) => ({ archiveStateVersion: state.archiveStateVersion + 1 }))
  },
  clearActiveGroupIfMatches: (groupId) => {
    set((state) => {
      if (state.activeGroupId !== groupId) return state
      return {
        activeGroupId: null,
        activeGroup: null,
        timeline: [],
        providers: emptyProviders,
        invocationStats: [],
      }
    })
  },
  bootstrap: async () => {
    // Bootstrap stitches together the static provider catalog and the latest session list before selecting a room.
    const [groupsPayload, providersPayload] = await Promise.all([
      fetchJson<{ sessionGroups: SessionGroupSummary[] }>("/api/bootstrap"),
      fetchJson<{ providers: ProviderCatalog[] }>("/api/providers"),
    ])

    set({
      catalogs: Object.fromEntries(
        providersPayload.providers.map((item) => [item.provider, item]),
      ) as Record<Provider, ProviderCatalog>,
    })
    get().replaceSessionGroups(groupsPayload.sessionGroups)

    if (groupsPayload.sessionGroups[0]) {
      await get().selectSessionGroup(groupsPayload.sessionGroups[0].id)
      return
    }

    await get().createSessionGroup()
  },
  createSessionGroup: async () => {
    const payload = await fetchJson<{ groupId: string }>("/api/session-groups", {
      method: "POST",
    })
    const groupsPayload = await fetchJson<{ sessionGroups: SessionGroupSummary[] }>(
      "/api/bootstrap",
    )
    get().replaceSessionGroups(groupsPayload.sessionGroups)
    await get().selectSessionGroup(payload.groupId)
  },
  selectSessionGroup: async (groupId) => {
    // F031 · subscribe-before-fetch（德彪 r1 P2）：先订阅再拉快照，缩窄
    // "fetch 与 subscribe 生效之间的新组事件被 shouldDeliver 过滤掉"的丢失窗口；
    // 残余 race（订阅生效前广播的事件）靠 gap → catch-up 自愈。
    // beginSwitch（德彪 r4 P1）：fetch 在途时新组事件被 page isCurrentSession 丢弃，
    // monitor 记账最高 seq，setBaseline 对账 > 水位线即补拉——终版事件不丢。
    streamMonitor.beginSwitch(groupId)
    subscribeToRoom(groupId)
    const payload = await fetchJson<{ activeGroup: ActiveGroupPayload; wsWatermark?: WsWatermark }>(
      `/api/session-groups/${groupId}`,
    )
    // F026 review#4 fix · 切房间清 pendingByRoot + settledByRoot（避免跨房间状态泄漏；
    // 新 snapshot 自带最新 a2aCallStatus，不需要 terminal cache 兜底）
    set({ activeGroupId: groupId, pendingByRoot: {}, settledByRoot: {} })
    // F031 · 快照水位线换基线：seq ≤ 水位线的流事件此后按"快照已覆盖"丢弃
    if (payload.wsWatermark) {
      streamMonitor.setBaseline(groupId, payload.wsWatermark)
    }
    get().replaceActiveGroup(payload.activeGroup)
    get().resetUnread(groupId)

    const { fetchPending: fetchDecisions } = await import("./decision-store").then((m) => m.useDecisionStore.getState())
    const { fetchPendingFlush } = await import("./decision-board-store").then((m) => m.useDecisionBoardStore.getState())
    void fetchDecisions(groupId)
    void fetchPendingFlush(groupId)
  },
  updateModel: async (provider, model) => {
    const thread = get().providers[provider]
    if (!thread.threadId) {
      return
    }

    const payload = await fetchJson<{ activeGroup: ActiveGroupPayload }>(
      `/api/threads/${thread.threadId}/model`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      },
    )

    get().replaceActiveGroup(payload.activeGroup)
  },
  stopThread: async (provider) => {
    const thread = get().providers[provider]
    if (!thread.threadId) {
      return
    }

    await fetchJson(`/api/threads/${thread.threadId}/stop`, {
      method: "POST",
    })
  },
  stopAgent: async (provider) => {
    const thread = get().providers[provider]
    if (!thread.threadId) {
      return
    }

    await fetchJson(`/api/threads/${thread.threadId}/cancel/${provider}`, {
      method: "POST",
    })
  },
  replaceSessionGroups: (groups) => {
    set({ sessionGroups: normalizeSessionGroups(groups) })
  },
  applyTitleUpdate: (groupId, title, titleLockedAt) => {
    set((state) => ({
      sessionGroups: state.sessionGroups.map((g) =>
        g.id === groupId ? { ...g, title, titleLockedAt } : g,
      ),
      activeGroup:
        state.activeGroup && state.activeGroup.id === groupId
          ? { ...state.activeGroup, title }
          : state.activeGroup,
    }))
  },
  replaceActiveGroup: (group) => {
    set((state) => ({
      activeGroup: {
        id: group.id,
        roomId: group.roomId,
        title: group.title,
        meta: group.meta,
        hasPendingDispatches: group.hasPendingDispatches,
        dispatchBarrierActive: group.dispatchBarrierActive,
      },
      // Snapshots come from the database and can momentarily lag behind local deltas, so merge instead of replacing.
      timeline: mergeTimeline(state.timeline, group.timeline),
      providers: group.providers,
    }))
  },
  appendTimelineMessage: (message) => {
    set((state) => {
      if (state.timeline.some((item) => item.id === message.id)) {
        return state
      }
      return { timeline: [...state.timeline, message] }
    })
  },
  recordMessageInGroup: (groupId, message) => {
    set((state) => ({
      sessionGroups: applyMessageToSessionGroups(state.sessionGroups, groupId, {
        provider: message.provider,
        alias: message.alias,
        content: message.content,
        createdAt: message.createdAt,
      }),
    }))
  },
  applyAssistantDelta: (messageId, delta, offset) => {
    const existing = pendingDeltas.get(messageId) ?? { content: [], thinking: [] }
    existing.content.push({ offset, text: delta })
    pendingDeltas.set(messageId, existing)
    scheduleDeltaFlush(set)
  },
  resetAssistantStream: (messageId) => {
    // F026 P3.1 · AC-22: retry 触发清掉 streaming buffer，
    // 让占位锁解除后看到的是 settled / exhausted 后 overwriteMessage 的最终 content，
    // 而不是 "旧不合规 + 新合规" 的拼接污染。
    pendingDeltas.delete(messageId)
    set((state) => ({
      timeline: state.timeline.map((msg) =>
        msg.id === messageId ? { ...msg, content: "" } : msg,
      ),
    }))
  },
  restoreAssistantContent: (messageId, content) => {
    // F026 P3.1 review#2 fix · 两条 exhausted 分支没有新 delta；
    // resetAssistantStream 清空气泡后必须由 payload.finalContent 把 timeline 填回去，
    // 否则刷新前用户看到空气泡 + 红 banner（兜底入库内容只在数据库里）。
    pendingDeltas.delete(messageId)
    set((state) => {
      if (!state.timeline.some((msg) => msg.id === messageId)) return state
      return {
        timeline: state.timeline.map((msg) =>
          msg.id === messageId ? { ...msg, content } : msg,
        ),
      }
    })
  },
  applyMessageRetryFields: (messageId, retryCount, retryReasons) => {
    set((state) => {
      if (!state.timeline.some((msg) => msg.id === messageId)) return state
      return {
        timeline: state.timeline.map((msg) =>
          msg.id === messageId
            ? { ...msg, retryCount, retryReasons: [...retryReasons] }
            : msg,
        ),
      }
    })
  },
  applyThinkingDelta: (messageId, delta, offset) => {
    const existing = pendingDeltas.get(messageId) ?? { content: [], thinking: [] }
    existing.thinking.push({ offset, text: delta })
    pendingDeltas.set(messageId, existing)
    scheduleDeltaFlush(set)
  },
  applyToolEvent: (messageId, event) => {
    set((state) => ({
      timeline: state.timeline.map((message) =>
        message.id === messageId
          ? { ...message, toolEvents: [...(message.toolEvents ?? []), event] }
          : message,
      ),
    }))
  },
  applyContentBlock: (messageId, block) => {
    set((state) => ({
      timeline: state.timeline.map((message) =>
        message.id === messageId
          ? { ...message, contentBlocks: [...(message.contentBlocks ?? []), block] }
          : message,
      ),
    }))
  },
  applySnapshotDelta: (delta) => {
    set((state) => {
      const newTimeline = [...state.timeline]
      for (const msg of delta.newMessages) {
        if (!newTimeline.some((m) => m.id === msg.id)) {
          newTimeline.push(msg)
        }
      }
      const removed = new Set(delta.removedMessageIds ?? [])
      const filtered = removed.size > 0
        ? newTimeline.filter((m) => !removed.has(m.id))
        : newTimeline
      return { timeline: filtered, providers: delta.providers }
    })
  },
  reconcileOptimisticMessage: (clientMessageId, serverMessage) => {
    set((state) => ({
      timeline: state.timeline.map((msg) =>
        msg.id === clientMessageId ? serverMessage : msg,
      ),
    }))
  },
  incrementUnread: (groupId) => {
    set((state) => ({
      unreadCounts: {
        ...state.unreadCounts,
        [groupId]: (state.unreadCounts[groupId] ?? 0) + 1,
      },
    }))
  },
  resetUnread: (groupId) => {
    set((state) => {
      if (!(groupId in state.unreadCounts)) return state
      const { [groupId]: _, ...rest } = state.unreadCounts
      return { unreadCounts: rest }
    })
  },
  applyPendingChange: (payload) => {
    set((state) => {
      const nextPending = { ...state.pendingByRoot }
      if (payload.pendingSet.length === 0) {
        delete nextPending[payload.rootCallId]
      } else {
        nextPending[payload.rootCallId] = payload.pendingSet
      }
      // F026 review#4 fix · settled 终态增量累加到 settledByRoot；root 收口（pendingSet
      // 空）时不清 settledByRoot[root] —— 单 child settle 场景下 terminal cache 是
      // AtPill 唯一载体，清掉立即 fallback snapshot=pending = ack（P1 还在）。
      let nextSettled = state.settledByRoot
      if (payload.settled && payload.settled.length > 0) {
        nextSettled = { ...state.settledByRoot }
        const rootEntry = { ...(nextSettled[payload.rootCallId] ?? {}) }
        for (const s of payload.settled) {
          rootEntry[s.callId] = s.status
        }
        nextSettled[payload.rootCallId] = rootEntry
      }
      return { pendingByRoot: nextPending, settledByRoot: nextSettled }
    })
  },
  buildSendPayload: (input, contentBlocks) => {
    // The frontend sends the resolved provider/thread pair so the backend ws route can stay transport-focused.
    // Multi-mention handling: resolve *all* mentions, pick the first concrete provider as the direct-turn
    // target, then hand the full (normalized) content to the backend — `enqueuePublicMentions` will
    // dispatch the others (and skip the source provider to avoid double-running the direct thread).
    const tokens = parseMentions(input)
    if (tokens.length === 0) {
      return null
    }

    // @所有人 expands to all three providers; pick the first available thread as the direct target.
    const hasEveryone = tokens.some((t) => t.kind === "everyone")
    const providerTokens = tokens.filter(
      (t): t is Extract<MentionToken, { kind: "provider" }> => t.kind === "provider",
    )

    const providers = get().providers
    let targetProvider: Provider | null = providerTokens[0]?.provider ?? null
    if (!targetProvider && hasEveryone) {
      targetProvider = PROVIDERS.find((p) => providers[p].threadId) ?? null
    }
    if (!targetProvider) {
      return null
    }

    const thread = providers[targetProvider]
    if (!thread.threadId) {
      return null
    }

    const normalizedContent = normalizeContentForBackend(input, tokens).trim()
    const hasImages = contentBlocks && contentBlocks.length > 0
    if (!normalizedContent && !hasImages) {
      return null
    }

    return {
      threadId: thread.threadId,
      provider: targetProvider,
      content: normalizedContent,
      alias: thread.alias,
      contentBlocks: contentBlocks?.length ? contentBlocks : undefined,
    }
  },
}))
