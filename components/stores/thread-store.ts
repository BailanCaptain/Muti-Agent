"use client"

import {
  type InvocationStats,
  PROVIDERS,
  PROVIDER_ALIASES,
  type Provider,
  type ProviderCatalog,
  type SessionGroupSummary,
  type TimelineMessage,
} from "@multi-agent/shared"
import { create } from "zustand"

type ProviderCardState = {
  threadId: string
  alias: string
  currentModel: string | null
  quotaSummary: string
  preview: string
  running: boolean
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
  title: string
  updatedAtLabel: string
  projectTag?: string
  pinned?: boolean
  unreadCount?: number
  previews: Array<{ provider: Provider; alias: string; text: string }>
}

type SendPayload = {
  threadId: string
  provider: Provider
  content: string
  alias: string
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
  bootstrap: () => Promise<void>
  createSessionGroup: () => Promise<void>
  selectSessionGroup: (groupId: string) => Promise<void>
  updateModel: (provider: Provider, model: string) => Promise<void>
  stopThread: (provider: Provider) => Promise<void>
  replaceSessionGroups: (groups: SessionGroupSummary[]) => void
  replaceActiveGroup: (group: ActiveGroupPayload) => void
  applyAssistantDelta: (messageId: string, delta: string) => void
  applyThinkingDelta: (messageId: string, delta: string) => void
  appendTimelineMessage: (message: TimelineMessage) => void
  buildSendPayload: (input: string) => SendPayload | null
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

function normalizeSessionGroups(groups: SessionGroupSummary[]): SessionListItem[] {
  return groups.map((group) => ({
    id: group.id,
    title: group.title,
    updatedAtLabel: group.updatedAtLabel,
    projectTag: group.projectTag,
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

  return incoming
    .map((message) => {
      const current = existingById.get(message.id)
      if (!current) {
        return message
      }

      // `thread_snapshot` 里的 assistant 内容来自数据库，流式过程中它往往会落后于
      // 前端本地已经通过 assistant_delta 追加的内容。这里优先保留更长的那份文本，
      // 避免气泡被快照回滚成旧内容，最终表现成“最后一瞬间整段弹出来”。
      const content =
        current.role === message.role &&
        current.provider === message.provider &&
        current.content.length > message.content.length
          ? current.content
          : message.content

      const currentThinking = current.thinking ?? ""
      const incomingThinking = message.thinking ?? ""
      const thinking =
        current.role === message.role &&
        current.provider === message.provider &&
        currentThinking.length > incomingThinking.length
          ? current.thinking
          : message.thinking

      return {
        ...message,
        content,
        thinking,
      }
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
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

export const useThreadStore = create<ThreadStore>((set, get) => ({
  providers: emptyProviders,
  catalogs: emptyCatalogs,
  sessionGroups: [],
  activeGroupId: null,
  activeGroup: null,
  timeline: [],
  invocationStats: [],
  unreadCounts: {},
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

    const { fetchPending } = await import("./approval-store").then((m) => m.useApprovalStore.getState())
    void fetchPending(groupId)
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
  replaceSessionGroups: (groups) => {
    set({ sessionGroups: normalizeSessionGroups(groups) })
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

      return {
        timeline: [...state.timeline, message].sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt),
        ),
      }
    })
  },
  applyAssistantDelta: (messageId, delta) => {
    set((state) => ({
      timeline: state.timeline.map((message) =>
        message.id === messageId ? { ...message, content: `${message.content}${delta}` } : message,
      ),
    }))
  },
  applyThinkingDelta: (messageId, delta) => {
    set((state) => ({
      timeline: state.timeline.map((message) =>
        message.id === messageId
          ? { ...message, thinking: `${message.thinking ?? ""}${delta}` }
          : message,
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
      const { [groupId]: _, ...rest } = state.unreadCounts
      return { unreadCounts: rest }
    })
  },
  buildSendPayload: (input) => {
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
    if (!normalizedContent) {
      return null
    }

    return {
      threadId: thread.threadId,
      provider: targetProvider,
      content: normalizedContent,
      alias: thread.alias,
    }
  },
}))
