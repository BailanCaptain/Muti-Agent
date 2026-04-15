"use client"

import { ChevronDown } from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"

interface CollapsibleBlockProps {
  title: string
  icon?: ReactNode
  accentColor?: string
  defaultOpen?: boolean
  isStreaming?: boolean
  badge?: ReactNode
  children: ReactNode
}

export function CollapsibleBlock({
  title,
  icon,
  accentColor = "#94A3B8",
  defaultOpen = false,
  isStreaming = false,
  badge,
  children,
}: CollapsibleBlockProps) {
  const [open, setOpen] = useState(defaultOpen || isStreaming)
  const userInteracted = useRef(false)
  const prevStreaming = useRef(isStreaming)

  useEffect(() => {
    if (isStreaming && !open) {
      setOpen(true)
    }
    if (prevStreaming.current && !isStreaming && !userInteracted.current) {
      setOpen(false)
    }
    prevStreaming.current = isStreaming
  }, [isStreaming, open])

  return (
    <div
      className="overflow-hidden rounded-xl border border-slate-200/70 bg-slate-50/60"
      style={{ borderLeftWidth: 3, borderLeftColor: accentColor }}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100/60"
        onClick={() => {
          userInteracted.current = true
          setOpen((v) => !v)
        }}
      >
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
        />
        {icon && <span className="shrink-0">{icon}</span>}
        <span className="truncate">{title}</span>
        {badge && <span className="ml-auto shrink-0">{badge}</span>}
      </button>
      {open && (
        <div className="border-t border-slate-200/60 px-3 py-2">
          {children}
        </div>
      )}
    </div>
  )
}
