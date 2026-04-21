"use client"

import {
  applyMessageToSessionGroups,
  type ContentBlock,
  type InvocationStats,
  PROVIDERS,
  PROVIDER_ALIASES,
  type Provider,
  type ProviderCatalog,
  type SessionGroupSummary,
  type ThreadSnapshotDelta,
  type TimelineMessage,
  type ToolEvent,
} from "@multi-agent/shared"
import { create } from "zustand"

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
}

type ActiveGroupPayload = {
  id: string
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
    title: string
    meta: string
    hasPendingDispatches: boolean
    dispatchBarrierActive: boolean
  } | null
  timeline: TimelineMessage[]
  invocationStats: InvocationStats[]
  unreadCounts: Record<string, number>
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
  applyAssistantDelta: (messageId: string, delta: string) => void
  applyThinkingDelta: (messageId: string, delta: string) => void
  applyToolEvent: (messageId: string, event: ToolEvent) => void
  applyContentBlock: (messageId: string, block: ContentBlock) => void
  appendTimelineMessage: (message: TimelineMessage) => void
  applySnapshotDelta: (delta: ThreadSnapshotDelta) => void
  reconcileOptimisticMessage: (clientMessageId: string, serverMessage: TimelineMessage) => void
  recordMessageInGroup: (groupId: string, message: TimelineMessage) => void
  buildSendPayload: (input: string, contentBlocks?: ContentBlock[]) => SendPayload | null
  incrementUnread: (groupId: string) => void
  resetUnread: (groupId: string) => void
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

type PendingDelta = { content?: string; thinking?: string }
let pendingDeltas = new Map<string, PendingDelta>()
let rafScheduled = false

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
        content: delta.content !== undefined ? msg.content + delta.content : msg.content,
        thinking: delta.thinking !== undefined ? (msg.thinking ?? "") + delta.thinking : msg.thinking,
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

export const useThreadStore = create<ThreadStore>((set, get) => ({
  providers: emptyProviders,
  catalogs: emptyCatalogs,
  sessionGroups: [],
  activeGroupId: null,
  activeGroup: null,
  timeline: [],
  invocationStats: [],
  unreadCounts: {},
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
    const payload = await fetchJson<{ activeGroup: ActiveGroupPayload }>(
      `/api/session-groups/${groupId}`,
    )
    set({ activeGroupId: groupId })
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
  applyAssistantDelta: (messageId, delta) => {
    const existing = pendingDeltas.get(messageId) ?? {}
    existing.content = (existing.content ?? "") + delta
    pendingDeltas.set(messageId, existing)
    scheduleDeltaFlush(set)
  },
  applyThinkingDelta: (messageId, delta) => {
    const existing = pendingDeltas.get(messageId) ?? {}
    existing.thinking = (existing.thinking ?? "") + delta
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
