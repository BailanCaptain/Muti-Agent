"use client"

import { useA2ADrawerStore } from "@/components/stores/a2a-drawer-store"
import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"
import { useThreadStore } from "@/components/stores/thread-store"
import ReactMarkdown from "react-markdown"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import {
  type GetViewfinderResponse,
  type ViewfinderSegment,
  parseA2ARefs,
  useViewfinderData,
} from "./viewfinder/use-viewfinder-data"

/**
 * F027 Phase 3 Week 4 Day 16-17 (AC-P3-4) · ViewfinderTab 真实数据
 *
 * 真相源：
 *   - feature.md line 180 (AC-P3-4 viewfinder §4 a2a 状态人话化 V16.5.2)
 *   - V16.5 chap 11 line 1255-1294 (viewfinder 6 段 vision example)
 *   - V16.5 §18 line 1970-1973 (V16.5.2 a2a 引用用 F026 AtPill + in-place drawer)
 *   - GET /api/rooms/:id/viewfinder (Phase 3 Week 1 Day 3 done)
 *
 * 实施:
 *   - fetch viewfinder markdown (含 6 段 + a2a `[a2a_call=...]` 引用)
 *   - ReactMarkdown 渲染 + 自定义 paragraph 拦截 a2a 引用 → 内联 AtPillRef 组件
 *   - AtPillRef 简化版（不接 F026 复杂状态机 + drawer · Week 5 evaluate 是否升级到完整 <AtPill>）
 *   - Coverage warning footer + ledger cursor 元数据
 */
export function ViewfinderTab() {
  const activeGroup = useThreadStore((state) => state.activeGroup)
  const roomId = activeGroup?.roomId ?? null
  // 同 Day 14-15 r2 P2 pattern · 防 always-render 5 tabs 启动并发 fetch
  const activeLvl2 = useRuntimeLogStore((state) => state.activeLvl2)
  const { data, isLoading, error } = useViewfinderData(roomId, {
    enabled: activeLvl2 === "viewfinder",
  })

  return (
    <div className="flex flex-col gap-3 p-3 text-xs" data-testid="viewfinder-tab">
      <Header
        roomId={roomId}
        isLoading={isLoading}
        error={error}
        coverage={data.coverage}
        lastCompiledAt={data.lastCompiledAt}
        ledger={data.ledger}
      />
      <ViewfinderBody markdown={data.viewfinder} />
    </div>
  )
}

function Header({
  roomId,
  isLoading,
  error,
  coverage,
  lastCompiledAt,
  ledger,
}: {
  roomId: string | null
  isLoading: boolean
  error: string | null
  coverage: GetViewfinderResponse["coverage"]
  lastCompiledAt: string | null
  ledger: GetViewfinderResponse["ledger"]
}) {
  return (
    <div
      className="rounded border border-slate-200 bg-slate-50 px-3 py-2"
      data-testid="viewfinder-header"
    >
      <div className="text-[11px] font-semibold text-slate-700">{roomId ?? "—"} · viewfinder</div>
      <div className="mt-1 flex flex-wrap gap-3 text-[10px] text-slate-500">
        <span>
          coverage {coverage.coverage !== null ? `${Math.round(coverage.coverage * 100)}%` : "—"} (
          {coverage.resolved}/{coverage.broad})
        </span>
        <span className={coverageStatusClass(coverage.status)}>{coverage.status}</span>
        <span>
          ledger {ledger.activeCount} active · D-{ledger.latestDecisionId ?? "—"}
        </span>
        <span className="text-slate-400">编 @ {lastCompiledAt ?? "—"}</span>
      </div>
      {isLoading && (
        <div className="mt-1 text-[10px] text-slate-400" data-testid="viewfinder-loading">
          ⏳ 加载中…
        </div>
      )}
      {error && (
        <div className="mt-1 text-[10px] text-red-500" data-testid="viewfinder-error">
          ⚠ 加载失败：{error}
        </div>
      )}
    </div>
  )
}

function coverageStatusClass(status: "pass" | "warn" | "fail"): string {
  if (status === "pass") return "text-green-600"
  if (status === "warn") return "text-amber-600"
  return "text-red-500"
}

function ViewfinderBody({ markdown }: { markdown: string | null }) {
  if (markdown === null) {
    return (
      <div
        className="rounded border border-dashed border-slate-300 p-3 text-[10px] text-slate-400"
        data-testid="viewfinder-empty"
      >
        ⏳ viewfinder 尚未编译（RoomCompiler 5min tick 未跑 / 房间无消息）
      </div>
    )
  }
  return (
    <div className="viewfinder-markdown text-[11px] leading-relaxed" data-testid="viewfinder-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          // h2 是 6 段标题（## 1. 当前主题 等）— 加段落分隔视觉
          h2: ({ children }) => (
            <h2 className="mt-2 mb-1 border-slate-200 border-b pb-0.5 font-semibold text-[11px] text-slate-700">
              {children}
            </h2>
          ),
          h1: ({ children }) => (
            <h1 className="mb-2 text-[12px] font-bold text-slate-800">{children}</h1>
          ),
          p: ({ children }) => <p className="my-1 text-slate-600">{renderInline(children)}</p>,
          li: ({ children }) => <li className="my-0.5 text-slate-600">{renderInline(children)}</li>,
          code: ({ children }) => (
            <code className="rounded bg-slate-100 px-1 font-mono text-[10px]">{children}</code>
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
}

/**
 * 拦截 ReactMarkdown 渲染的 inline children, 把含 [a2a_call=...] 的 text node
 * split 成 AtPillRef + text segments。其他 inline 元素（strong / em / code）原样保留。
 */
function renderInline(children: React.ReactNode): React.ReactNode {
  if (typeof children === "string") {
    return renderSegments(parseA2ARefs(children))
  }
  if (Array.isArray(children)) {
    return children.map((child, i) => {
      if (typeof child === "string") {
        return <span key={`seg-${i}`}>{renderSegments(parseA2ARefs(child))}</span>
      }
      return child
    })
  }
  return children
}

function renderSegments(segments: ViewfinderSegment[]): React.ReactNode {
  return segments.map((seg, i) => {
    if (seg.kind === "text") {
      return <span key={`t-${i}`}>{seg.text}</span>
    }
    return <AtPillRef key={`a-${i}`} segment={seg} />
  })
}

/**
 * F027 Phase 3 Day 20 (AC-P3-4 完整) · a2a 引用 pill + click drawer
 * V16.5.2 line 1970-1973 拍 in-place drawer · 复用 F026 <A2ATreeView> +
 * 自己 fetch /debug/a2a?root=callId · 与 prompt-inspector wake-trigger pill 共用同一 drawer
 *
 * Day 16-17 简化版 (span) → Day 20 升级 button + click → openDrawer
 */
function AtPillRef({ segment }: { segment: ViewfinderSegment & { kind: "a2a" } }) {
  const openDrawer = useA2ADrawerStore((s) => s.openDrawer)
  const colorClass = statusToColorClass(segment.status)
  const tooltipParts: string[] = [
    `call=${segment.callId}`,
    `status=${segment.status}`,
    segment.deadline ? `deadline ${segment.deadline}` : null,
    segment.reason ? `reason "${segment.reason}"` : null,
    "click 打开调用树",
  ].filter((p): p is string => Boolean(p))
  const tooltip = tooltipParts.join(" · ")
  return (
    <button
      type="button"
      onClick={() => openDrawer(segment.callId, "viewfinder")}
      className={`mx-0.5 inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[9px] hover:brightness-95 ${colorClass}`}
      title={tooltip}
      data-testid={`viewfinder-a2a-ref-${segment.callId.slice(0, 13)}`}
      data-call-id={segment.callId}
      data-status={segment.status}
    >
      {segment.callId.slice(0, 13)}·{segment.status}
    </button>
  )
}

function statusToColorClass(status: string): string {
  switch (status) {
    case "pending":
    case "working":
      return "border-amber-300 bg-amber-50 text-amber-700"
    case "done":
      return "border-green-300 bg-green-50 text-green-700"
    case "failed":
    case "error":
      return "border-red-300 bg-red-50 text-red-600"
    case "timeout":
      return "border-orange-300 bg-orange-50 text-orange-700"
    case "cancelled":
      return "border-slate-300 bg-slate-50 text-slate-500"
    default:
      return "border-slate-300 bg-slate-50 text-slate-600"
  }
}
