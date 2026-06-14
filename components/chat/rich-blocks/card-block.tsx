"use client"

import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react"
import type { ComponentType } from "react"
import { MarkdownMessage } from "../markdown-message"
import type { CardBlock } from "@/lib/blocks"

type ToneStyle = {
  container: string
  iconWrap: string
  iconColor: string
  icon: ComponentType<{ className?: string }>
}

// 对齐 decision-card 的视觉语言：圆角全框 + 渐变底 + 柔和带色阴影 + tone 图标。
const TONE_STYLES: Record<string, ToneStyle> = {
  info: {
    container:
      "border-sky-200/70 bg-gradient-to-br from-sky-50 to-blue-50/40 shadow-[0_4px_16px_rgba(59,130,246,0.08)]",
    iconWrap: "bg-sky-100/80",
    iconColor: "text-sky-500",
    icon: Info,
  },
  success: {
    container:
      "border-emerald-200/70 bg-gradient-to-br from-emerald-50 to-teal-50/40 shadow-[0_4px_16px_rgba(16,185,129,0.10)]",
    iconWrap: "bg-emerald-100/80",
    iconColor: "text-emerald-500",
    icon: CheckCircle2,
  },
  warning: {
    container:
      "border-amber-200/70 bg-gradient-to-br from-amber-50 to-orange-50/40 shadow-[0_4px_16px_rgba(245,158,11,0.10)]",
    iconWrap: "bg-amber-100/80",
    iconColor: "text-amber-500",
    icon: AlertTriangle,
  },
  danger: {
    container:
      "border-rose-200/70 bg-gradient-to-br from-rose-50 to-red-50/40 shadow-[0_4px_16px_rgba(244,63,94,0.10)]",
    iconWrap: "bg-rose-100/80",
    iconColor: "text-rose-500",
    icon: XCircle,
  },
}

export function CardBlockComponent({ block }: { block: CardBlock }) {
  const toneKey = block.tone ?? "info"
  const tone = TONE_STYLES[toneKey] ?? TONE_STYLES.info
  const ToneIcon = tone.icon

  return (
    <div
      data-block="card"
      data-tone={toneKey}
      className={`my-1.5 rounded-2xl border p-3.5 ${tone.container}`}
    >
      <div className="flex items-center gap-2.5">
        <div
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${tone.iconWrap}`}
        >
          <ToneIcon className={`h-4 w-4 ${tone.iconColor}`} />
        </div>
        <div className="text-sm font-semibold text-slate-800">{block.title}</div>
      </div>
      {block.bodyMarkdown && (
        <div className="mt-2">
          <MarkdownMessage
            content={block.bodyMarkdown}
            className="text-xs leading-relaxed text-slate-600"
          />
        </div>
      )}
      {block.fields && block.fields.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {block.fields.map((f, i) => (
            <div
              key={i}
              className="flex items-baseline gap-1.5 rounded-lg border border-white/70 bg-white/60 px-2 py-1"
            >
              <span className="text-[10px] uppercase tracking-wide text-slate-400">{f.label}</span>
              <span className="font-mono text-xs font-semibold text-slate-700">{f.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
