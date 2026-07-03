"use client"

import { CheckCircle2, Circle, ListChecks } from "lucide-react"
import type { ChecklistBlock } from "@/lib/blocks"

// F030 AC2 · 只读 checklist：勾选态纯展示，无任何交互（交互归 F033）。
// 视觉对齐 card-block（F036 restyle）：圆角全框 + 扁平实底 + elevation-1 阴影 + 进度条。
export function ChecklistBlockComponent({ block }: { block: ChecklistBlock }) {
  const checkedCount = block.items.filter((i) => i.checked).length
  const total = block.items.length
  const pct = total > 0 ? Math.round((checkedCount / total) * 100) : 0

  return (
    <div
      data-block="checklist"
      className="my-1.5 rounded-2xl border border-slate-200 bg-surface-canvas p-3.5 shadow-sm"
    >
      <div className="flex items-center gap-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100">
          <ListChecks className="h-4 w-4 text-slate-500" />
        </div>
        {block.title && (
          <span className="text-sm font-semibold text-slate-800">{block.title}</span>
        )}
        <span className="ml-auto shrink-0 rounded-full border border-slate-200 bg-surface-canvas px-2 py-0.5 font-mono text-caption font-semibold text-slate-500">
          {checkedCount}/{total}
        </span>
      </div>
      <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className="h-full rounded-full bg-emerald-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <ul className="mt-2.5 space-y-1.5">
        {block.items.map((item) => (
          <li
            key={item.id}
            data-checked={item.checked === true}
            className="flex items-start gap-2 text-xs"
          >
            {item.checked ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
            ) : (
              <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-300" />
            )}
            <span className={item.checked ? "text-slate-400" : "text-slate-700"}>{item.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
