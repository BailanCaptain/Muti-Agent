"use client"

import { useThreadStore } from "@/components/stores/thread-store"
import type { Provider } from "@multi-agent/shared"
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Plus,
  Search,
  Pin,
  Tag,
  Trash2,
} from "lucide-react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ProviderAvatar } from "./provider-avatar"
import { SessionContextMenu } from "./session-context-menu"

const baseUrl = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"

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

type TimeBucket = "today" | "thisWeek" | "thisMonth" | "earlier"

type TimeGroup = {
  bucket: TimeBucket
  label: string
  items: Array<{
    id: string
    roomId: string | null
    title: string
    updatedAt: string
    updatedAtLabel: string
    createdAt: string
    createdAtLabel: string
    projectTag?: string
    titleLockedAt?: string | null
    participants: Provider[]
    messageCount: number
    previews: Array<{ provider: string; alias: string; text: string }>
  }>
}

// F022 Phase 3.5 (AC-14i/j): 归档列表条目结构（与主列表不同：无 previews/participants）
type ArchivedItem = {
  id: string
  roomId: string | null
  title: string
  updatedAtLabel: string
  archivedAt: string | null
  deletedAt: string | null
}

const BUCKET_ORDER: TimeBucket[] = ["today", "thisWeek", "thisMonth", "earlier"]
const BUCKET_LABELS: Record<TimeBucket, string> = {
  today: "今日",
  thisWeek: "本周",
  thisMonth: "本月",
  earlier: "更早",
}

// 分桶维度：会话创建时间 createdAt（稳定，不受新消息/加锁影响）。周起点 = 本周周一 00:00（ISO 标准）。
function computeBucketBoundaries(now: Date) {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayOfWeek = now.getDay() // 0=Sun
  const daysFromMonday = (dayOfWeek + 6) % 7
  const weekStart = todayStart - daysFromMonday * 86_400_000
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  return { todayStart, weekStart, monthStart }
}

function bucketOf(isoTime: string, boundaries: ReturnType<typeof computeBucketBoundaries>): TimeBucket {
  const t = new Date(isoTime).getTime()
  if (t >= boundaries.todayStart) return "today"
  if (t >= boundaries.weekStart) return "thisWeek"
  if (t >= boundaries.monthStart) return "thisMonth"
  return "earlier"
}

const ROOM_ID_PATTERN = /^r-?0*(\d+)$/i

function matchRoomId(query: string): string | null {
  const m = query.trim().match(ROOM_ID_PATTERN)
  if (!m) return null
  return `R-${m[1].padStart(3, "0")}`
}

/* ── Component ── */

export function SessionSidebar() {
  const sessionGroups = useThreadStore((state) => state.sessionGroups)
  const activeGroupId = useThreadStore((state) => state.activeGroupId)
  const createGroup = useThreadStore((state) => state.createSessionGroup)
  const selectGroup = useThreadStore((state) => state.selectSessionGroup)
  const replaceSessionGroups = useThreadStore((state) => state.replaceSessionGroups)
  const unreadCounts = useThreadStore((state) => state.unreadCounts)
  const anyProviderRunning = useThreadStore((state) =>
    Object.values(state.providers).some((p) => p.running)
  )

  const [search, setSearch] = useState("")
  const [pinned, setPinned] = useState<Set<string>>(new Set())
  const [collapsedTags, setCollapsedTags] = useState<Set<string>>(new Set())
  // F022 Phase 3.5 (AC-14g): 哪个 group 处于行内重命名输入态；null 表示无
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)
  // F022 Phase 3.5 (AC-14i/j): 归档列表
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [archivedItems, setArchivedItems] = useState<ArchivedItem[]>([])

  // Context menu — hasProjectTag 传给菜单控制"清除项目标签"可见性
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    groupId: string
    isPinned: boolean
    hasProjectTag: boolean
  } | null>(null)

  // F022 Phase 3.5: 主列表刷新（复用 /api/bootstrap 的 sessionGroups 字段）
  const reloadSessionGroups = useCallback(async () => {
    const res = await fetch(`${baseUrl}/api/bootstrap`)
    const data = (await res.json()) as { sessionGroups: Parameters<typeof replaceSessionGroups>[0] }
    replaceSessionGroups(data.sessionGroups)
  }, [replaceSessionGroups])

  const reloadArchived = useCallback(async () => {
    const res = await fetch(`${baseUrl}/api/archived-session-groups`)
    const data = (await res.json()) as {
      sessionGroups: Array<{
        id: string
        roomId: string | null
        title: string
        updatedAtLabel: string
        archivedAt?: string | null
        deletedAt?: string | null
      }>
    }
    setArchivedItems(
      data.sessionGroups.map((g) => ({
        id: g.id,
        roomId: g.roomId,
        title: g.title,
        updatedAtLabel: g.updatedAtLabel,
        archivedAt: g.archivedAt ?? null,
        deletedAt: g.deletedAt ?? null,
      })),
    )
  }, [])

  const handleRequestRename = useCallback((groupId: string) => {
    setRenamingGroupId(groupId)
  }, [])

  const handleCommitRename = useCallback(
    async (groupId: string, newTitle: string) => {
      const trimmed = newTitle.trim()
      if (trimmed.length === 0) {
        setRenamingGroupId(null)
        return
      }
      if (trimmed.length > 40) {
        console.warn("[session-sidebar] rename rejected: title > 40 chars")
        return
      }
      try {
        await fetch(`${baseUrl}/api/session-groups/${groupId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: trimmed }),
        })
        await reloadSessionGroups()
      } catch (err) {
        console.error("[session-sidebar] rename error", err)
      }
      setRenamingGroupId(null)
    },
    [reloadSessionGroups],
  )

  const handleCancelRename = useCallback(() => {
    setRenamingGroupId(null)
  }, [])

  const handleSetProjectTag = useCallback(
    async (groupId: string, tag: string | null) => {
      try {
        await fetch(`${baseUrl}/api/session-groups/${groupId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectTag: tag }),
        })
        await reloadSessionGroups()
      } catch (err) {
        console.error("[session-sidebar] set tag error", err)
      }
    },
    [reloadSessionGroups],
  )

  const handleClearProjectTag = useCallback(
    async (groupId: string) => {
      await handleSetProjectTag(groupId, null)
    },
    [handleSetProjectTag],
  )

  // 会话被移出可见列表（归档/软删）后，若正好是当前选中，则跳到下一条，
  // 没有下一条退回前一条；一条都不剩就清 activeGroupId。避免详情面板残留指向
  // 一个已不可见会话造成"删了还在显示"的错觉。
  const switchAwayIfActive = useCallback(
    async (removedId: string) => {
      const state = useThreadStore.getState()
      if (state.activeGroupId !== removedId) return
      const list = state.sessionGroups
      const i = list.findIndex((g) => g.id === removedId)
      const next = i >= 0 ? (list[i + 1] ?? list[i - 1]) : undefined
      if (next) {
        await selectGroup(next.id)
      } else {
        useThreadStore.setState({ activeGroupId: null })
      }
    },
    [selectGroup],
  )

  const handleArchive = useCallback(
    async (groupId: string) => {
      try {
        await fetch(`${baseUrl}/api/session-groups/${groupId}/archive`, { method: "POST" })
        await switchAwayIfActive(groupId)
        await reloadSessionGroups()
        if (archivedOpen) await reloadArchived()
      } catch (err) {
        console.error("[session-sidebar] archive error", err)
      }
    },
    [reloadSessionGroups, reloadArchived, archivedOpen, switchAwayIfActive],
  )

  const handleDelete = useCallback(
    async (groupId: string) => {
      try {
        await fetch(`${baseUrl}/api/session-groups/${groupId}`, { method: "DELETE" })
        await switchAwayIfActive(groupId)
        await reloadSessionGroups()
        if (archivedOpen) await reloadArchived()
      } catch (err) {
        console.error("[session-sidebar] delete error", err)
      }
    },
    [reloadSessionGroups, reloadArchived, archivedOpen, switchAwayIfActive],
  )

  const handleRestore = useCallback(
    async (groupId: string) => {
      try {
        await fetch(`${baseUrl}/api/session-groups/${groupId}/restore`, { method: "POST" })
        await reloadSessionGroups()
        await reloadArchived()
        // 恢复后自动选中该会话，省一次点击
        await selectGroup(groupId)
      } catch (err) {
        console.error("[session-sidebar] restore error", err)
      }
    },
    [reloadSessionGroups, reloadArchived, selectGroup],
  )

  const toggleArchivedOpen = useCallback(async () => {
    const next = !archivedOpen
    setArchivedOpen(next)
    if (next) await reloadArchived()
  }, [archivedOpen, reloadArchived])

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

  // Filter by search (ROOM-ID 精确优先 → fuzzy)
  const filtered = useMemo(() => {
    const raw = search.trim()
    if (!raw) return sessionGroups
    const roomTarget = matchRoomId(raw)
    if (roomTarget) return sessionGroups.filter((g) => g.roomId === roomTarget)
    const query = raw.toLowerCase()
    return sessionGroups.filter(
      (group) =>
        group.title.toLowerCase().includes(query) ||
        group.previews.some((p) => p.text.toLowerCase().includes(query)),
    )
  }, [sessionGroups, search])

  // R-xxx 命中唯一房间时自动选中（debounce 由用户输入节奏自然形成）
  useEffect(() => {
    const roomTarget = matchRoomId(search)
    if (!roomTarget) return
    const hit = sessionGroups.find((g) => g.roomId === roomTarget)
    if (hit && hit.id !== activeGroupId) {
      void selectGroup(hit.id)
    }
  }, [search, sessionGroups, activeGroupId, selectGroup])

  // Split into pinned and time-bucketed groups (AC-14a)
  const pinnedItems = useMemo(
    () =>
      filtered
        .filter((g) => pinned.has(g.id))
        .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)),
    [filtered, pinned],
  )

  const timeGroups = useMemo<TimeGroup[]>(() => {
    const unpinned = filtered.filter((g) => !pinned.has(g.id))
    const boundaries = computeBucketBoundaries(new Date())
    const buckets: Record<TimeBucket, TimeGroup["items"]> = {
      today: [],
      thisWeek: [],
      thisMonth: [],
      earlier: [],
    }
    for (const item of unpinned) {
      buckets[bucketOf(item.createdAt, boundaries)].push(item)
    }
    for (const key of BUCKET_ORDER) {
      buckets[key].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    }
    return BUCKET_ORDER.filter((b) => buckets[b].length > 0).map((b) => ({
      bucket: b,
      label: BUCKET_LABELS[b],
      items: buckets[b],
    }))
  }, [filtered, pinned])

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, groupId: string, isPinned: boolean, hasProjectTag: boolean) => {
      e.preventDefault()
      setContextMenu({ x: e.clientX, y: e.clientY, groupId, isPinned, hasProjectTag })
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
        {filtered.length === 0 && search.trim() !== "" && (
          <div className="px-2 py-4 text-center text-xs text-slate-400">
            {matchRoomId(search)
              ? `未找到房间 ${matchRoomId(search)}`
              : "无匹配会话"}
          </div>
        )}
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
                  roomId={group.roomId}
                  title={group.title}
                  updatedAtLabel={group.updatedAtLabel}
                  createdAtLabel={group.createdAtLabel}
                  messageCount={group.messageCount}
                  unreadCount={unreadCounts[group.id] ?? 0}
                  participants={group.participants}
                  previews={group.previews}
                  projectTag={group.projectTag}
                  titleLockedAt={group.titleLockedAt}
                  active={activeGroupId === group.id}
                  running={runningGroupIds.has(group.id)}
                  isPinned={true}
                  isRenaming={renamingGroupId === group.id}
                  onSelect={selectGroup}
                  onCtxMenu={handleContextMenu}
                  onRenameCommit={handleCommitRename}
                  onRenameCancel={handleCancelRename}
                />
              ))}
            </div>
          </div>
        )}

        {/* Time-bucketed groups (AC-14a) */}
        {timeGroups.map((tg) => (
          <div key={tg.bucket} className="mb-1">
            <button
              className="mb-0.5 flex w-full items-center gap-1.5 px-2 py-1 text-left"
              onClick={() => toggleCollapse(tg.bucket)}
              type="button"
            >
              {collapsedTags.has(tg.bucket) ? (
                <ChevronRight className="h-3 w-3 text-slate-400" />
              ) : (
                <ChevronDown className="h-3 w-3 text-slate-400" />
              )}
              <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                {tg.label}
              </span>
              <span className="ml-auto rounded-full bg-slate-100 px-1.5 text-[10px] font-mono text-slate-500">
                {tg.items.length}
              </span>
            </button>
            {!collapsedTags.has(tg.bucket) && (
              <div className="space-y-0.5">
                {tg.items.map((group) => (
                  <SessionCard
                    key={group.id}
                    groupId={group.id}
                    roomId={group.roomId}
                    title={group.title}
                    updatedAtLabel={group.updatedAtLabel}
                    createdAtLabel={group.createdAtLabel}
                    messageCount={group.messageCount}
                    unreadCount={unreadCounts[group.id] ?? 0}
                    participants={group.participants}
                    previews={group.previews}
                    projectTag={group.projectTag}
                    titleLockedAt={group.titleLockedAt}
                    active={activeGroupId === group.id}
                    running={runningGroupIds.has(group.id)}
                    isPinned={pinned.has(group.id)}
                    isRenaming={renamingGroupId === group.id}
                    onSelect={selectGroup}
                    onCtxMenu={handleContextMenu}
                    onRenameCommit={handleCommitRename}
                    onRenameCancel={handleCancelRename}
                  />
                ))}
              </div>
            )}
          </div>
        ))}

        {/* F022 Phase 3.5 (AC-14i/j): 归档列表 — 固定在滚动列表底部，可折叠 */}
        <div className="mt-4 border-t border-slate-200/40 pt-2">
          <button
            className="flex w-full items-center gap-1.5 px-2 py-1 text-left"
            onClick={() => void toggleArchivedOpen()}
            type="button"
          >
            {archivedOpen ? (
              <ChevronDown className="h-3 w-3 text-slate-400" />
            ) : (
              <ChevronRight className="h-3 w-3 text-slate-400" />
            )}
            <Archive className="h-3 w-3 text-slate-400" />
            <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              归档列表
            </span>
            {archivedOpen && archivedItems.length > 0 && (
              <span className="ml-auto rounded-full bg-slate-100 px-1.5 text-[10px] font-mono text-slate-500">
                {archivedItems.length}
              </span>
            )}
          </button>
          {archivedOpen && (
            <div className="mt-1 space-y-0.5">
              {archivedItems.length === 0 ? (
                <div className="px-2 py-2 text-center text-xs text-slate-400">归档列表为空</div>
              ) : (
                archivedItems.map((item) => (
                  <ArchivedRow
                    key={item.id}
                    item={item}
                    onRestore={handleRestore}
                  />
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <SessionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          groupId={contextMenu.groupId}
          isPinned={contextMenu.isPinned}
          hasProjectTag={contextMenu.hasProjectTag}
          onClose={closeContextMenu}
          onTogglePin={togglePin}
          onRequestRename={handleRequestRename}
          onSetProjectTag={handleSetProjectTag}
          onClearProjectTag={handleClearProjectTag}
          onArchive={handleArchive}
          onDelete={handleDelete}
        />
      )}
    </aside>
  )
}

/* ── Archived Row ── */

function ArchivedRow({
  item,
  onRestore,
}: {
  item: ArchivedItem
  onRestore: (groupId: string) => Promise<void>
}) {
  const statusLabel = item.deletedAt ? "已删除" : "归档中"
  return (
    <div className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-slate-500 hover:bg-slate-50/60">
      {item.roomId && (
        <span className="shrink-0 font-mono text-[10px] font-semibold text-amber-600/70">
          {item.roomId}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
      <span
        className={`shrink-0 rounded px-1 text-[9px] font-semibold ${
          item.deletedAt ? "bg-red-100 text-red-500" : "bg-slate-100 text-slate-500"
        }`}
      >
        {statusLabel}
      </span>
      <button
        className="shrink-0 rounded p-0.5 text-slate-400 transition hover:bg-slate-200/60 hover:text-emerald-600"
        onClick={() => void onRestore(item.id)}
        title="恢复"
        type="button"
      >
        <ArchiveRestore className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

/* ── Session Card ── */

type SessionCardProps = {
  groupId: string
  roomId: string | null
  title: string
  updatedAtLabel: string
  createdAtLabel: string
  messageCount: number
  unreadCount: number
  participants: Provider[]
  previews: Array<{ provider: string; alias: string; text: string }>
  projectTag?: string
  titleLockedAt?: string | null
  active: boolean
  running: boolean
  isPinned: boolean
  isRenaming: boolean
  onSelect: (groupId: string) => void
  onCtxMenu: (
    e: React.MouseEvent,
    groupId: string,
    isPinned: boolean,
    hasProjectTag: boolean,
  ) => void
  onRenameCommit: (groupId: string, newTitle: string) => Promise<void> | void
  onRenameCancel: () => void
}

const SessionCard = memo(function SessionCard({ groupId, roomId, title, updatedAtLabel, createdAtLabel, messageCount, unreadCount, participants, previews, projectTag, titleLockedAt, active, running, isPinned, isRenaming, onSelect, onCtxMenu, onRenameCommit, onRenameCancel }: SessionCardProps) {
  const handleClick = useCallback(() => {
    if (isRenaming) return
    void onSelect(groupId)
  }, [onSelect, groupId, isRenaming])

  const handleCtxMenu = useCallback((e: React.MouseEvent) => {
    onCtxMenu(e, groupId, isPinned, Boolean(projectTag))
  }, [onCtxMenu, groupId, isPinned, projectTag])

  // F022 Phase 3.5 (AC-14g): 行内重命名输入
  const [draft, setDraft] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (isRenaming) {
      setDraft(title)
      const h = setTimeout(() => inputRef.current?.select(), 0)
      return () => clearTimeout(h)
    }
  }, [isRenaming, title])

  // F022 Phase 3.5 (AC-14k): three-column layout per 桂芬's design —
  // left: avatar stack (xs) with running dot as badge on the group corner;
  // middle: flex-1 title (with R-xxx mono pill + lock) + preview + projectTag;
  // right: fixed width meta column with time on top, unread amber badge below.
  const previewText = previews.find((p) => p.text)?.text || "尚无消息"

  return (
    <button
      className={`group relative w-full rounded-md px-2.5 py-2 text-left transition ${
        active
          ? "border-l-[3px] border-amber-500 bg-white/90 shadow-sm"
          : "border-l-[3px] border-transparent hover:bg-amber-50/60"
      }`}
      onClick={handleClick}
      onContextMenu={handleCtxMenu}
      title={`创建 ${createdAtLabel} · 最后活动 ${updatedAtLabel} · ${messageCount} 条消息`}
      type="button"
    >
      {/* Row 1: R-042 + lock + title (+ time, unread on right) */}
      <div className="flex min-w-0 items-center gap-1">
        {roomId && (
          <span className="shrink-0 rounded bg-slate-100 px-1 py-0 font-mono text-[10px] font-medium text-slate-500 leading-4">
            {roomId}
          </span>
        )}
        {titleLockedAt && (
          <span
            aria-label="手动命名（已锁定）"
            className="shrink-0 text-sm leading-none"
            title="手动命名（已锁定，不会被自动重命名覆盖）"
          >
            🔒
          </span>
        )}
        {isRenaming ? (
          <input
            ref={inputRef}
            className="min-w-0 flex-1 rounded border border-amber-500/40 bg-white/90 px-1.5 py-0.5 text-sm font-medium text-slate-800 outline-none focus:border-amber-500"
            maxLength={40}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === "Enter") void onRenameCommit(groupId, draft)
              if (e.key === "Escape") onRenameCancel()
            }}
            onBlur={() => void onRenameCommit(groupId, draft)}
            value={draft}
          />
        ) : (
          <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">
            {title}
          </h3>
        )}
        <span className="shrink-0 text-[10px] leading-none text-slate-400">{updatedAtLabel}</span>
        {unreadCount > 0 && (
          <span className="shrink-0 min-w-[18px] rounded-full bg-amber-500 px-1.5 text-center text-[10px] font-medium leading-[18px] text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </div>

      {/* Row 2: avatar stack (with running badge) + preview + projectTag */}
      <div className="mt-1 flex min-w-0 items-center gap-1.5">
        <div className="relative shrink-0">
          <div className="flex -space-x-1.5">
            {participants.length === 0 ? (
              <span className="h-5 w-5 rounded-full bg-slate-100 ring-1 ring-white/80" />
            ) : (
              participants.map((p) => (
                <ProviderAvatar
                  className="ring-1 ring-white/80"
                  identity={p}
                  key={p}
                  size="2xs"
                />
              ))
            )}
          </div>
          {running && (
            <span
              aria-label="运行中"
              className="absolute -bottom-0.5 -right-0.5 flex h-2 w-2"
            >
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full border border-white bg-green-500" />
            </span>
          )}
        </div>
        <p className="min-w-0 flex-1 truncate text-xs text-slate-500">{previewText}</p>
        {projectTag && (
          <span className="shrink-0 rounded bg-amber-100/80 px-1.5 text-[10px] font-medium leading-4 text-amber-700 ring-1 ring-amber-200/60">
            {projectTag}
          </span>
        )}
      </div>
    </button>
  )
})
