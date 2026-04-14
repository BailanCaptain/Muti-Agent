"use client"

import type { Provider, ToolEvent } from "@multi-agent/shared"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { MarkdownMessage } from "../markdown-message"
import { pairToolEvents, deriveCliStatus, type PairedTool, type CliStatus } from "./toCliEvents"

/* ── Color helpers (ported from clowder-ai) ── */

function tintedDark(hex: string, ratio = 0.25, base = "#1A1625"): string {
  const parse = (h: string) => [
    Number.parseInt(h.slice(1, 3), 16),
    Number.parseInt(h.slice(3, 5), 16),
    Number.parseInt(h.slice(5, 7), 16),
  ]
  const [r1, g1, b1] = parse(hex)
  const [r2, g2, b2] = parse(base)
  return `rgb(${Math.round(r2 + (r1 - r2) * ratio)}, ${Math.round(g2 + (g1 - g2) * ratio)}, ${Math.round(b2 + (b1 - b2) * ratio)})`
}

function lighten(hex: string, ratio: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  return `rgb(${Math.round(r + (255 - r) * ratio)}, ${Math.round(g + (255 - g) * ratio)}, ${Math.round(b + (255 - b) * ratio)})`
}

function hexToRgba(hex: string, opacity: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${opacity})`
}

const DIVIDER = "#334155"

const PROVIDER_ACCENT: Record<Provider, string> = {
  claude: "#7C3AED",
  codex: "#D97706",
  gemini: "#0EA5E9",
}

/* ── Inline SVG icons ── */

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="transition-transform duration-150 flex-shrink-0"
      style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

function WrenchIcon({ color }: { color?: string }) {
  return (
    <svg
      aria-hidden="true"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color || "#E2E8F0"}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#22D3EE"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function ErrorIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#EF4444"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function PawPrint() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#64748B"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0"
    >
      <circle cx="11" cy="4" r="2" />
      <circle cx="18" cy="8" r="2" />
      <circle cx="20" cy="16" r="2" />
      <path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z" />
    </svg>
  )
}

function LoaderIcon({ color }: { color?: string }) {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color || "currentColor"}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0 animate-spin"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

/* ── Status helpers ── */

const STATUS_LABEL: Record<CliStatus, string> = {
  streaming: "streaming",
  done: "done",
  failed: "failed",
}

function formatDuration(startMs: number, endMs: number): string {
  const s = Math.round((endMs - startMs) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem > 0 ? `${m}m${rem}s` : `${m}m`
}

function buildSummary(tools: PairedTool[], status: CliStatus): string {
  const count = tools.length
  const statusLabel = STATUS_LABEL[status]

  if (status === "streaming") {
    const last = [...tools].reverse().find((t) => t.status === "active")
    return last ? `CLI Output · ${statusLabel} · ${last.label}...` : `CLI Output · ${statusLabel}`
  }

  const timestamps = tools.map((t) => new Date(t.timestamp).getTime()).filter((t) => t > 0)
  const duration =
    timestamps.length >= 2
      ? ` · ${formatDuration(Math.min(...timestamps), Math.max(...timestamps))}`
      : ""

  return `CLI Output · ${statusLabel} · ${count} tool${count > 1 ? "s" : ""}${duration}`
}

/* ── L3: Individual tool row ── */

function ToolRow({
  tool,
  isActive,
  onUserInteract,
  accent,
}: {
  tool: PairedTool
  isActive: boolean
  onUserInteract: () => void
  accent: string
}) {
  const [rowExpanded, setRowExpanded] = useState(false)
  const accentLight = lighten(accent, 0.6)
  const accentVeryLight = lighten(accent, 0.9)
  const hasDetail = !!(tool.toolInput || tool.resultContent)

  const namePart = tool.label.split(" ")[0]
  const argPart = tool.label.includes(" ") ? tool.label.split(" ").slice(1).join(" ") : ""

  return (
    <div>
      <button
        type="button"
        className="w-full text-left cursor-pointer font-mono text-[11px] flex items-center gap-2"
        style={{
          padding: "5px 8px",
          borderRadius: 4,
          backgroundColor: isActive ? hexToRgba(accent, 0.2) : undefined,
          borderLeft: isActive ? `2px solid ${accent}` : undefined,
        }}
        onClick={() => {
          setRowExpanded((v) => !v)
          onUserInteract()
        }}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {tool.status === "active" ? (
            <LoaderIcon color={accentLight} />
          ) : tool.status === "error" ? (
            <ErrorIcon />
          ) : (
            <CheckIcon />
          )}
          <WrenchIcon color={isActive ? accentVeryLight : "#E2E8F0"} />
          <span className="truncate" style={{ color: isActive ? accentVeryLight : "#E2E8F0" }}>
            <span className="font-medium">{namePart}</span>
            {argPart && (
              <span style={{ color: isActive ? accentLight : "#64748B" }}>{` ${argPart}`}</span>
            )}
          </span>
        </div>
        {hasDetail && <ChevronIcon expanded={rowExpanded} />}
      </button>
      {rowExpanded && hasDetail && (
        <div
          className="pl-[30px] pr-2 pb-1 whitespace-pre-wrap font-mono text-[10px]"
          style={{ color: "#64748B" }}
        >
          {tool.toolInput && <div>{tool.toolInput}</div>}
          {tool.resultContent && (
            <div style={{ color: "#94A3B8", marginTop: 2 }}>{tool.resultContent}</div>
          )}
        </div>
      )}
    </div>
  )
}

/* ── L2: Tools section (collapsible list) ── */

function ToolsSection({
  tools,
  status,
  onUserInteract,
  accent,
}: {
  tools: PairedTool[]
  status: CliStatus
  onUserInteract: () => void
  accent: string
}) {
  const isStreaming = status === "streaming"
  const [toolsExpanded, setToolsExpanded] = useState(isStreaming)
  const toolsUserInteracted = useRef(false)
  const prevStatus = useRef(status)

  useEffect(() => {
    if (prevStatus.current === "streaming" && !isStreaming && !toolsUserInteracted.current) {
      setToolsExpanded(false)
    }
    prevStatus.current = status
  }, [status, isStreaming])

  if (isStreaming && !toolsExpanded) {
    setToolsExpanded(true)
  }

  const lastActiveTool = isStreaming
    ? [...tools].reverse().find((t) => t.status === "active")
    : undefined

  const toolSummary = `${tools.length} tool${tools.length > 1 ? "s" : ""}`

  return (
    <div style={{ padding: "4px 12px" }}>
      <button
        type="button"
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-mono rounded transition-colors"
        style={{ color: "#94A3B8" }}
        onClick={() => {
          toolsUserInteracted.current = true
          setToolsExpanded((v) => !v)
          onUserInteract()
        }}
      >
        <ChevronIcon expanded={toolsExpanded} />
        <span>{toolsExpanded ? toolSummary : `${toolSummary} (collapsed)`}</span>
      </button>
      {toolsExpanded && (
        <div className="space-y-0.5">
          {tools.map((tool) => (
            <ToolRow
              key={tool.id}
              tool={tool}
              isActive={tool.id === lastActiveTool?.id}
              onUserInteract={() => {
                toolsUserInteracted.current = true
                onUserInteract()
              }}
              accent={accent}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/* ── L1: Main CliOutputBlock ── */

interface CliOutputBlockProps {
  toolEvents: ToolEvent[]
  provider: Provider
  isStreaming?: boolean
  content?: string
}

export function CliOutputBlock({ toolEvents, provider, isStreaming: isStreamingProp, content }: CliOutputBlockProps) {
  const tools = pairToolEvents(toolEvents)
  const status: CliStatus = isStreamingProp ? "streaming" : deriveCliStatus(toolEvents)
  const accent = PROVIDER_ACCENT[provider]
  const surface = tintedDark(accent, 0.25)
  const surfaceInner = tintedDark(accent, 0.18)

  const forceExpanded = status === "streaming"
  const [expanded, setExpanded] = useState(forceExpanded)
  const userInteracted = useRef(false)
  const prevStatusRef = useRef(status)
  const hasMounted = useRef(false)

  if (forceExpanded && !expanded) {
    setExpanded(true)
  }

  useEffect(() => {
    if (
      prevStatusRef.current === "streaming" &&
      status !== "streaming" &&
      !userInteracted.current
    ) {
      setExpanded(false)
    }
    prevStatusRef.current = status
  }, [status])

  useLayoutEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true
      return
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("chat-layout-changed"))
    }
  }, [expanded])

  if (tools.length === 0) return null

  const summary = buildSummary(tools, status)
  const hasContent = content && content.trim().length > 0

  return (
    <div
      className="mt-2 mb-3 overflow-hidden"
      style={{ backgroundColor: surface, borderRadius: 10 }}
    >
      {/* L1: Header */}
      <button
        type="button"
        data-testid="cli-output-header"
        onClick={() => {
          userInteracted.current = true
          setExpanded((v) => !v)
        }}
        className="w-full flex items-center gap-2 text-[11px] font-mono transition-colors"
        style={{ padding: "8px 12px", color: "#94A3B8", backgroundColor: surface }}
      >
        <span style={{ color: accent }}>
          <ChevronIcon expanded={expanded} />
        </span>
        <span className="font-medium">{summary}</span>
        <span
          className="ml-auto flex items-center gap-1"
          style={{ color: "#64748B", fontSize: 10 }}
        >
          <PawPrint />
        </span>
      </button>

      {/* L1: Body */}
      {expanded && (
        <div data-testid="cli-output-body" style={{ backgroundColor: surfaceInner }}>
          <div style={{ height: 1, backgroundColor: DIVIDER }} />
          <ToolsSection
            tools={tools}
            status={status}
            onUserInteract={() => {
              userInteracted.current = true
            }}
            accent={accent}
          />
          {hasContent && (
            <>
              <div style={{ height: 1, backgroundColor: DIVIDER }} />
              <div
                style={{
                  padding: "8px 12px 4px 12px",
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 10,
                  color: "#475569",
                }}
              >
                ─── stdout ───
              </div>
              <div
                style={{ padding: "8px 12px 10px 12px" }}
                className="font-mono text-[11px] leading-relaxed"
              >
                <span style={{ color: "#CBD5E1" }}>
                  <MarkdownMessage className="text-[12px] leading-relaxed [&_p]:text-slate-300 [&_code]:bg-slate-800/50 [&_pre]:bg-slate-900/60 [&_a]:text-sky-400 [&_strong]:text-slate-200 [&_h1]:text-slate-200 [&_h2]:text-slate-200 [&_h3]:text-slate-200 [&_li]:text-slate-300 [&_blockquote]:border-slate-600 [&_blockquote]:text-slate-400 [&_hr]:border-slate-700 [&_table]:text-slate-300 [&_th]:text-slate-200 [&_td]:border-slate-700 [&_th]:border-slate-700" content={content} />
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
