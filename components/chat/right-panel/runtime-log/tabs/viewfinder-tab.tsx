"use client"

import { useA2ADrawerStore } from "@/components/stores/a2a-drawer-store"
import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"
import { useThreadStore } from "@/components/stores/thread-store"
import { getApiHttpBaseUrl } from "@/lib/api-endpoints"
import { AlertTriangle, ClipboardList, Hourglass } from "lucide-react"
import { useState } from "react"
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
 *
 * F027 P4 hotfix（小孙浏览器实测拍）:
 *   - 加「重新编译」按钮 → POST /api/rooms/:id/viewfinder/recompile
 *   - 加「刷新」按钮 → refetch endpoint
 *   - 字体统一到 text-xs (12px), 去掉 text-[10/11px] 混杂
 *   - 中文化 (coverage/ledger/active/pass-warn-fail/viewfinder 等英文 label)
 */
export function ViewfinderTab() {
  const activeGroup = useThreadStore((state) => state.activeGroup)
  const roomId = activeGroup?.roomId ?? null
  const activeLvl2 = useRuntimeLogStore((state) => state.activeLvl2)
  const { data, isLoading, error, refetch } = useViewfinderData(roomId, {
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
        onRefresh={refetch}
      />
      {/* F027 v3 G9 · frontmatter 字段说明 panel (V16.5 chap 11 line 1255 viewfinder_id/generated_at/inputs/coverage 字段语义) */}
      <ViewfinderFrontmatterPanel markdown={data.viewfinder} />
      <ViewfinderBody markdown={data.viewfinder} roomId={roomId} />
    </div>
  )
}

// ─── F027 v3 G9 · ViewfinderFrontmatterPanel ──────────────────────────

const FRONTMATTER_RE_INLINE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/

/** 字段语义说明 (V16.5 chap 11 line 1255-1294) — 每字段 hover tooltip 来源 */
const FRONTMATTER_FIELD_HELP: Record<string, string> = {
  viewfinder_id:
    "本 viewfinder 唯一标识 (vf_<roomId>_<时间戳>); MonthlySnapshot drift 比对用",
  generated_at: "本 viewfinder 编译时刻 (ISO 时间)",
  generated_by:
    "编译方式: rule-based-template (6 段全 SQL 拼, V16.5 chap 11 设计层固定单路径, 不调 LLM)",
  inputs:
    "本次编译的输入: last_committed_cursor (消息 cursor) / decision_ledger_count / coverage 百分比",
  coverage_status:
    "覆盖度状态: pass=所有候选决策入 ledger / warn=部分 unresolved / fail=无 ledger 或全 unresolved",
  coverage_reason: "coverage_status != pass 时给出原因 (extractor LLM 判定模糊或漏抓)",
}

function ViewfinderFrontmatterPanel({ markdown }: { markdown: string | null }) {
  if (!markdown) return null
  const m = markdown.match(FRONTMATTER_RE_INLINE)
  if (!m) return null
  const yamlBody = m[1]
  // 简单 line 解析 (key: value, 不嵌套 inputs 子结构): 不重新发明 yaml parser
  const lines = yamlBody.split(/\r?\n/)
  const fields: Array<{ key: string; value: string; help?: string }> = []
  for (const line of lines) {
    // G9 r2 (codex P2 修): nested 子字段 skip 必须判 raw line 缩进 (在 trim 之前),
    // 否则 `inputs.last_committed_cursor` 等 `  key: value` 缩进行被当 top-level 字段
    // 多列出"字段说明缺"。
    if (/^\s+/.test(line)) continue
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const colon = trimmed.indexOf(":")
    if (colon < 1) continue
    const key = trimmed.slice(0, colon).trim()
    const value = trimmed.slice(colon + 1).trim()
    fields.push({ key, value, help: FRONTMATTER_FIELD_HELP[key] })
  }
  if (fields.length === 0) return null
  return (
    <section
      className="rounded border border-slate-200 bg-slate-50 p-2 text-xs"
      data-testid="viewfinder-frontmatter-panel"
    >
      <div className="mb-1 flex items-center justify-between text-micro uppercase tracking-wider text-slate-500">
        <span className="inline-flex items-center gap-1">
          <ClipboardList className="h-3 w-3 shrink-0" aria-hidden="true" />
          取景器 frontmatter 字段说明
        </span>
        <span className="normal-case text-slate-400">
          (V16.5 chap 11 · hover 字段名看说明)
        </span>
      </div>
      <ul className="space-y-0.5 text-micro">
        {fields.map((f) => (
          <li key={f.key} className="flex gap-2" data-testid={`viewfinder-fm-${f.key}`}>
            <span
              className="min-w-[110px] cursor-help font-mono font-semibold text-slate-700 underline decoration-dotted"
              title={f.help ?? "字段说明缺 (V16.5 chap 11 未列)"}
            >
              {f.key}
            </span>
            <span className="font-mono text-slate-600">{f.value || "—"}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Header({
  roomId,
  isLoading,
  error,
  coverage,
  lastCompiledAt,
  ledger,
  onRefresh,
}: {
  roomId: string | null
  isLoading: boolean
  error: string | null
  coverage: GetViewfinderResponse["coverage"]
  lastCompiledAt: string | null
  ledger: GetViewfinderResponse["ledger"]
  onRefresh: () => void
}) {
  const [recompiling, setRecompiling] = useState(false)
  const [recompileMsg, setRecompileMsg] = useState<string | null>(null)

  const apiBase = getApiHttpBaseUrl()

  const handleRecompile = async (force: boolean) => {
    if (!roomId) {
      setRecompileMsg("未选择房间")
      return
    }
    setRecompiling(true)
    setRecompileMsg(null)
    try {
      const res = await fetch(
        `${apiBase}/api/rooms/${encodeURIComponent(roomId)}/viewfinder/recompile`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force }),
        },
      )
      const json = (await res.json()) as {
        ok: boolean
        status?: string
        newMessagesCount?: number
        error?: string
      }
      if (!res.ok || !json.ok) {
        setRecompileMsg(`编译失败：${json.error ?? `HTTP ${res.status}`}`)
      } else if (json.status === "skipped_no_messages") {
        setRecompileMsg("本房间无新消息（已是最新）")
      } else {
        setRecompileMsg(`编译完成（${json.newMessagesCount} 条消息）`)
        // 编完后 refetch viewfinder body
        onRefresh()
      }
    } catch (err) {
      setRecompileMsg(`编译失败：${(err as Error).message}`)
    } finally {
      setRecompiling(false)
      // 3 秒后清提示
      setTimeout(() => setRecompileMsg(null), 3000)
    }
  }

  return (
    <div
      className="rounded border border-slate-200 bg-slate-50 px-3 py-2"
      data-testid="viewfinder-header"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-slate-700">
          {roomId ?? "—"} · 取景器
        </div>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading || !roomId}
            className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-600 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            title="重新获取取景器内容"
            data-testid="viewfinder-refresh-btn"
          >
            刷新
          </button>
          <button
            type="button"
            onClick={() => handleRecompile(false)}
            disabled={recompiling || !roomId}
            className="rounded border border-blue-300 bg-blue-50 px-2 py-0.5 text-xs text-blue-700 transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
            title="按 cursor 增量编译（仅编新消息）"
            data-testid="viewfinder-recompile-btn"
          >
            {recompiling ? "编译中…" : "增量编译"}
          </button>
          <button
            type="button"
            onClick={() => handleRecompile(true)}
            disabled={recompiling || !roomId}
            className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-700 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
            title="重跑该房间过去 200 条消息（清 cursor 重新编）"
            data-testid="viewfinder-recompile-force-btn"
          >
            {recompiling ? "编译中…" : "强制重编"}
          </button>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-500">
        <span>
          覆盖率 {coverage.coverage !== null ? `${Math.round(coverage.coverage * 100)}%` : "—"} （
          {coverage.resolved}/{coverage.broad}）
        </span>
        <span className={coverageStatusClass(coverage.status)}>
          {coverageStatusLabel(coverage.status)}
        </span>
        <span>
          决策账本 {ledger.activeCount} 条进行中 · 最新 D-{ledger.latestDecisionId ?? "—"}
        </span>
        <span className="text-slate-400">编于 {formatTime(lastCompiledAt)}</span>
      </div>
      {isLoading && (
        <div
          className="mt-1 flex items-center gap-1 text-xs text-slate-400"
          data-testid="viewfinder-loading"
        >
          <Hourglass className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          加载中…
        </div>
      )}
      {error && (
        <div
          className="mt-1 flex items-start gap-1 text-xs text-red-500"
          data-testid="viewfinder-error"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>加载失败：{error}</span>
        </div>
      )}
      {recompileMsg && (
        <div className="mt-1 text-xs text-blue-600" data-testid="viewfinder-recompile-msg">
          {recompileMsg}
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

function coverageStatusLabel(status: "pass" | "warn" | "fail"): string {
  if (status === "pass") return "通过"
  if (status === "warn") return "警告"
  return "失败"
}

function formatTime(iso: string | null): string {
  if (!iso) return "—"
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    // 本地时间，去秒
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return iso
  }
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function ViewfinderBody({
  markdown,
  roomId,
}: {
  markdown: string | null
  roomId: string | null
}) {
  if (!roomId) {
    return (
      <div
        className="rounded border border-dashed border-slate-300 p-3 text-xs text-slate-400"
        data-testid="viewfinder-empty"
      >
        请先在左侧选择一个房间
      </div>
    )
  }
  if (markdown === null) {
    return (
      <div
        className="rounded border border-dashed border-slate-300 p-3 text-xs text-slate-400"
        data-testid="viewfinder-empty"
      >
        本房间尚未编译取景器。点击上方「增量编译」或「强制重编」立即触发；调度器每 5 分钟自动 tick 一次。
      </div>
    )
  }
  return (
    <div className="viewfinder-markdown text-xs leading-relaxed" data-testid="viewfinder-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          h2: ({ children }) => (
            <h2 className="mt-2 mb-1 border-slate-200 border-b pb-0.5 text-xs font-semibold text-slate-700">
              {children}
            </h2>
          ),
          h1: ({ children }) => (
            <h1 className="mb-2 text-sm font-bold text-slate-800">{children}</h1>
          ),
          p: ({ children }) => <p className="my-1 text-slate-600">{renderInline(children)}</p>,
          li: ({ children }) => <li className="my-0.5 text-slate-600">{renderInline(children)}</li>,
          code: ({ children }) => (
            <code className="rounded bg-slate-100 px-1 font-mono text-xs">{children}</code>
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

function AtPillRef({ segment }: { segment: ViewfinderSegment & { kind: "a2a" } }) {
  const openDrawer = useA2ADrawerStore((s) => s.openDrawer)
  const colorClass = statusToColorClass(segment.status)
  const statusZh = statusToChinese(segment.status)
  const tooltipParts: string[] = [
    `调用 ${segment.callId}`,
    `状态：${statusZh}`,
    segment.deadline ? `截止 ${segment.deadline}` : null,
    segment.reason ? `原因 "${segment.reason}"` : null,
    "点击查看调用树",
  ].filter((p): p is string => Boolean(p))
  const tooltip = tooltipParts.join(" · ")
  return (
    <button
      type="button"
      onClick={() => openDrawer(segment.callId, "viewfinder")}
      className={`mx-0.5 inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-xs hover:brightness-95 ${colorClass}`}
      title={tooltip}
      data-testid={`viewfinder-a2a-ref-${segment.callId.slice(0, 13)}`}
      data-call-id={segment.callId}
      data-status={segment.status}
    >
      {segment.callId.slice(0, 13)}·{statusZh}
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

function statusToChinese(status: string): string {
  switch (status) {
    case "pending":
      return "等待"
    case "working":
      return "进行中"
    case "done":
      return "完成"
    case "failed":
      return "失败"
    case "error":
      return "错误"
    case "timeout":
      return "超时"
    case "cancelled":
      return "已取消"
    default:
      return status
  }
}
