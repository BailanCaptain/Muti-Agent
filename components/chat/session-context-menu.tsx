"use client"

import { Archive, Check, Eraser, Pencil, Pin, Tag, Trash2 } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

import { ConfirmDialog } from "./confirm-dialog"

type SessionContextMenuProps = {
  x: number
  y: number
  groupId: string
  isPinned: boolean
  hasProjectTag: boolean
  onClose: () => void
  onTogglePin: (groupId: string) => void
  onRequestRename: (groupId: string) => void
  onSetProjectTag: (groupId: string, tag: string | null) => Promise<void>
  onClearProjectTag: (groupId: string) => Promise<void>
  onArchive: (groupId: string) => Promise<void>
  onDelete: (groupId: string) => Promise<void>
}

export function SessionContextMenu({
  x,
  y,
  groupId,
  isPinned,
  hasProjectTag,
  onClose,
  onTogglePin,
  onRequestRename,
  onSetProjectTag,
  onClearProjectTag,
  onArchive,
  onDelete,
}: SessionContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [showTagInput, setShowTagInput] = useState(false)
  const [tagValue, setTagValue] = useState("")
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (confirmingDelete) return
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (confirmingDelete) return
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", handleClick)
    document.addEventListener("keydown", handleKey)
    return () => {
      document.removeEventListener("mousedown", handleClick)
      document.removeEventListener("keydown", handleKey)
    }
  }, [onClose, confirmingDelete])

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

  const handleRename = useCallback(() => {
    onRequestRename(groupId)
    onClose()
  }, [groupId, onRequestRename, onClose])

  const handleSetTag = useCallback(async () => {
    const tag = tagValue.trim() || null
    await onSetProjectTag(groupId, tag)
    onClose()
  }, [groupId, tagValue, onSetProjectTag, onClose])

  const handleClearTag = useCallback(async () => {
    await onClearProjectTag(groupId)
    onClose()
  }, [groupId, onClearProjectTag, onClose])

  const handleArchive = useCallback(async () => {
    await onArchive(groupId)
    onClose()
  }, [groupId, onArchive, onClose])

  // AC-14j: 软删二次确认（铁律：不提供物理删除）
  const handleDelete = useCallback(() => {
    setConfirmingDelete(true)
  }, [])

  const handleConfirmDelete = useCallback(async () => {
    setConfirmingDelete(false)
    await onDelete(groupId)
    onClose()
  }, [groupId, onDelete, onClose])

  const handleCancelDelete = useCallback(() => {
    setConfirmingDelete(false)
    onClose()
  }, [onClose])

  if (typeof document === "undefined") return null

  return createPortal(
    <div ref={menuRef} style={style}>
      <div className="min-w-[200px] rounded-lg border border-amber-200/60 bg-white py-1 shadow-2xl ring-1 ring-black/5">
        <MenuItem
          icon={<Pin className="h-3.5 w-3.5" />}
          label={isPinned ? "取消置顶" : "置顶"}
          onClick={handlePin}
        />

        <MenuItem
          icon={<Pencil className="h-3.5 w-3.5" />}
          label="重命名"
          onClick={handleRename}
        />

        {showTagInput ? (
          <div className="flex items-center gap-1.5 px-2 py-1.5">
            <Tag className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            <input
              autoFocus
              className="min-w-0 flex-1 rounded border border-amber-300 bg-white px-2 py-1 text-xs text-slate-700 placeholder:text-slate-400 outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-400/40"
              onChange={(e) => setTagValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSetTag()
                if (e.key === "Escape") setShowTagInput(false)
              }}
              placeholder="如 F022，回车保存"
              value={tagValue}
            />
            <button
              aria-label="保存标签"
              className="shrink-0 inline-flex h-6 w-6 items-center justify-center rounded bg-amber-500 text-white transition hover:bg-amber-600"
              onClick={() => void handleSetTag()}
              type="button"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <MenuItem
            icon={<Tag className="h-3.5 w-3.5" />}
            label="设置项目标签"
            onClick={() => setShowTagInput(true)}
          />
        )}

        {hasProjectTag && (
          <MenuItem
            icon={<Eraser className="h-3.5 w-3.5" />}
            label="清除项目标签"
            onClick={handleClearTag}
          />
        )}

        <div className="my-1 border-t border-slate-200/40" />

        <MenuItem
          icon={<Archive className="h-3.5 w-3.5" />}
          label="归档"
          onClick={handleArchive}
        />

        <MenuItem
          icon={<Trash2 className="h-3.5 w-3.5" />}
          label="删除"
          danger
          onClick={handleDelete}
        />
      </div>

      <ConfirmDialog
        cancelLabel="取消"
        confirmLabel="删除"
        danger
        description="会话将被软删除，可随时在左侧栏底部「归档列表」中恢复（铁律：不提供物理删除）。"
        onCancel={handleCancelDelete}
        onConfirm={handleConfirmDelete}
        open={confirmingDelete}
        title="确定软删除此会话？"
      />
    </div>,
    document.body,
  )
}

function MenuItem({
  icon,
  label,
  danger = false,
  disabled = false,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition ${
        disabled
          ? "cursor-not-allowed text-slate-300"
          : danger
            ? "text-red-500 hover:bg-red-50"
            : "text-slate-600 hover:bg-slate-100/80"
      }`}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      type="button"
    >
      {icon}
      {label}
    </button>
  )
}
