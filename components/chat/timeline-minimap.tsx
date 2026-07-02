"use client"

// F036 #9 长会话导航 = 形态 D「滚动条标记 / 迷你地图」（小孙四形态里选 D）。
// 右边缘竖轨投影三类锚点：🔵你的提问 / 🟠决策 / 🔴封存，hover 出摘要、click 跳。
//
// 定位用「序位」index/(count-1) 而非像素 offset：时间线是 @tanstack/react-virtual
// 虚拟化的，off-screen 项用 estimateSize 估算、滚动到才测真高 —— 若按像素投影，标记会
// 随滚动“漂移”（估算→真值跳变），导航场景里反而晕。序位投影稳定、保留正确顺序、零内部
// API 依赖；代价是超长消息与短消息等距，对“跳到第 N 条提问”的导航诉求完全够用。

// 只标**持久**锚点：🔵你的提问 / 🔴封存。决策不打标——见 buildMinimapMarkers 注释（范德彪-r P1）。
export type MinimapMarkerKind = "user" | "seal"

export type MinimapMarker = {
  /** renderItems 下标 —— 交给 virtualizer.scrollToIndex */
  index: number
  kind: MinimapMarkerKind
  /** hover tooltip 文案（已截断） */
  label: string
  /** 0~1，轨道内纵向位置 */
  topPct: number
}

const KIND_STYLE: Record<MinimapMarkerKind, { dot: string; ring: string }> = {
  // accent/surface 是 var(oklch)，opacity 修饰符在 Tailwind v3.4 会被静默忽略 → 只用实色，不加 /opacity
  user: { dot: "bg-sky-500", ring: "ring-sky-300" },
  seal: { dot: "bg-rose-500", ring: "ring-rose-300" },
}

// F036 #9 锚点构建（纯函数，可单测）。
// 范德彪-r P1：**不**给决策打标——decision-store 是 pending-only（响应即从 pending 删、刷新也只拉
// pending），已答决策根本不在 timeline 的 renderItems 里，打标会“响应后消失”。只标持久锚点：
// 🔵你的提问（role=user）/ 🔴封存（messageType=system_notice）。已答决策的导航经其 user 响应消息
// （user 标记）达成；assistant 普通消息不打标。
export type MinimapItem =
  | { kind: "message"; role: "user" | "assistant"; messageType: string; alias: string; content: string }
  | { kind: "decision" }

export function buildMinimapMarkers(
  items: MinimapItem[],
  summarize: (content: string) => string,
): MinimapMarker[] {
  const denom = Math.max(1, items.length - 1)
  const out: MinimapMarker[] = []
  items.forEach((item, index) => {
    if (item.kind !== "message") return
    const topPct = index / denom
    if (item.messageType === "system_notice") {
      out.push({ index, kind: "seal", label: `封存 · ${item.alias}`, topPct })
    } else if (item.role === "user") {
      out.push({ index, kind: "user", label: `你 · ${summarize(item.content)}`, topPct })
    }
  })
  return out
}

export function TimelineMinimap({
  markers,
  onJump,
}: {
  markers: MinimapMarker[]
  onJump: (index: number) => void
}) {
  if (markers.length === 0) return null
  return (
    <nav
      aria-label="会话导航标记"
      data-testid="timeline-minimap"
      // pointer-events-none：轨道本体不挡聊天区点击，只有标记按钮 pointer-events-auto 接管。
      // 窄屏(md 以下)隐藏，避免压到气泡。
      className="pointer-events-none absolute right-1 top-4 bottom-4 z-30 hidden w-4 md:block"
    >
      <div className="relative h-full w-full">
        {markers.map((mk) => {
          const style = KIND_STYLE[mk.kind]
          return (
            <button
              key={`${mk.kind}-${mk.index}`}
              type="button"
              onClick={() => onJump(mk.index)}
              aria-label={mk.label}
              data-kind={mk.kind}
              data-index={mk.index}
              className={`group pointer-events-auto absolute right-0.5 h-2.5 w-2.5 -translate-y-1/2 rounded-full border-2 border-surface-elevated shadow-sm transition-transform hover:scale-150 hover:ring-2 ${style.dot} ${style.ring}`}
              style={{ top: `${Math.min(100, Math.max(0, mk.topPct * 100))}%` }}
            >
              <span className="pointer-events-none absolute right-full top-1/2 mr-2 hidden max-w-[260px] -translate-y-1/2 truncate rounded-field border border-slate-200 bg-surface-canvas px-2 py-1 text-[11px] text-slate-700 shadow-md group-hover:block">
                {mk.label}
              </span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
