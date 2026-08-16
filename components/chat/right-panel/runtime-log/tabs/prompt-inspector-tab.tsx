"use client"

import { useA2ADrawerStore } from "@/components/stores/a2a-drawer-store"
import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"
import { useThreadStore } from "@/components/stores/thread-store"
import { useWakeTriggerStore } from "@/components/stores/wake-trigger-store"
import { getApiHttpBaseUrl } from "@/lib/api-endpoints"
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Bot,
  Check,
  CheckCircle2,
  Handshake,
  Hourglass,
  Search,
  Shield,
  XCircle,
} from "lucide-react"
import { useEffect, useState } from "react"
import { DecisionSupersedeRejectModal } from "../decision-supersede-reject-modal/decision-supersede-reject-modal"
import {
  type DecisionRef,
  type GetCoverageResponse,
  useDecisionsCoverageData,
} from "./prompt-inspector/use-decisions-coverage-data"
import {
  type GetPromptInspectorResponse,
  type InjectedPart,
  type NotInjectedPart,
  type RecallGate,
  usePromptInspectorData,
} from "./prompt-inspector/use-prompt-inspector-data"

/**
 * F027 Phase 3 Week 4 Day 14-15 (AC-P3-3 + AC-P3-5) +
 * F027 Phase 4 Week 3 Day 13 (AC-P4-9 c) · PromptInspectorTab 8 块真实数据
 *
 * 真相源：
 *   - V16.5 chap 18 line 2030-2079 (7 块原文 mockup)
 *   - V16.5 chap 11 line 1238-1247 (Decision Coverage Check)
 *   - feature.md line 179 (AC-P3-3 透明显示)
 *   - feature.md line 181 (AC-P3-5 顶部 wake-up 触发因 V16.5.2)
 *   - F027-phase4-implementation-plan.md AC-P4-9 c (第 8 块 Coverage section)
 *
 * 8 块按 chap 18 顺序:
 *   1. 标题行
 *   2. ✅ 注入的 part 表
 *   3. ❌ 未注入预期 part
 *   4. 🤖 自动召回
 *   5. 📊 Adaptive Recall Policy
 *   6. 🤝 当前 agent session
 *   7. 🔔 wake-up 触发因
 *   8. 🛡️ Decision Coverage (Day 13 AC-P4-9 c · 第 8 块)
 *   底部 4 按钮 [查看 raw text] [对比上一次注入] [追溯 wiki_events] [复制全文]
 *
 * Day 13 Coverage section 范围:
 *   - 读 GET /api/rooms/:id/decisions/coverage (Phase 3 Day 6 done)
 *   - 显示 coverage 标量 + pass/warn/fail badge + unresolved 列表
 *   - 每个 unresolved item 加 click 按钮 → 弹 DecisionSupersedeRejectModal
 *
 * final-vision P1-1 (2026-05-27): UnresolvedRow click 从 window.alert 占位 → 接真
 *   DecisionSupersedeRejectModal (POST /api/rooms/:id/decisions w/ supersedesDecisionId,
 *   后端 P3 Day 6 已实施)。原 F028 推后顾虑 (DecisionRef 无 srcDraftPath) 解除 — 此处
 *   是 decision ledger 状态机覆盖, 跟 PromoteModal (draft→wiki 升级 + V14 二次审计) 不同
 *   工作流, 新独立 modal.
 */
/**
 * final-vision P1-1: callerAlias 来源
 * （同 knowledge-base-tab.tsx / draft-approval-tab.tsx pattern — Phase 4 未拍 user session）
 */
function getCurrentUserAlias(): string {
  return process.env.NEXT_PUBLIC_USER_ALIAS ?? "小孙"
}

export function PromptInspectorTab() {
  const activeGroup = useThreadStore((state) => state.activeGroup)
  const roomId = activeGroup?.roomId ?? null
  // r2 范-r1 P2: 只在 prompt-inspector tab 真 active 时才 fetch
  // (Day 12-13 r2 always-render 5 tabs，无 enabled flag 会让 5 tab 启动同时 fetch)
  const activeLvl2 = useRuntimeLogStore((state) => state.activeLvl2)
  const enabled = activeLvl2 === "prompt-inspector"
  // F027 v3 G4 · alias dropdown 选中状态 (多 agent room 切换 per-agent prompt)
  // null = 不限 alias (取最新 row, 与 v3 前行为兼容)
  const [selectedAlias, setSelectedAlias] = useState<string | null>(null)
  // F027 v3 G4 r2 (codex P2 修): roomId 变化 → 清掉跨 room stale alias，避免拿旧 room
  // 的 alias 去查新 room (新 room 没这个 alias → 永空 audit)
  useEffect(() => {
    setSelectedAlias(null)
  }, [roomId])
  const { data, isLoading, error } = usePromptInspectorData(roomId, {
    enabled,
    alias: selectedAlias,
  })
  // F027 v3 G4 r2 (codex P2 修): selectedAlias 不在 availableAliases 里 → 清掉
  // (例: room 内 audit 行 alias 被 demote/删，dropdown 选项变；或 hook 返
  //  selectedAlias=null 表示 stale alias 不匹配)。
  useEffect(() => {
    if (selectedAlias && !data.availableAliases.includes(selectedAlias)) {
      setSelectedAlias(null)
    }
  }, [selectedAlias, data.availableAliases])
  const coverage = useDecisionsCoverageData(roomId, { enabled })

  // final-vision P1-1: unresolved decision click → DecisionSupersedeRejectModal
  const [supersedeTarget, setSupersedeTarget] = useState<DecisionRef | null>(null)

  return (
    <div className="flex flex-col gap-3 p-3 text-xs" data-testid="prompt-inspector-tab">
      <HeaderRow roomId={roomId} isLoading={isLoading} error={error} data={data} />
      <AliasFilterRow
        availableAliases={data.availableAliases}
        selectedAlias={selectedAlias ?? data.selectedAlias}
        onChange={setSelectedAlias}
      />
      <InjectedPartsTable parts={data.injectedParts} roomId={roomId} />
      <NotInjectedSection notInjectedParts={data.notInjectedParts} />
      <RecallSection queries={data.recallQueries} />
      <AdaptiveRecallPolicy state={data.recallState} />
      <AgentSessionSection roomId={roomId} />
      <WakeTriggerSection roomId={roomId} apiTrigger={data.wakeUpTrigger} />
      <CoverageSection
        data={coverage.data}
        isLoading={coverage.isLoading}
        error={coverage.error}
        onUnresolvedClick={(decision) => setSupersedeTarget(decision)}
      />
      <BottomButtonsBar
        rawText={data.rawText}
        ironLawsCount={data.ironLawsCount}
        currentParts={data.injectedParts}
        previousAudits={data.previousAudits}
      />
      <DecisionSupersedeRejectModal
        open={supersedeTarget !== null}
        roomId={roomId}
        target={supersedeTarget}
        callerAlias={getCurrentUserAlias()}
        onClose={() => setSupersedeTarget(null)}
        onSubmitSuccess={() => {
          // success → close modal + refetch coverage (data 已 stale)
          setSupersedeTarget(null)
          coverage.refetch()
        }}
      />
    </div>
  )
}

// ─── 1. 标题行 ────────────────────────────────────────────────────

function HeaderRow({
  roomId,
  isLoading,
  error,
  data,
}: {
  roomId: string | null
  isLoading: boolean
  error: string | null
  data: GetPromptInspectorResponse
}) {
  const totalTokens = data.injectedParts.reduce((sum, p) => sum + p.tokensEstimated, 0)
  // F027 v3 G1 · V16.5 chap 20 wake-up runtime cap (= WAKEUP_TOKEN_CAP 6700)。
  // cap=0 兜底: 老 audit 行 (v3 前 cap 占位为 0) — 显 "—" 防误导，pct 不计算。
  const cap = data.cap > 0 ? data.cap : 0
  const pct = cap > 0 ? Math.round((totalTokens / cap) * 100) : 0
  return (
    <div
      className="rounded border border-slate-200 bg-slate-50 px-3 py-2"
      data-testid="prompt-inspector-header"
    >
      <div className="text-caption font-semibold text-slate-700">
        {roomId ?? "—"} · prompt-inspector
      </div>
      <div className="mt-1 flex gap-3 text-micro text-slate-500">
        <span className="inline-flex items-center gap-1">
          <BarChart3 className="h-3 w-3 shrink-0" aria-hidden="true" />
          总计 {totalTokens} tok
        </span>
        <span>cap {cap > 0 ? cap : "—"}</span>
        {cap > 0 && <span>({pct}%)</span>}
        <span>parts {data.injectedParts.length}</span>
      </div>
      {isLoading && (
        <div
          className="mt-1 flex items-center gap-1 text-micro text-slate-400"
          data-testid="prompt-inspector-loading"
        >
          <Hourglass className="h-3 w-3 shrink-0" aria-hidden="true" />
          加载中…
        </div>
      )}
      {error && (
        <div
          className="mt-1 flex items-center gap-1 text-micro text-red-500"
          data-testid="prompt-inspector-error"
        >
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
          加载失败：{error}
        </div>
      )}
    </div>
  )
}

// ─── 1.5 🤖 Agent alias 过滤 (F027 v3 G4 · 多 agent room 切 per-agent prompt) ─

function AliasFilterRow({
  availableAliases,
  selectedAlias,
  onChange,
}: {
  availableAliases: string[]
  selectedAlias: string | null
  onChange: (alias: string | null) => void
}) {
  // 单 agent room (1 alias) → 折叠成只读标签；多 agent (≥2) → dropdown 可选
  if (availableAliases.length === 0) {
    return (
      <div
        className="flex items-center gap-1 rounded border border-dashed border-slate-200 px-3 py-1.5 text-micro text-slate-400"
        data-testid="prompt-inspector-alias-filter-empty"
      >
        <Bot className="h-3 w-3 shrink-0" aria-hidden="true" />
        Agent: — (room 内无 audit row)
      </div>
    )
  }
  if (availableAliases.length === 1) {
    return (
      <div
        className="flex items-center gap-1 rounded border border-slate-200 bg-slate-50 px-3 py-1.5 text-micro text-slate-600"
        data-testid="prompt-inspector-alias-filter-single"
      >
        <Bot className="h-3 w-3 shrink-0" aria-hidden="true" />
        Agent: <span className="font-mono font-semibold">{availableAliases[0]}</span>
        <span className="text-slate-400">(room 内仅 1 个 agent，无需切)</span>
      </div>
    )
  }
  return (
    <div
      className="flex items-center gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-1.5 text-micro text-slate-600"
      data-testid="prompt-inspector-alias-filter"
    >
      <span className="inline-flex items-center gap-1">
        <Bot className="h-3 w-3 shrink-0" aria-hidden="true" />
        Agent:
      </span>
      <select
        className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-micro"
        data-testid="prompt-inspector-alias-select"
        value={selectedAlias ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">— 最新 (不限 alias)</option>
        {availableAliases.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      <span className="text-slate-400">
        ({availableAliases.length} agent · 切换看每个 agent 自己的 system prompt)
      </span>
    </div>
  )
}

// ─── 2. ✅ 注入的 part 表 ─────────────────────────────────────────

function InjectedPartsTable({
  parts,
  roomId,
}: {
  parts: GetPromptInspectorResponse["injectedParts"]
  roomId: string | null
}) {
  const [tracePart, setTracePart] = useState<string | null>(null)
  const totalTokens = parts.reduce((sum, p) => sum + p.tokensEstimated, 0)
  // F027 P4-A5 · 追溯 part → wiki path 映射 (V16.5 §18 line 2078)。
  // 接通：viewfinder（RoomCompiler 派生）+ capability-digest（wiki/agents YAML）+
  //       handbook-agent-actions（wiki/rules MD）。这三个 part 的源都是 wiki 文件，
  //       wiki_events 会留 audit row（promote / update_wiki / RoomCompiler 三阶段）。
  // 不接通：recall-pack（动态 query 派生，无固定 wiki path；F028 扩 audit schema 追 source_event_ids）；
  //         其他 part（rolling-summary / sop-bookmark / base-identity 等）走 prompt 自身，不写 wiki。
  const traceablePath = (name: string): string | null => {
    if (name === "viewfinder" && roomId) return `wiki/rooms/${roomId}/viewfinder.md`
    if (name === "capability-digest") return "wiki/agents/agent-capabilities.yaml"
    if (name === "handbook-agent-actions") return "wiki/rules/agent-wiki-handbook.md"
    return null
  }
  return (
    <section data-testid="prompt-inspector-injected">
      <div className="mb-1 flex items-center gap-1 text-xs uppercase tracking-wider text-slate-500">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        注入的 part
      </div>
      {parts.length === 0 ? (
        <div className="rounded border border-dashed border-slate-300 p-2 text-xs text-slate-400">
          暂无 part 数据（prompt_audit 表为空）
        </div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-slate-200 border-b text-slate-500">
              <th className="text-left">名称</th>
              <th className="text-right">tokens</th>
              <th className="text-right">%</th>
              <th className="text-left">来源</th>
              <th className="text-center">追溯</th>
            </tr>
          </thead>
          <tbody>
            {parts.map((p) => {
              const pct = totalTokens > 0 ? Math.round((p.tokensEstimated / totalTokens) * 100) : 0
              const tracePath = traceablePath(p.name)
              return (
                <tr key={`${p.name}-${p.source}`} className="border-slate-100 border-b">
                  <td className="py-0.5">{p.name}</td>
                  <td className="text-right">{p.tokensEstimated}</td>
                  <td className="text-right text-slate-500">{pct}%</td>
                  <td className="truncate text-slate-400" title={p.source}>
                    {p.source}
                  </td>
                  <td className="text-center">
                    {tracePath ? (
                      <button
                        type="button"
                        onClick={() => setTracePart(p.name)}
                        className="rounded border border-blue-300 bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700 transition-colors hover:bg-blue-100"
                        title="查看本 part 对应的 wiki_events 写入历史"
                        aria-label="追溯 wiki_events"
                        data-testid={`trace-btn-${p.name}`}
                      >
                        <Search className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    ) : (
                      <span
                        className="text-slate-300"
                        title="本 part 无固定 wiki 源（动态派生 / prompt 自身），不支持 wiki_events 追溯"
                      >
                        —
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {tracePart && traceablePath(tracePart) && (
        // F027 P4-A5 · 移除 `&& roomId` 约束 — capability-digest / handbook-agent-actions
        // 的源是 wiki/agents/* / wiki/rules/*，不依赖 roomId（只有 viewfinder 需要）。
        <WikiEventsTraceModal
          partName={tracePart}
          path={traceablePath(tracePart) ?? ""}
          onClose={() => setTracePart(null)}
        />
      )}
    </section>
  )
}

/**
 * F027 P4 hotfix · 追溯 modal — 显示本 part 对应 wiki 文件的最近 10 条 wiki_events row。
 * V16.5 §18 line 2078 "[追溯 wiki_events]" 按钮真实现 (仅 viewfinder, 其他 F028)。
 *
 * 显示字段对齐 V16.5 §5 schema：ts / alias / action / state / reason；
 * hash + source 进 details 折叠（避免主表格视觉过载）。
 */
function WikiEventsTraceModal({
  partName,
  path,
  onClose,
}: {
  partName: string
  path: string
  onClose: () => void
}) {
  const apiBase = getApiHttpBaseUrl()
  const [events, setEvents] = useState<Array<{
    id: number
    ts: string
    alias: string
    action: string
    state: string
    baseHash: string | null
    contentHash: string | null
    sourceMessageIds: string[] | null
    reason: string | null
  }> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`${apiBase}/api/wiki/events?path=${encodeURIComponent(path)}&limit=10`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<{ events: typeof events }>
      })
      .then((json) => {
        if (cancelled) return
        setEvents(json.events ?? [])
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [apiBase, path])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose()
      }}
      role="dialog"
      aria-modal="true"
      data-testid="wiki-events-trace-modal"
    >
      <div
        className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-lg border border-slate-300 bg-white p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="document"
      >
        <div className="mb-2 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-800">追溯 wiki 事件</div>
            <div className="text-xs text-slate-500">
              part: <code className="font-mono">{partName}</code> · path:{" "}
              <code className="font-mono">{path}</code>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100"
          >
            关闭
          </button>
        </div>
        {error && (
          <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-600">
            加载失败：{error}
          </div>
        )}
        {!error && events === null && (
          <div className="flex items-center gap-1 p-2 text-xs text-slate-400">
            <Hourglass className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            加载中…
          </div>
        )}
        {!error && events && events.length === 0 && (
          <div className="rounded border border-dashed border-slate-300 p-3 text-xs text-slate-500">
            本 wiki 文件还没有 wiki_events 记录。可能原因：
            <ul className="ml-4 mt-1 list-disc">
              <li>viewfinder：room 还没编译过（写入会同步 audit 三行）</li>
              <li>capability-digest / handbook：YAML / MD 仅 git 管理，没走过 update_wiki MCP / promote 流程</li>
              <li>writer 侧 wikiEventsSink 未注入（查 server.ts boot 是否 wire）</li>
            </ul>
          </div>
        )}
        {!error && events && events.length > 0 && (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-slate-200 border-b text-slate-500">
                <th className="text-left">时间</th>
                <th className="text-left">操作者</th>
                <th className="text-left">动作</th>
                <th className="text-left">状态</th>
                <th className="text-left">原因</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-slate-100 border-b align-top">
                  <td className="py-1 font-mono text-slate-700">{formatLocalTime(e.ts)}</td>
                  <td className="py-1 text-slate-700">{e.alias}</td>
                  <td className="py-1 text-slate-700">{e.action}</td>
                  <td
                    className={`py-1 ${e.state === "committed" ? "text-green-600" : e.state === "pending" ? "text-amber-600" : "text-red-500"}`}
                  >
                    {e.state}
                  </td>
                  <td className="py-1 text-slate-500">{e.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!error && events && events.length > 0 && (
          <details className="mt-2 text-xs text-slate-500">
            <summary className="cursor-pointer hover:text-slate-700">查看 hash + source 详情</summary>
            <pre className="mt-1 max-h-48 overflow-auto rounded bg-slate-50 p-2 font-mono text-xs leading-relaxed text-slate-600">
              {JSON.stringify(events, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  )
}

// ─── 3. ❌ 未注入预期 part (F027 v3 G1 · V16.5 chap 20 token 预算溢出 drop) ──

/**
 * V16.5 chap 20 token 预算溢出时被 context-assembler drop reducer 砍的 part 列表。
 * 数据源：prompt_audit.not_injected_json (assembler 写入)。
 * 空数组 = 全部注入成功（不显示提示，节省垂直空间）。
 */
function NotInjectedSection({ notInjectedParts }: { notInjectedParts: NotInjectedPart[] }) {
  if (notInjectedParts.length === 0) {
    return (
      <section data-testid="prompt-inspector-not-injected">
        <div className="mb-1 flex items-center gap-1 text-micro uppercase tracking-wider text-slate-500">
          <XCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
          未注入预期 part
        </div>
        <div className="flex items-center gap-1 rounded border border-dashed border-slate-200 p-2 text-micro text-slate-400">
          <CheckCircle2 className="h-3 w-3 shrink-0" aria-hidden="true" />
          全部注入成功（无 cap 溢出 drop）
        </div>
      </section>
    )
  }
  const totalDropped = notInjectedParts.reduce((s, p) => s + p.tokens, 0)
  return (
    <section data-testid="prompt-inspector-not-injected">
      <div className="mb-1 flex items-center justify-between text-micro uppercase tracking-wider text-slate-500">
        <span className="inline-flex items-center gap-1">
          <XCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
          未注入预期 part
        </span>
        <span
          className="font-mono text-red-500"
          data-testid="prompt-inspector-not-injected-total"
        >
          {notInjectedParts.length} 个 / -{totalDropped} tok
        </span>
      </div>
      <ul className="space-y-0.5 rounded border border-red-200 bg-red-50 p-2 text-micro">
        {notInjectedParts.map((p) => (
          <li
            key={p.name}
            className="font-mono text-red-700"
            data-testid={`prompt-inspector-not-injected-${p.name}`}
          >
            <span className="font-semibold">{p.name}</span>
            <span className="ml-1 text-red-500">({p.tokens} tok)</span>
            <span className="ml-1 text-red-400">— {p.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ─── 4. 🤖 自动召回 + Quality Gate 三段 ──────────────────────────

function RecallSection({ queries }: { queries: GetPromptInspectorResponse["recallQueries"] }) {
  const high = queries.filter((q) => q.gate === "high").length
  const mid = queries.filter((q) => q.gate === "mid").length
  const low = queries.filter((q) => q.gate === "low").length
  return (
    <section data-testid="prompt-inspector-recall">
      <div className="mb-1 flex items-center gap-1 text-micro uppercase tracking-wider text-slate-500">
        <Bot className="h-3 w-3 shrink-0" aria-hidden="true" />
        自动召回
      </div>
      <div className="mb-1 flex gap-2 text-micro">
        <Badge color="green" testid="recall-gate-high">
          高 {high}
        </Badge>
        <Badge color="amber" testid="recall-gate-mid">
          中 {mid}
        </Badge>
        <Badge color="red" testid="recall-gate-low">
          低 {low}
        </Badge>
      </div>
      {queries.length === 0 ? (
        <div className="rounded border border-dashed border-slate-300 p-2 text-micro text-slate-400">
          暂无召回 query（memory_preflight 未触发或 prompt_audit 表为空）
        </div>
      ) : (
        <ul className="list-disc space-y-0.5 pl-4 text-micro">
          {queries.map((q, i) => (
            <li
              key={`${q.query}-${i}`}
              className={gateColorClass(q.gate)}
              data-testid={`recall-query-${i}`}
            >
              <span>{q.query}</span>
              <span className="ml-1 text-slate-400">
                ({q.hits} hits · top {q.topScore.toFixed(2)})
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function gateColorClass(gate: RecallGate): string {
  if (gate === "high") return "text-green-700"
  if (gate === "mid") return "text-amber-700"
  return "text-red-500"
}

// ─── 5. 📊 Adaptive Recall Policy (F027 v3 G8 · 字段人话说明) ─────────

const RECALL_PATH_LABEL: Record<number, string> = {
  1: "Level 1 · 直接命中 (existing context 满足)",
  2: "Level 2 · BM25 hybrid (lexical 召回)",
  3: "Level 3 · Embedding cosine (语义召回)",
  4: "Level 4 · Critique 严格路径 (LLM 评)",
  5: "Level 5 · Haiku rerank 升级 (容错兜底)",
}

function AdaptiveRecallPolicy({ state }: { state: GetPromptInspectorResponse["recallState"] }) {
  // F027 v3 G8 · Adaptive Recall 5 字段 inline 人话说明
  // 真相源 V16.5 chap 10 + 12 — 5 级 fallback + Quality Gate
  return (
    <section data-testid="prompt-inspector-policy">
      <div className="mb-1 flex items-center gap-1 text-micro uppercase tracking-wider text-slate-500">
        <BarChart3 className="h-3 w-3 shrink-0" aria-hidden="true" />
        Adaptive Recall Policy
        <span className="normal-case text-slate-400">
          (V16.5 chap 10 · 5 级召回 + Quality Gate)
        </span>
      </div>
      <div className="space-y-0.5 rounded border border-slate-200 bg-slate-50 p-2 text-micro">
        <div title="本次提问是否触发记忆召回 (短句通常 false; 长句/含关键词 true)">
          <span className="font-mono text-slate-600">recallRequired</span>
          <span className="ml-1 text-slate-400">· 本轮是否启动召回</span>
          <span className="ml-1">:</span>{" "}
          <span className={state.recallRequired ? "text-green-700" : "text-slate-400"}>
            {state.recallRequired ? (
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 shrink-0" aria-hidden="true" />
                true
              </span>
            ) : (
              "false"
            )}
          </span>
        </div>
        <div title="走到第几级召回 (1 = 直接命中, 5 = Haiku rerank 升级兜底)">
          <span className="font-mono text-slate-600">recallPath</span>
          <span className="ml-1 text-slate-400">· 走到第几级</span>
          <span className="ml-1">:</span>{" "}
          <span className="font-mono text-slate-700">
            {state.recallPath !== null
              ? (RECALL_PATH_LABEL[state.recallPath] ?? `Level ${state.recallPath}`)
              : "— (未触发召回)"}
          </span>
        </div>
        <div title="召回结果是否满足 Quality Gate (score ≥ 0.75 + 数量 ≥ 阈值)">
          <span className="font-mono text-slate-600">recallSatisfied</span>
          <span className="ml-1 text-slate-400">· 召回质量是否过关</span>
          <span className="ml-1">:</span>{" "}
          <span className={state.recallSatisfied ? "text-green-700" : "text-slate-400"}>
            {state.recallSatisfied ? (
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 shrink-0" aria-hidden="true" />
                true
              </span>
            ) : (
              "false"
            )}
          </span>
        </div>
        {state.escalateReason && (
          <div
            className="text-red-500"
            title="升级原因 (score 不够 / 数量不够 / 超时 → 触发 Level 5 Haiku rerank)"
          >
            <span className="font-mono">escalateReason</span>
            <span className="ml-1 text-red-400">· 升级原因</span>: {state.escalateReason}
          </div>
        )}
        <div
          className="text-slate-500"
          title="本轮召回烧的 token 预算 / 上限 (V15.2 Adaptive Recall budget)"
        >
          <span className="font-mono">budget</span>
          <span className="ml-1 text-slate-400">· token 预算</span>:{" "}
          {state.budgetConsumed} / {state.budgetMax} tok
        </div>
      </div>
    </section>
  )
}

// ─── 6. 🤝 当前 agent session (Day 14-15 占位 · sessions ledger 归 RESIDUAL-DEBT B2 未来 feature) ─

function AgentSessionSection({ roomId }: { roomId: string | null }) {
  return (
    <section data-testid="prompt-inspector-agent-session">
      <div className="mb-1 flex items-center gap-1 text-micro uppercase tracking-wider text-slate-500">
        <Handshake className="h-3 w-3 shrink-0" aria-hidden="true" />
        当前 agent session
      </div>
      <div className="flex items-start gap-1 rounded border border-dashed border-slate-300 p-2 text-micro text-slate-400">
        <Hourglass className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
        <span>
          sessions ledger 未来 feature：room={roomId ?? "—"} · Session #N · open_threads 列表
          （从 agent-sessions/&lt;alias&gt;/current.md 读，归 RESIDUAL-DEBT B2）
        </span>
      </div>
    </section>
  )
}

// ─── 7. 🔔 wake-up 触发因 (V16.5.2 + AC-P3-5 · WS 实时 优先 / API fallback) ────

function WakeTriggerSection({
  roomId,
  apiTrigger,
}: {
  roomId: string | null
  apiTrigger: GetPromptInspectorResponse["wakeUpTrigger"]
}) {
  // Day 14-15 简化：取 WS store 内任意 alias 最新（多 agent 场景按 triggeredAt max）。
  // Phase 4 enhancement: 让用户在 tab 内选 agent。
  const latestByKey = useWakeTriggerStore((state) => state.latestByKey)
  const wsTriggers = Array.from(latestByKey.values()).filter((t) => t.roomId === roomId)
  const wsLatest =
    wsTriggers.length > 0
      ? wsTriggers.reduce((a, b) =>
          new Date(a.triggeredAt).getTime() > new Date(b.triggeredAt).getTime() ? a : b,
        )
      : null
  return (
    <section data-testid="prompt-inspector-wake-trigger">
      <div className="mb-1 flex items-center gap-1 text-micro uppercase tracking-wider text-slate-500">
        <Bell className="h-3 w-3 shrink-0" aria-hidden="true" />
        wake-up 触发因
      </div>
      {wsLatest ? (
        <div
          className="rounded border border-amber-300 bg-amber-50 p-2 text-micro text-amber-900"
          data-testid="wake-trigger-ws"
        >
          <div>
            <span className="font-semibold">{wsLatest.alias}</span> @{" "}
            <span className="font-mono">{wsLatest.triggeredAt}</span>
          </div>
          <div className="mt-1 flex items-center gap-1">
            scenario: <span className="font-mono">{wsLatest.scenario}</span>
            {wsLatest.a2aCallId && (
              <>
                {" · "}
                <WakeTriggerA2APill callId={wsLatest.a2aCallId} />
              </>
            )}
          </div>
        </div>
      ) : apiTrigger.kind ? (
        <div
          className="rounded border border-slate-300 bg-slate-50 p-2 text-micro text-slate-600"
          data-testid="wake-trigger-api"
        >
          (snapshot from prompt_audit) kind: {apiTrigger.kind}
          {apiTrigger.ref && (
            <>
              {" · ref: "}
              {apiTrigger.kind === "a2a_call" ? (
                <WakeTriggerA2APill callId={apiTrigger.ref} />
              ) : (
                <span className="font-mono">{apiTrigger.ref}</span>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="rounded border border-dashed border-slate-300 p-2 text-micro text-slate-400">
          暂无 trigger（WS 未推送 / prompt_audit 表为空）
        </div>
      )}
    </section>
  )
}

// F027 Phase 3 Day 20 (AC-P3-5) · wake-trigger 内 a2a callId pill (click 打开 drawer)
// V16.5.2 line 1980-1984 拍: 与 viewfinder §4 a2a pill 共用同一 drawer + 同一 fetch
function WakeTriggerA2APill({ callId }: { callId: string }) {
  const openDrawer = useA2ADrawerStore((s) => s.openDrawer)
  return (
    <button
      type="button"
      onClick={() => openDrawer(callId, "prompt-inspector")}
      className="inline-flex items-center rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 font-mono text-micro text-amber-800 hover:brightness-95"
      title="click 打开 a2a 调用树"
      data-testid={`wake-trigger-a2a-pill-${callId.slice(0, 13)}`}
      data-call-id={callId}
    >
      [a2a_call={callId.length > 13 ? `${callId.slice(0, 13)}…` : callId}]
    </button>
  )
}

// ─── 8. 🛡️ Decision Coverage section (Day 13 AC-P4-9 c) ─────────────

function CoverageSection({
  data,
  isLoading,
  error,
  onUnresolvedClick,
}: {
  data: GetCoverageResponse
  isLoading: boolean
  error: string | null
  onUnresolvedClick: (decision: DecisionRef) => void
}) {
  // Defensive fallbacks (防 server response shape 异常或空字段)
  const status = data.status ?? "fail"
  const broad = data.broad ?? []
  const resolved = data.resolved ?? []
  const unresolved = data.unresolved ?? []
  const pct =
    data.coverage !== null && data.coverage !== undefined ? Math.round(data.coverage * 100) : null
  const statusColor =
    status === "pass"
      ? "border-green-300 bg-green-50 text-green-800"
      : status === "warn"
        ? "border-amber-300 bg-amber-50 text-amber-800"
        : "border-red-300 bg-red-50 text-red-800"

  return (
    <section data-testid="prompt-inspector-coverage">
      <div className="mb-1 flex items-center gap-2 text-micro uppercase tracking-wider text-slate-500">
        <span className="inline-flex items-center gap-1">
          <Shield className="h-3 w-3 shrink-0" aria-hidden="true" />
          Decision Coverage
        </span>
        <span className={`rounded border px-1.5 py-0.5 font-semibold ${statusColor}`}>
          {status.toUpperCase()}
        </span>
      </div>
      {isLoading ? (
        <div
          className="flex items-center gap-1 rounded border border-dashed border-slate-300 p-2 text-micro text-slate-400"
          data-testid="coverage-loading"
        >
          <Hourglass className="h-3 w-3 shrink-0" aria-hidden="true" />
          加载 coverage…
        </div>
      ) : error ? (
        <div
          className="flex items-start gap-1 rounded border border-red-300 bg-red-50 p-2 text-micro text-red-700"
          data-testid="coverage-error"
        >
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>coverage 加载失败：{error}</span>
        </div>
      ) : (
        <>
          <div className="mb-1 rounded border border-slate-200 bg-slate-50 p-2 text-micro text-slate-600">
            <span className="font-mono">{pct !== null ? `${pct}%` : "—"}</span>
            <span className="ml-2 text-slate-500">
              ({resolved.length} resolved / {broad.length} broad, {unresolved.length} unresolved)
            </span>
          </div>
          {unresolved.length === 0 ? (
            <div
              className="rounded border border-dashed border-slate-300 p-2 text-micro text-slate-400"
              data-testid="coverage-empty"
            >
              暂无 unresolved decision (coverage check pass 或 broad=0)
            </div>
          ) : (
            <ul className="space-y-1" data-testid="coverage-unresolved-list">
              {unresolved.map((d) => (
                <UnresolvedRow key={d.decisionId} decision={d} onClick={onUnresolvedClick} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

function UnresolvedRow({
  decision,
  onClick,
}: {
  decision: DecisionRef
  onClick: (decision: DecisionRef) => void
}) {
  // final-vision P1-1 (2026-05-27): click → DecisionSupersedeRejectModal (替换原 window.alert)
  return (
    <li
      className="rounded border border-amber-200 bg-amber-50 p-1.5 text-micro"
      data-testid={`coverage-unresolved-${decision.decisionId}`}
      data-decision-id={decision.decisionId}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className="inline-flex shrink-0 items-center rounded border border-amber-300 bg-amber-100 px-1 py-0.5 font-mono text-micro text-amber-700"
          data-testid={`coverage-decision-type-${decision.decisionId}`}
        >
          {decision.decisionType}
        </span>
        <span className="truncate text-micro text-slate-700 flex-1" title={decision.summary}>
          {decision.summary}
        </span>
        <button
          type="button"
          onClick={() => onClick(decision)}
          className="shrink-0 rounded bg-accent-500 px-2 py-0.5 text-micro font-medium text-white hover:bg-accent-600"
          data-testid={`coverage-confirm-button-${decision.decisionId}`}
          title="manual confirm (open supersede/reject modal)"
        >
          Confirm
        </button>
      </div>
      <div className="mt-0.5 text-micro text-slate-500">
        by <span className="font-mono">{decision.decidedBy}</span> @{" "}
        <span className="font-mono">{decision.decidedAt}</span>
      </div>
    </li>
  )
}

// ─── 底部 4 按钮 (F027 P4 hotfix · 查看 raw text + 复制全文 真实现) ─────────────────

function BottomButtonsBar({
  rawText,
  ironLawsCount,
  currentParts,
  previousAudits,
}: {
  rawText: string | null
  ironLawsCount: number
  currentParts: InjectedPart[]
  previousAudits: GetPromptInspectorResponse["previousAudits"]
}) {
  const [showRaw, setShowRaw] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")
  // 防御：老 mock / 老 API response 可能没 rawText 字段 (undefined) — string 严格判
  const hasData = typeof rawText === "string" && rawText.length > 0
  const hasPrev = previousAudits.length > 0

  const handleCopy = async () => {
    if (!rawText) return
    try {
      await navigator.clipboard.writeText(rawText)
      setCopyState("copied")
      setTimeout(() => setCopyState("idle"), 1500)
    } catch {
      setCopyState("failed")
      setTimeout(() => setCopyState("idle"), 1500)
    }
  }

  return (
    <div className="flex flex-col gap-2 border-slate-200 border-t pt-2" data-testid="prompt-inspector-buttons">
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          disabled={!hasData}
          className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          title={hasData ? "展开/收起完整 prompt 原文" : "本房间还无 prompt 审计记录"}
        >
          {showRaw ? "收起原文" : "查看原文"}
        </button>
        <button
          type="button"
          onClick={handleCopy}
          disabled={!hasData}
          className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          title={hasData ? "复制完整 prompt 原文到剪贴板" : "本房间还无 prompt 审计记录"}
        >
          {copyState === "copied" ? (
            <>
              已复制
              <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            </>
          ) : copyState === "failed" ? (
            "复制失败"
          ) : (
            "复制全文"
          )}
        </button>
        <button
          type="button"
          onClick={() => setShowDiff((v) => !v)}
          disabled={!hasPrev}
          className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          title={
            hasPrev
              ? "对比当前与上一次注入的 part 列表 + token 数变化"
              : "本房间还无历史 audit（需≥2 次拼装才能对比）"
          }
        >
          {showDiff ? "收起对比" : "对比上次注入"}
        </button>
        <button
          type="button"
          disabled
          className="cursor-not-allowed rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-400"
          title="按 part 追溯（每行右侧放大镜按钮）；此 prompt 由多 part 拼装，无全局 wiki 源"
        >
          追溯 wiki 事件
        </button>
      </div>
      {hasData && (
        <div className="text-xs text-slate-500">
          Iron Laws 检测：
          <span
            className={
              ironLawsCount === 1
                ? "ml-1 text-green-600"
                : ironLawsCount === 0
                  ? "ml-1 text-red-500"
                  : "ml-1 text-amber-600"
            }
          >
            {ironLawsCount === 1
              ? `${ironLawsCount} 次（正常，B022 防回归通过）`
              : ironLawsCount === 0
                ? "0 次（异常，base prompt 漏注？）"
                : `${ironLawsCount} 次（异常，疑似多源冗余回归）`}
          </span>
        </div>
      )}
      {showRaw && rawText && (
        <pre
          className="max-h-96 overflow-auto rounded border border-slate-200 bg-slate-50 p-2 font-mono text-xs leading-relaxed text-slate-700 whitespace-pre-wrap"
          data-testid="prompt-inspector-raw-text"
        >
          {rawText}
        </pre>
      )}
      {showDiff && hasPrev && (
        <DiffPanel
          currentParts={currentParts}
          previous={previousAudits[0]}
          currentRawText={rawText ?? ""}
          currentIronLawsCount={ironLawsCount}
        />
      )}
    </div>
  )
}

/**
 * F027 P4 hotfix · 「对比上次注入」面板。
 *
 * V16.5 §18 line 2078 "[对比上一次注入]" 按钮真实现。
 * 显示 part-by-part 对比：哪些 part 新增 (+) / 移除 (-) / token 变化 (was X → now Y)。
 * 不做 textual diff（rawText 几 k 字 textual diff 太杂）—— part-level 对比已经够看决策面。
 */
function DiffPanel({
  currentParts,
  previous,
  currentRawText,
  currentIronLawsCount,
}: {
  currentParts: InjectedPart[]
  previous: GetPromptInspectorResponse["previousAudits"][number]
  currentRawText: string
  currentIronLawsCount: number
}) {
  const prevByName = new Map(previous.injectedParts.map((p) => [p.name, p]))
  const currByName = new Map(currentParts.map((p) => [p.name, p]))
  const allNames = Array.from(new Set([...prevByName.keys(), ...currByName.keys()]))
  const rows = allNames.map((name) => {
    const prev = prevByName.get(name)
    const curr = currByName.get(name)
    let kind: "added" | "removed" | "changed" | "same" = "same"
    if (!prev && curr) kind = "added"
    else if (prev && !curr) kind = "removed"
    else if (prev && curr && prev.tokensEstimated !== curr.tokensEstimated) kind = "changed"
    return { name, prev, curr, kind }
  })
  const summary = {
    added: rows.filter((r) => r.kind === "added").length,
    removed: rows.filter((r) => r.kind === "removed").length,
    changed: rows.filter((r) => r.kind === "changed").length,
    same: rows.filter((r) => r.kind === "same").length,
  }
  const ironLawsDelta = currentIronLawsCount - previous.ironLawsCount
  const rawLenDelta = currentRawText.length - previous.rawText.length
  return (
    <div
      className="rounded border border-blue-200 bg-blue-50/40 p-2 text-xs"
      data-testid="prompt-inspector-diff-panel"
    >
      <div className="mb-1 flex flex-wrap gap-2 text-xs text-slate-600">
        <span>对比上一次（{formatLocalTime(previous.createdAt)} · {previous.scenario || "—"}）</span>
        <span className="text-slate-400">·</span>
        <span className="text-green-600">+{summary.added} 新增</span>
        <span className="text-red-500">−{summary.removed} 移除</span>
        <span className="text-amber-600">~{summary.changed} 变化</span>
        <span className="text-slate-500">={summary.same} 不变</span>
      </div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-slate-200 border-b text-slate-500">
            <th className="py-0.5 text-left">part</th>
            <th className="py-0.5 text-right">上次 tokens</th>
            <th className="py-0.5 text-right">当前 tokens</th>
            <th className="py-0.5 text-center">变化</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const colorClass =
              r.kind === "added"
                ? "text-green-700"
                : r.kind === "removed"
                  ? "text-red-600"
                  : r.kind === "changed"
                    ? "text-amber-700"
                    : "text-slate-500"
            const marker =
              r.kind === "added" ? "+" : r.kind === "removed" ? "−" : r.kind === "changed" ? "~" : "="
            return (
              <tr key={r.name} className="border-slate-100 border-b" data-testid={`diff-row-${r.name}`}>
                <td className={`py-0.5 font-mono ${colorClass}`}>
                  {marker} {r.name}
                </td>
                <td className="py-0.5 text-right text-slate-500">{r.prev?.tokensEstimated ?? "—"}</td>
                <td className="py-0.5 text-right text-slate-700">{r.curr?.tokensEstimated ?? "—"}</td>
                <td className={`py-0.5 text-center ${colorClass}`}>
                  {r.prev && r.curr
                    ? r.prev.tokensEstimated === r.curr.tokensEstimated
                      ? "—"
                      : `${r.prev.tokensEstimated > r.curr.tokensEstimated ? "↓" : "↑"} ${Math.abs(r.curr.tokensEstimated - r.prev.tokensEstimated)}`
                    : r.kind === "added"
                      ? "新增"
                      : "移除"}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="mt-1 text-xs text-slate-500">
        Iron Laws: {previous.ironLawsCount} → {currentIronLawsCount}
        {ironLawsDelta !== 0 && (
          <span className={ironLawsDelta > 0 ? "ml-1 text-amber-600" : "ml-1 text-red-500"}>
            ({ironLawsDelta > 0 ? "+" : ""}{ironLawsDelta})
          </span>
        )}
        <span className="mx-2 text-slate-400">·</span>
        原文长度: {previous.rawText.length} → {currentRawText.length}
        {rawLenDelta !== 0 && (
          <span className={rawLenDelta > 0 ? "ml-1 text-amber-600" : "ml-1 text-slate-500"}>
            ({rawLenDelta > 0 ? "+" : ""}{rawLenDelta} 字符)
          </span>
        )}
      </div>
    </div>
  )
}

function formatLocalTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString("zh-CN", { hour12: false })
  } catch {
    return iso
  }
}

// ─── helpers ──────────────────────────────────────────────────────

function Badge({
  color,
  children,
  testid,
}: {
  color: "green" | "amber" | "red"
  children: React.ReactNode
  testid?: string
}) {
  const cls =
    color === "green"
      ? "bg-green-100 text-green-700"
      : color === "amber"
        ? "bg-amber-100 text-amber-700"
        : "bg-red-100 text-red-700"
  return (
    <span className={`rounded px-1.5 py-0.5 font-semibold ${cls}`} data-testid={testid}>
      {children}
    </span>
  )
}
