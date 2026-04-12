"use client"

import { useApprovalStore } from "@/components/stores/approval-store"
import { useThreadStore } from "@/components/stores/thread-store"
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Search,
  Pin,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { ProviderAvatar } from "./provider-avatar"
import { SessionContextMenu } from "./session-context-menu"

/* ── localStorage helpers for pinned sessions ── */

const PINNED_KEY = "multi-agent:pinned-sessions"

function loadPinned(): Set<string> {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(PINNED_KEY) : null
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
  } catch {
    return new Set()
  }
}

function savePinned(pinned: Set<string>) {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify([...pinned]))
  } catch {
    // localStorage may be unavailable
  }
}

/* ── Types ── */

type ProjectGroup = {
  tag: string
  label: string
  items: Array<{
    id: string
    title: string
    updatedAtLabel: string
    projectTag?: string
    pinned: boolean
    unreadCount: number
    previews: Array<{ provider: string; alias: string; text: string }>
  }>
}

/* ── Component ── */

export function SessionSidebar() {
  const sessionGroups = useThreadStore((state) => state.sessionGroups)
  const activeGroupId = useThreadStore((state) => state.activeGroupId)
  const createGroup = useThreadStore((state) => state.createSessionGroup)
  const selectGroup = useThreadStore((state) => state.selectSessionGroup)
  const unreadCounts = useThreadStore((state) => state.unreadCounts)
  const providers = useThreadStore((state) => state.providers)
  const pending = useApprovalStore((s) => s.pending)

  const [search, setSearch] = useState("")
  const [pinned, setPinned] = useState<Set<string>>(new Set())
  const [collapsedTags, setCollapsedTags] = useState<Set<string>>(new Set())

  // Context menu
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    groupId: string
    isPinned: boolean
  } | null>(null)

  // Load pinned from localStorage on mount
  useEffect(() => {
    setPinned(loadPinned())
  }, [])

  const togglePin = useCallback(
    (groupId: string) => {
      setPinned((prev) => {
        const next = new Set(prev)
        if (next.has(groupId)) {
          next.delete(groupId)
        } else {
          next.add(groupId)
        }
        savePinned(next)
        return next
      })
    },
    [],
  )

  const toggleCollapse = useCallback((tag: string) => {
    setCollapsedTags((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) {
        next.delete(tag)
      } else {
        next.add(tag)
      }
      return next
    })
  }, [])

  const runningGroupIds = useMemo(() => {
    const running = new Set<string>()
    const anyRunning = Object.values(providers).some((p) => p.running)
    if (anyRunning && activeGroupId) {
      running.add(activeGroupId)
    }
    return running
  }, [providers, activeGroupId])

  const waitingApprovalGroupIds = useMemo(() => {
    const ids = new Set<string>()
    for (const req of pending) {
      ids.add(req.sessionGroupId)
    }
    return ids
  }, [pending])

  // Filter by search
  const filtered = useMemo(() => {
    const query = search.toLowerCase()
    if (!query) return sessionGroups
    return sessionGroups.filter(
      (group) =>
        group.title.toLowerCase().includes(query) ||
        group.previews.some((p) => p.text.toLowerCase().includes(query)),
    )
  }, [sessionGroups, search])

  // Enrich items with pinned + unread
  const enriched = useMemo(
    () =>
      filtered.map((group) => ({
        ...group,
        pinned: pinned.has(group.id),
        unreadCount: unreadCounts[group.id] ?? 0,
      })),
    [filtered, pinned, unreadCounts],
  )

  // Split into pinned and project groups
  const pinnedItems = useMemo(() => enriched.filter((g) => g.pinned), [enriched])

  const projectGroups = useMemo(() => {
    const unpinned = enriched.filter((g) => !g.pinned)
    const tagMap = new Map<string, typeof unpinned>()
    for (const item of unpinned) {
      const tag = item.projectTag ?? "__ungrouped__"
      if (!tagMap.has(tag)) tagMap.set(tag, [])
      tagMap.get(tag)!.push(item)
    }

    const groups: ProjectGroup[] = []
    for (const [tag, items] of tagMap) {
      groups.push({
        tag,
        label: tag === "__ungrouped__" ? "未分组" : tag,
        items,
      })
    }
    // Sort: named groups first (alphabetically), ungrouped last
    groups.sort((a, b) => {
      if (a.tag === "__ungrouped__") return 1
      if (b.tag === "__ungrouped__") return -1
      return a.label.localeCompare(b.label)
    })
    return groups
  }, [enriched])

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, groupId: string, isPinned: boolean) => {
      e.preventDefault()
      setContextMenu({ x: e.clientX, y: e.clientY, groupId, isPinned })
    },
    [],
  )

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  return (
    <aside className="flex h-screen w-[280px] shrink-0 flex-col border-r border-slate-800/20 bg-slate-950 px-3 py-4">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold tracking-wide text-slate-200">
          会话
        </h2>
        <button
          className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-amber-600"
          onClick={() => void createGroup()}
          type="button"
        >
          <Plus className="h-3 w-3" />
          新建
        </button>
      </div>

      {/* Search */}
      <label className="relative mb-3 block px-1">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
        <input
          className="w-full rounded-md border border-slate-800/40 bg-slate-900/80 py-1.5 pl-8 pr-3 text-sm text-slate-300 placeholder-slate-600 outline-none transition focus:border-slate-700 focus:ring-1 focus:ring-slate-700"
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索..."
          type="text"
          value={search}
        />
      </label>

      {/* Scrollable list */}
      <div className="flex-1 overflow-y-auto">
        {/* Pinned section */}
        {pinnedItems.length > 0 && (
          <div className="mb-2">
            <div className="mb-1 flex items-center gap-1.5 px-2 py-1">
              <Pin className="h-3 w-3 text-amber-500" />
              <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                已置顶
              </span>
              <span className="ml-auto rounded-full bg-amber-500/20 px-1.5 text-[10px] font-mono text-amber-400">
                {pinnedItems.length}
              </span>
            </div>
            <div className="space-y-0.5">
              {pinnedItems.map((group) => (
                <SessionCard
                  key={group.id}
                  group={group}
                  active={activeGroupId === group.id}
                  running={runningGroupIds.has(group.id)}
                  waitingApproval={waitingApprovalGroupIds.has(group.id)}
                  onClick={() => void selectGroup(group.id)}
                  onContextMenu={(e) =>
                    handleContextMenu(e, group.id, true)
                  }
                />
              ))}
            </div>
          </div>
        )}

        {/* Project groups */}
        {projectGroups.map((pg) => (
          <div key={pg.tag} className="mb-1">
            <button
              className="mb-0.5 flex w-full items-center gap-1.5 px-2 py-1 text-left"
              onClick={() => toggleCollapse(pg.tag)}
              type="button"
            >
              {collapsedTags.has(pg.tag) ? (
                <ChevronRight className="h-3 w-3 text-slate-600" />
              ) : (
                <ChevronDown className="h-3 w-3 text-slate-600" />
              )}
              <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                {pg.label}
              </span>
              <span className="ml-auto rounded-full bg-slate-800 px-1.5 text-[10px] font-mono text-slate-500">
                {pg.items.length}
              </span>
            </button>
            {!collapsedTags.has(pg.tag) && (
              <div className="space-y-0.5">
                {pg.items.map((group) => (
                  <SessionCard
                    key={group.id}
                    group={group}
                    active={activeGroupId === group.id}
                    running={runningGroupIds.has(group.id)}
                    waitingApproval={waitingApprovalGroupIds.has(group.id)}
                    onClick={() => void selectGroup(group.id)}
                    onContextMenu={(e) =>
                      handleContextMenu(e, group.id, group.pinned)
                    }
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <SessionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          groupId={contextMenu.groupId}
          isPinned={contextMenu.isPinned}
          onClose={closeContextMenu}
          onTogglePin={togglePin}
        />
      )}
    </aside>
  )
}

/* ── Session Card ── */

type SessionCardProps = {
  group: {
    id: string
    title: string
    updatedAtLabel: string
    unreadCount: number
    previews: Array<{ provider: string; alias: string; text: string }>
  }
  active: boolean
  running: boolean
  waitingApproval: boolean
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

function SessionCard({ group, active, running, waitingApproval, onClick, onContextMenu }: SessionCardProps) {
  return (
    <button
      className={`group relative w-full rounded-md px-2.5 py-2 text-left transition ${
        active
          ? "border-l-2 border-amber-500 bg-slate-800/80"
          : "border-l-2 border-transparent hover:bg-slate-900/50"
      }`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      type="button"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {/* Running indicator */}
          {running && (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
            </span>
          )}
          {/* Waiting approval indicator */}
          {!running && waitingApproval && (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
            </span>
          )}
          <h3 className="truncate text-sm font-medium text-slate-200">
            {group.title}
          </h3>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {group.unreadCount > 0 && (
            <span className="rounded-full bg-amber-500 px-1.5 text-[10px] font-medium text-white">
              {group.unreadCount}
            </span>
          )}
          <span className="text-[10px] text-slate-600">{group.updatedAtLabel}</span>
        </div>
      </div>

      <div className="mt-1.5 flex items-center gap-2">
        <div className="flex -space-x-1.5">
          {group.previews.map((preview) => (
            <ProviderAvatar
              className="ring-1 ring-slate-950"
              identity={preview.provider as "claude" | "codex" | "gemini"}
              key={preview.provider}
              size="xs"
            />
          ))}
        </div>
        <p className="min-w-0 flex-1 truncate text-xs text-slate-500">
          {group.previews.find((p) => p.text)?.text || "尚无消息"}
        </p>
      </div>
    </button>
  )
}
