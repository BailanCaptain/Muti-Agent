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

// 对齐 decision-card 的视觉语言（F036 restyle）：圆角全框 + 扁平实底 + elevation-1 阴影 + tone 图标。
// 去渐变 / 去带色辉光阴影；info 默认态走暖金 accent，语义三态（成功/警告/危险）保留 hue。
const TONE_STYLES: Record<string, ToneStyle> = {
  info: {
    container: "border-accent-200 bg-accent-50 shadow-sm",
    iconWrap: "bg-accent-100",
    iconColor: "text-accent-600",
    icon: Info,
  },
  success: {
    container: "border-emerald-200 bg-emerald-50 shadow-sm",
    iconWrap: "bg-emerald-100",
    iconColor: "text-emerald-600",
    icon: CheckCircle2,
  },
  warning: {
    container: "border-amber-200 bg-amber-50 shadow-sm",
    iconWrap: "bg-amber-100",
    iconColor: "text-amber-600",
    icon: AlertTriangle,
  },
  danger: {
    container: "border-rose-200 bg-rose-50 shadow-sm",
    iconWrap: "bg-rose-100",
    iconColor: "text-rose-600",
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
              className="flex items-baseline gap-1.5 rounded-lg border border-slate-200 bg-surface-canvas px-2 py-1"
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
