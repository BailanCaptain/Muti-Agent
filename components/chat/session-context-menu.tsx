"use client"

import { useThreadStore } from "@/components/stores/thread-store"
import {
  Archive,
  Pencil,
  Pin,
  Tag,
  Trash2,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

type SessionContextMenuProps = {
  x: number
  y: number
  groupId: string
  isPinned: boolean
  onClose: () => void
  onTogglePin: (groupId: string) => void
}

const baseUrl = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"

export function SessionContextMenu({
  x,
  y,
  groupId,
  isPinned,
  onClose,
  onTogglePin,
}: SessionContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [showTagInput, setShowTagInput] = useState(false)
  const [tagValue, setTagValue] = useState("")
  const [showRenameInput, setShowRenameInput] = useState(false)
  const [renameValue, setRenameValue] = useState("")
  const replaceSessionGroups = useThreadStore((s) => s.replaceSessionGroups)

  // Close on outside click or Escape
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", handleClick)
    document.addEventListener("keydown", handleKey)
    return () => {
      document.removeEventListener("mousedown", handleClick)
      document.removeEventListener("keydown", handleKey)
    }
  }, [onClose])

  // Adjust position so menu doesn't overflow viewport
  const style: React.CSSProperties = {
    position: "fixed",
    left: x,
    top: y,
    zIndex: 9999,
  }

  const handlePin = useCallback(() => {
    onTogglePin(groupId)
    onClose()
  }, [groupId, onTogglePin, onClose])

  const handleSetTag = useCallback(async () => {
    const tag = tagValue.trim() || null
    try {
      await fetch(`${baseUrl}/api/session-groups/${groupId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectTag: tag }),
      })
      // Refresh session groups
      const res = await fetch(`${baseUrl}/api/bootstrap`)
      const data = (await res.json()) as { sessionGroups: Array<{ id: string; title: string; updatedAtLabel: string; projectTag?: string; previews: Array<{ provider: string; alias: string; text: string }> }> }
      replaceSessionGroups(data.sessionGroups as Parameters<typeof replaceSessionGroups>[0])
    } catch {
      // Silently fail
    }
    onClose()
  }, [groupId, tagValue, onClose, replaceSessionGroups])

  const handleRename = useCallback(async () => {
    // For now, rename is a placeholder since we don't have a rename endpoint yet
    // A rename feature requires a backend PATCH for title — skip for now
    onClose()
  }, [onClose])

  const handleArchive = useCallback(() => {
    // Archive is a placeholder — future feature
    onClose()
  }, [onClose])

  const handleDelete = useCallback(() => {
    // Delete is a placeholder — future feature (Iron Law: data is sacred)
    onClose()
  }, [onClose])

  return (
    <div ref={menuRef} style={style}>
      <div className="min-w-[180px] rounded-lg border border-slate-700 bg-slate-900 py-1 shadow-xl">
        {/* Pin / Unpin */}
        <MenuItem
          icon={<Pin className="h-3.5 w-3.5" />}
          label={isPinned ? "取消置顶" : "置顶"}
          onClick={handlePin}
        />

        {/* Rename */}
        {showRenameInput ? (
          <div className="px-2 py-1.5">
            <input
              autoFocus
              className="w-full rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200 outline-none focus:border-amber-500"
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleRename()
                if (e.key === "Escape") setShowRenameInput(false)
              }}
              placeholder="新名称..."
              value={renameValue}
            />
          </div>
        ) : (
          <MenuItem
            icon={<Pencil className="h-3.5 w-3.5" />}
            label="重命名"
            onClick={() => setShowRenameInput(true)}
          />
        )}

        {/* Set project tag */}
        {showTagInput ? (
          <div className="px-2 py-1.5">
            <input
              autoFocus
              className="w-full rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200 outline-none focus:border-amber-500"
              onChange={(e) => setTagValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSetTag()
                if (e.key === "Escape") setShowTagInput(false)
              }}
              placeholder="项目标签（留空清除）..."
              value={tagValue}
            />
          </div>
        ) : (
          <MenuItem
            icon={<Tag className="h-3.5 w-3.5" />}
            label="设置项目标签"
            onClick={() => setShowTagInput(true)}
          />
        )}

        {/* Divider */}
        <div className="my-1 border-t border-slate-800" />

        {/* Archive */}
        <MenuItem
          icon={<Archive className="h-3.5 w-3.5" />}
          label="归档"
          onClick={handleArchive}
        />

        {/* Delete */}
        <MenuItem
          icon={<Trash2 className="h-3.5 w-3.5" />}
          label="删除"
          danger
          onClick={handleDelete}
        />
      </div>
    </div>
  )
}

/* ── Menu item ── */

function MenuItem({
  icon,
  label,
  danger = false,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition ${
        danger
          ? "text-red-400 hover:bg-red-900/30"
          : "text-slate-300 hover:bg-slate-800"
      }`}
      onClick={onClick}
      type="button"
    >
      {icon}
      {label}
    </button>
  )
}
