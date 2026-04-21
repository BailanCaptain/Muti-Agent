type Props = {
  title: string
  roomId: string
  globalRoomId?: string | null
}

export function formatShortHash(roomId: string): string {
  return roomId.slice(0, 6)
}

export function RoomBadge({ title, roomId, globalRoomId }: Props) {
  const displayTitle = title.trim() || "未命名"
  const hasGlobalId = Boolean(globalRoomId)
  const shortHash = formatShortHash(roomId)
  return (
    <div
      className="flex flex-1 items-center gap-2 rounded-[12px] bg-gradient-to-r from-indigo-50 via-violet-50 to-indigo-50 px-3 py-2 text-[11px] ring-1 ring-indigo-100/80"
      role="status"
      aria-label="房间归属徽章"
    >
      <span className="rounded-full bg-white/80 px-1.5 py-0.5 text-[9px] font-bold tracking-[0.18em] text-indigo-500 ring-1 ring-indigo-100">
        ROOM
      </span>
      <span className="flex-1 truncate text-[12px] font-semibold text-slate-900">
        {displayTitle}
      </span>
      {hasGlobalId ? (
        <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-4 text-amber-700 ring-1 ring-amber-200/60">
          {globalRoomId}
        </span>
      ) : (
        <span className="font-mono text-[10px] text-indigo-400/90">#{shortHash}</span>
      )}
    </div>
  )
}
