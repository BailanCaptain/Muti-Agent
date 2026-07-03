"use client"

import type { DiffBlock } from "@/lib/blocks"

function classifyLine(line: string): string {
  if (line.startsWith("+")) return "bg-emerald-50 text-emerald-800"
  if (line.startsWith("-")) return "bg-rose-50 text-rose-800"
  if (line.startsWith("@@")) return "bg-slate-100 text-slate-500 font-semibold"
  return "text-slate-600"
}

export function DiffBlockComponent({ block }: { block: DiffBlock }) {
  const lines = block.diff.split("\n")

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200">
      <div className="border-b border-slate-200 bg-slate-100 px-4 py-1.5 font-mono text-caption text-slate-500 truncate">
        {block.filePath}
      </div>
      <pre className="overflow-x-auto bg-surface-canvas px-4 py-2 font-mono text-xs leading-5">
        {lines.map((line, i) => (
          <div key={i} className={`px-1 ${classifyLine(line)}`}>
            {line || " "}
          </div>
        ))}
      </pre>
    </div>
  )
}
