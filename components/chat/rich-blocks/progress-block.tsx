"use client"

import { BarChart3 } from "lucide-react"
import type { ProgressBlock } from "@/lib/blocks"

// F036 #10 · 只读进度/计量条（覆盖「投票」诉求：read-only tally，真投票交互归 F033）。
// value=0~100 百分比；caption 放原始计数（"12/20" / "8 票"），缺省回落显示百分比。
const TONE_BAR: Record<string, string> = {
  info: "bg-accent-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-rose-500",
}

export function ProgressBlockComponent({ block }: { block: ProgressBlock }) {
  return (
    <div
      data-block="progress"
      className="my-1.5 rounded-2xl border border-slate-200 bg-surface-canvas p-3.5 shadow-sm"
    >
      {block.title && (
        <div className="mb-2.5 flex items-center gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100">
            <BarChart3 className="h-4 w-4 text-slate-500" />
          </div>
          <span className="text-sm font-semibold text-slate-800">{block.title}</span>
        </div>
      )}
      <ul className="space-y-2.5">
        {block.items.map((item, i) => {
          const pct = Math.min(100, Math.max(0, item.value))
          const bar = TONE_BAR[item.tone ?? "info"] ?? TONE_BAR.info
          return (
            <li key={i} data-tone={item.tone ?? "info"}>
              <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate text-slate-700">{item.label}</span>
                <span className="shrink-0 font-mono text-[11px] font-semibold text-slate-500">
                  {item.caption ?? `${Math.round(pct)}%`}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  data-testid="progress-bar"
                  className={`h-full rounded-full transition-all ${bar}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
