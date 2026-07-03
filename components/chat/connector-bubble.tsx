"use client"

import type { TimelineMessage } from "@multi-agent/shared"
import { ChevronDown, ChevronRight, Plug, Users } from "lucide-react"
import { useState } from "react"
import { useThreadStore } from "../stores/thread-store"
import { bubbleTheme } from "../theme"
import { AtPill, deriveLiveAtPillStatus } from "./at-pill"
import { shouldRenderBubble } from "./display-mode-dispatcher"
import { getFoldableGroupClassName } from "./foldable-group"
import { MarkdownMessage } from "./markdown-message"
import { getMystAreaClassName } from "./myst-area"
import { OriginCapsule } from "./origin-capsule"
import { ProviderAvatar } from "./provider-avatar"
import { TimeoutTombstone } from "./timeout-tombstone"
import { getVisualSiloClassName } from "./visual-silo"

interface ConnectorBubbleProps {
  message: TimelineMessage
}

function formatClock(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

// F026 P5 R-107 fix · placeholder envelope 健壮性
// 历史脏数据 / 外部直写 sqlite 可能产生 envelope 字段是字面占位字符串
// （label="A2A ??" / fromAlias="???" / toAlias="??"）。仓库主路径不会产生这种数据，
// 但前端是渲染最后一道关：命中即不渲染（避免破碎 UX 顶到房间最上面）。
// 判定规则：label 含连续 "??" 或 fromAlias/toAlias trim 后整串都是 "?"。
const ALL_QUESTION_MARKS = /^\s*\?+\s*$/
function isPlaceholderConnectorEnvelope(
  source: TimelineMessage["connectorSource"],
): boolean {
  if (!source) return false
  if (typeof source.label === "string" && source.label.includes("??")) return true
  if (typeof source.fromAlias === "string" && ALL_QUESTION_MARKS.test(source.fromAlias)) {
    return true
  }
  if (typeof source.toAlias === "string" && ALL_QUESTION_MARKS.test(source.toAlias)) {
    return true
  }
  return false
}

/**
 * Renders a connector message — two visual modes by `a2aCallId`:
 *
 * 1. **a2a dispatch connector** (`a2aCallId` non-empty) — F026 P5 派发占位
 *    issuer thread 上的 「{convener} 正在征询 {target}」占位卡片。承载 F2/F3/F4/F5/F7/F8
 *    全部视觉原语（溯源胶囊 / 超时墓碑 / 折叠群组 / Visual Silo / 密谋区 / display_mode）。
 *    使用 provider bubbleTheme 简洁卡片，不复用 multi_mention 全宽样式。
 *
 * 2. **multi_mention aggregate** (`a2aCallId` 为空) — Phase 1/2 并行思考聚合
 *    走暖色 surface-canvas 全宽聚合样式（F036 restyle：原 indigo 渐变已去冷色）。
 */
export function ConnectorBubble({ message }: ConnectorBubbleProps) {
  // R-107 fix · placeholder envelope 不渲染（破碎数据兜底）
  if (isPlaceholderConnectorEnvelope(message.connectorSource)) return null

  const isA2aConnector = !!message.a2aCallId

  if (isA2aConnector) {
    return <A2aConnectorBubble message={message} />
  }

  return <MultiMentionConnectorBubble message={message} />
}

/* ── a2a 派发占位分支：F2/F3/F4/F5/F7/F8 全接入 ── */

function A2aConnectorBubble({ message }: ConnectorBubbleProps) {
  // F8 · display_mode=background → 不渲染气泡 (ADR-004 line 106 slash command)
  if (!shouldRenderBubble(message)) return null

  const source = message.connectorSource
  const label = source?.label ?? "A2A 协助"
  const fromAlias = source?.fromAlias
  const toAlias = source?.toAlias ?? message.alias
  const hasBody = message.content.trim().length > 0

  // F1 follow-up · message.a2aCallStatus 是 LEFT JOIN 写入 envelope 那一刻的快照；
  // 之后 a2a_calls.status 流转只走 pending.change → thread-store.pendingByRoot。
  // AtPill 改吃 deriveLiveAtPillStatus(msg, store) 拿实时态，settle 后 fallback 回 snapshot。
  //
  // F026 review#4 fix · 同时读 settledByRoot terminal cache：snapshot 是 envelope
  // 创建瞬间的冻结值，settle/timeout 后不重发 → 必须用 settledByRoot 才能让 AtPill
  // 进入 done/timeout/error 终态。
  const pendingByRoot = useThreadStore((state) => state.pendingByRoot)
  const settledByRoot = useThreadStore((state) => state.settledByRoot)
  const liveStatus = deriveLiveAtPillStatus(message, pendingByRoot, settledByRoot)

  // F4 折叠群组 (sub-call 缩进半透明) + F7 紫底 (sub-call 密谋区) — 都加在 outer wrap
  const outerClassName =
    `${getFoldableGroupClassName(message)} ${getMystAreaClassName(message)}`.trim()

  // F5 Visual Silo (display_mode=nested 加边框) — 叠加在 inner card 上
  const innerCardClassName =
    `overflow-hidden rounded-2xl border shadow-sm ${bubbleTheme[message.provider]} ${getVisualSiloClassName(message)}`.trim()

  return (
    <div className={outerClassName}>
      <div className={innerCardClassName} data-testid="connector-bubble-card">
        {/* F2 · 溯源胶囊 — on-behalf 派发链可见 */}
        <OriginCapsule message={message} />
        {/* F3 · 超时墓碑 — a2a_calls.status='timeout' 显眼提示 */}
        <TimeoutTombstone message={message} />

        {/* a2a connector header — 紧凑「派发占位」标识 + F1 AtPill 状态机 */}
        <div className="flex items-center gap-2 border-b border-slate-200/60 px-4 py-2 text-caption text-slate-500">
          <Plug className="h-3 w-3 text-slate-400" aria-hidden="true" />
          <ProviderAvatar identity={message.provider} size="xs" />
          <span className="font-semibold text-slate-700">{label}</span>
          {fromAlias && toAlias ? (
            <span className="truncate text-slate-500">
              · {fromAlias} → {toAlias}
            </span>
          ) : null}
          {/* F1 · @ pill 六态状态机：sending / ack / working / done / timeout / error */}
          <AtPill targetAlias={toAlias} status={liveStatus} />
          <span className="ml-auto shrink-0 text-micro text-slate-400">
            {formatClock(message.createdAt)}
          </span>
        </div>

        {/* Body 仅在有 content 时渲染（多数 a2a connector 是 header-only 占位） */}
        {hasBody ? (
          <div className="px-4 py-3 text-sm text-slate-700">
            <MarkdownMessage content={message.content} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

/* ── multi_mention 聚合气泡分支：F036 暖色 surface-canvas 全宽样式 ── */

function MultiMentionConnectorBubble({ message }: ConnectorBubbleProps) {
  const source = message.connectorSource
  const label = source?.label ?? "并行思考结果"
  const targets = source?.targets ?? []
  const initiator = source?.initiator
  const hasBody = message.content.trim().length > 0
  const collapsible = hasBody && label === "串行讨论记录"
  const [expanded, setExpanded] = useState(!collapsible)

  return (
    <div className="mb-6 flex w-full flex-col items-stretch">
      <div
        className={`mx-auto w-full max-w-[780px] rounded-floating border border-slate-200 bg-surface-canvas px-6 shadow-md ${
          hasBody ? "py-5" : "py-3"
        }`}
      >
        <header
          className={`flex flex-wrap items-center gap-3 ${
            expanded && hasBody ? "mb-4 border-b border-slate-200 pb-3" : ""
          } ${collapsible ? "cursor-pointer select-none" : ""}`}
          onClick={collapsible ? () => setExpanded((v) => !v) : undefined}
          role={collapsible ? "button" : undefined}
          tabIndex={collapsible ? 0 : undefined}
          onKeyDown={
            collapsible
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    setExpanded((v) => !v)
                  }
                }
              : undefined
          }
        >
          {collapsible ? (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
              {expanded ? (
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              )}
            </span>
          ) : (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
              <Users className="h-4 w-4" aria-hidden="true" />
            </span>
          )}
          <div className="flex flex-col">
            <span className="text-compact font-semibold tracking-wide text-slate-800">
              {label}
              {collapsible && !expanded ? (
                <span className="ml-2 text-caption font-normal text-slate-500">
                  （点击展开）
                </span>
              ) : null}
            </span>
            <span className="text-micro text-slate-500">{formatClock(message.createdAt)}</span>
          </div>

          {targets.length > 0 ? (
            <div className="ml-auto flex items-center gap-2">
              {initiator ? (
                <div className="flex items-center gap-1.5 border-r border-slate-200 pr-2">
                  <span className="text-micro text-slate-500">发起：</span>
                  <ProviderAvatar identity={initiator} size="xs" />
                </div>
              ) : null}
              <span className="text-micro text-slate-500">参与：</span>
              <div className="flex -space-x-1.5">
                {targets.map((provider) => (
                  <ProviderAvatar key={provider} identity={provider} size="xs" />
                ))}
              </div>
            </div>
          ) : null}
        </header>

        {expanded && hasBody ? <MarkdownMessage content={message.content} /> : null}
      </div>
    </div>
  )
}
