"use client"

import { MarkdownMessage } from "../markdown-message"
import type { CardBlock } from "@/lib/blocks"

const TONE_STYLES: Record<string, string> = {
  info: "border-l-blue-400 bg-blue-50/60",
  success: "border-l-emerald-400 bg-emerald-50/60",
  warning: "border-l-amber-400 bg-amber-50/60",
  danger: "border-l-rose-400 bg-rose-50/60",
}

export function CardBlockComponent({ block }: { block: CardBlock }) {
  const tone = TONE_STYLES[block.tone ?? "info"] ?? TONE_STYLES.info

  return (
    <div className={`rounded-r-xl border-l-4 p-3 ${tone}`}>
      <div className="text-sm font-semibold text-slate-800">{block.title}</div>
      {block.bodyMarkdown && (
        <div className="mt-1">
          <MarkdownMessage content={block.bodyMarkdown} className="text-xs" />
        </div>
      )}
      {block.fields && block.fields.length > 0 && (
        <div className="mt-2 grid grid-cols-2 gap-1">
          {block.fields.map((f, i) => (
            <div key={i} className="text-xs">
              <span className="text-slate-400">{f.label}:</span>{" "}
              <span className="font-mono text-slate-700">{f.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
