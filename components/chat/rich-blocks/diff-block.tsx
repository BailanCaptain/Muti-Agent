"use client"

import type { DiffBlock } from "@/lib/blocks"

function classifyLine(line: string): string {
  if (line.startsWith("+")) return "bg-emerald-50 text-emerald-800"
  if (line.startsWith("-")) return "bg-rose-50 text-rose-800"
  if (line.startsWith("@@")) return "bg-blue-50 text-blue-600 font-semibold"
  return "text-slate-600"
}

export function DiffBlockComponent({ block }: { block: DiffBlock }) {
  const lines = block.diff.split("\n")

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200/80">
      <div className="border-b border-slate-200/80 bg-slate-100 px-4 py-1.5 font-mono text-[11px] text-slate-500 truncate">
        {block.filePath}
      </div>
      <pre className="overflow-x-auto bg-white px-4 py-2 font-mono text-[12px] leading-5">
        {lines.map((line, i) => (
          <div key={i} className={`px-1 ${classifyLine(line)}`}>
            {line || " "}
          </div>
        ))}
      </pre>
    </div>
  )
}
