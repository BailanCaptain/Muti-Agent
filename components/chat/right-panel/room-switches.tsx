"use client"

type Props = {
  showThinking: boolean
  onToggleThinking: (next: boolean) => void
}

export function RoomSwitches({ showThinking, onToggleThinking }: Props) {
  return (
    <div className="flex flex-col gap-2">
      <div className="px-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        房间开关
      </div>
      <label className="flex cursor-pointer items-center justify-between gap-2 rounded-[12px] border border-slate-200 bg-white px-3.5 py-2.5 text-xs text-slate-900">
        <span className="flex items-center gap-2">
          心里话模式
          <span className="text-[10px] text-slate-400">显示 thinking</span>
        </span>
        <span className="relative inline-block">
          <input
            type="checkbox"
            aria-label="心里话模式"
            className="peer sr-only"
            checked={showThinking}
            onChange={(e) => onToggleThinking(e.target.checked)}
          />
          <span className="block h-[18px] w-[34px] rounded-full bg-slate-200 transition peer-checked:bg-violet-500" />
          <span className="pointer-events-none absolute left-0.5 top-0.5 h-[14px] w-[14px] rounded-full bg-white shadow transition peer-checked:translate-x-4" />
        </span>
      </label>
    </div>
  )
}
