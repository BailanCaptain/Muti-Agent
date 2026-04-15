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
import { memo, useCallback, useEffect, useMemo, useState } from "react"
import { ProviderAvatar } from "./provider-avatar"
import { SessionContextMenu } from "./session-context-menu"

/* ── localStorage helpers for pinned sessions ── */

const PINNED_KEY = "multi-agent:pinned-sessions"

function loadPinned(): Set<string> {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(PINNED_KEY) : null
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
  } catch (err) {
    console.warn("[session-sidebar] failed to load pinned sessions", err)
    return new Set()
  }
}

function savePinned(pinned: Set<string>) {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify([...pinned]))
  } catch (err) {
    console.warn("[session-sidebar] failed to save pinned sessions", err)
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
  const anyProviderRunning = useThreadStore((state) =>
    Object.values(state.providers).some((p) => p.running)
  )
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
    if (anyProviderRunning && activeGroupId) {
      running.add(activeGroupId)
    }
    return running
  }, [anyProviderRunning, activeGroupId])

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

  // Split into pinned and project groups directly — no intermediate enriched objects,
  // so item references stay stable for React.memo
  const pinnedItems = useMemo(() => filtered.filter((g) => pinned.has(g.id)), [filtered, pinned])

  const projectGroups = useMemo(() => {
    const unpinned = filtered.filter((g) => !pinned.has(g.id))
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
    groups.sort((a, b) => {
      if (a.tag === "__ungrouped__") return 1
      if (b.tag === "__ungrouped__") return -1
      return a.label.localeCompare(b.label)
    })
    return groups
  }, [filtered, pinned])

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, groupId: string, isPinned: boolean) => {
      e.preventDefault()
      setContextMenu({ x: e.clientX, y: e.clientY, groupId, isPinned })
    },
    [],
  )

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  return (
    <aside className="flex h-screen w-[280px] shrink-0 flex-col border-r border-slate-200/30 bg-white/70 backdrop-blur-xl px-3 py-4 shadow-[4px_0_24px_rgba(15,23,42,0.04)]">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold tracking-wide text-slate-800">
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
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
        <input
          className="w-full rounded-md border border-slate-200/60 bg-white/60 py-1.5 pl-8 pr-3 text-sm text-slate-700 placeholder-slate-400 outline-none transition focus:border-slate-300 focus:ring-1 focus:ring-slate-300"
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
              <span className="ml-auto rounded-full bg-amber-100 px-1.5 text-[10px] font-mono text-amber-600">
                {pinnedItems.length}
              </span>
            </div>
            <div className="space-y-0.5">
              {pinnedItems.map((group) => (
                <SessionCard
                  key={group.id}
                  groupId={group.id}
                  title={group.title}
                  updatedAtLabel={group.updatedAtLabel}
                  unreadCount={unreadCounts[group.id] ?? 0}
                  previews={group.previews}
                  active={activeGroupId === group.id}
                  running={runningGroupIds.has(group.id)}
                  waitingApproval={waitingApprovalGroupIds.has(group.id)}
                  isPinned={true}
                  onSelect={selectGroup}
                  onCtxMenu={handleContextMenu}
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
                <ChevronRight className="h-3 w-3 text-slate-400" />
              ) : (
                <ChevronDown className="h-3 w-3 text-slate-400" />
              )}
              <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                {pg.label}
              </span>
              <span className="ml-auto rounded-full bg-slate-100 px-1.5 text-[10px] font-mono text-slate-500">
                {pg.items.length}
              </span>
            </button>
            {!collapsedTags.has(pg.tag) && (
              <div className="space-y-0.5">
                {pg.items.map((group) => (
                  <SessionCard
                    key={group.id}
                    groupId={group.id}
                    title={group.title}
                    updatedAtLabel={group.updatedAtLabel}
                    unreadCount={unreadCounts[group.id] ?? 0}
                    previews={group.previews}
                    active={activeGroupId === group.id}
                    running={runningGroupIds.has(group.id)}
                    waitingApproval={waitingApprovalGroupIds.has(group.id)}
                    isPinned={pinned.has(group.id)}
                    onSelect={selectGroup}
                    onCtxMenu={handleContextMenu}
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

/* ── Keyword Capsules ── */

type KeywordRule = {
  en: RegExp
  cn: string[]
  label: string
  color: string
}

const KEYWORD_RULES: KeywordRule[] = [
  { en: /\brefactor\b/i, cn: ["重构"], label: "Refactor", color: "bg-violet-100 text-violet-600" },
  { en: /\b(bugfix|bug|fix)\b/i, cn: ["修复", "修 bug"], label: "BugFix", color: "bg-rose-100 text-rose-600" },
  { en: /\bUI\b/i, cn: ["界面", "前端", "视觉", "样式"], label: "UI", color: "bg-sky-100 text-sky-600" },
  { en: /\b(test|TDD)\b/i, cn: ["测试"], label: "Test", color: "bg-emerald-100 text-emerald-600" },
  { en: /\b(feat|feature)\b/i, cn: ["新功能", "功能"], label: "Feature", color: "bg-amber-100 text-amber-600" },
  { en: /\b(docs|README)\b/i, cn: ["文档"], label: "Docs", color: "bg-slate-100 text-slate-600" },
  { en: /\bperf\b/i, cn: ["性能", "优化"], label: "Perf", color: "bg-orange-100 text-orange-600" },
  { en: /\b(review|code review)\b/i, cn: ["审查"], label: "Review", color: "bg-indigo-100 text-indigo-600" },
  { en: /\bdeploy\b/i, cn: ["部署", "发布", "上线"], label: "Deploy", color: "bg-teal-100 text-teal-600" },
]

function extractKeywords(title: string, previews: Array<{ text: string }>): Array<{ label: string; color: string }> {
  const corpus = [title, ...previews.map((p) => p.text)].join(" ")
  const found: Array<{ label: string; color: string }> = []
  for (const { en, cn, label, color } of KEYWORD_RULES) {
    const hit = en.test(corpus) || cn.some((w) => corpus.includes(w))
    if (hit) {
      found.push({ label, color })
    }
    if (found.length >= 3) break
  }
  return found
}

/* ── Session Card ── */

type SessionCardProps = {
  groupId: string
  title: string
  updatedAtLabel: string
  unreadCount: number
  previews: Array<{ provider: string; alias: string; text: string }>
  active: boolean
  running: boolean
  waitingApproval: boolean
  isPinned: boolean
  onSelect: (groupId: string) => void
  onCtxMenu: (e: React.MouseEvent, groupId: string, isPinned: boolean) => void
}

const SessionCard = memo(function SessionCard({ groupId, title, updatedAtLabel, unreadCount, previews, active, running, waitingApproval, isPinned, onSelect, onCtxMenu }: SessionCardProps) {
  const handleClick = useCallback(() => {
    void onSelect(groupId)
  }, [onSelect, groupId])

  const handleCtxMenu = useCallback((e: React.MouseEvent) => {
    onCtxMenu(e, groupId, isPinned)
  }, [onCtxMenu, groupId, isPinned])

  const keywords = useMemo(
    () => extractKeywords(title, previews),
    [title, previews],
  )

  return (
    <button
      className={`group relative w-full rounded-md px-2.5 py-2 text-left transition ${
        active
          ? "border-l-2 border-amber-500 bg-white/80 shadow-sm"
          : "border-l-2 border-transparent hover:bg-white/50"
      }`}
      onClick={handleClick}
      onContextMenu={handleCtxMenu}
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
          <h3 className="truncate text-sm font-medium text-slate-800">
            {title}
          </h3>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {unreadCount > 0 && (
            <span className="rounded-full bg-amber-500 px-1.5 text-[10px] font-medium text-white">
              {unreadCount}
            </span>
          )}
          <span className="text-[10px] text-slate-400">{updatedAtLabel}</span>
        </div>
      </div>

      {/* Keyword capsules */}
      {keywords.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {keywords.map((kw) => (
            <span
              key={kw.label}
              className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${kw.color}`}
            >
              {kw.label}
            </span>
          ))}
        </div>
      )}

      <div className="mt-1.5 flex items-center gap-2">
        <div className="flex -space-x-1.5">
          {previews.map((preview) => (
            <ProviderAvatar
              className="ring-1 ring-white/80"
              identity={preview.provider as "claude" | "codex" | "gemini"}
              key={preview.provider}
              size="xs"
            />
          ))}
        </div>
        <p className="min-w-0 flex-1 truncate text-xs text-slate-500">
          {previews.find((p) => p.text)?.text || "尚无消息"}
        </p>
      </div>
    </button>
  )
})
