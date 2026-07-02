"use client"

import { Table2 } from "lucide-react"
import type { TableBlock } from "@/lib/blocks"

// F036 #10 · 只读数据表格（覆盖「对比」诉求：2 列即左右对比）。
// schema 已 fail-closed 保证行宽 == 列数（union superRefine，见 rich-blocks.ts）；此处仍按 columns
// 铺格 + `row[ci] ?? ""` 作防御冗余。zebra 用 hex slate-50（accent/surface 是 var(oklch)，
// Tailwind v3.4 opacity 修饰符会被静默忽略）。
export function TableBlockComponent({ block }: { block: TableBlock }) {
  return (
    <div
      data-block="table"
      className="my-1.5 overflow-hidden rounded-2xl border border-slate-200 bg-surface-canvas shadow-sm"
    >
      {block.title && (
        <div className="flex items-center gap-2.5 border-b border-slate-200 px-3.5 py-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100">
            <Table2 className="h-4 w-4 text-slate-500" />
          </div>
          <span className="text-sm font-semibold text-slate-800">{block.title}</span>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-surface-elevated">
              {block.columns.map((col, i) => (
                <th
                  key={i}
                  className="border-b border-slate-200 px-3 py-2 text-left font-semibold text-slate-600"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, ri) => (
              <tr key={ri} className="even:bg-slate-50">
                {block.columns.map((_, ci) => (
                  <td
                    key={ci}
                    className="border-b border-slate-100 px-3 py-2 align-top text-slate-700"
                  >
                    {row[ci] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
