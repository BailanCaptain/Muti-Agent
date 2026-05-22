"use client"

import { useThreadStore } from "@/components/stores/thread-store"
import { useWakeTriggerStore } from "@/components/stores/wake-trigger-store"
import {
  type GetPromptInspectorResponse,
  type RecallGate,
  usePromptInspectorData,
} from "./prompt-inspector/use-prompt-inspector-data"

/**
 * F027 Phase 3 Week 4 Day 14-15 (AC-P3-3 + AC-P3-5) · PromptInspectorTab 7 块真实数据
 *
 * 真相源：
 *   - V16.5 chap 18 line 2030-2079 (7 块原文 mockup)
 *   - feature.md line 179 (AC-P3-3 透明显示)
 *   - feature.md line 181 (AC-P3-5 顶部 wake-up 触发因 V16.5.2)
 *
 * 7 块按 chap 18 顺序:
 *   1. 标题行 (room → agent wake-up @ time · token 总账)
 *   2. ✅ 注入的 part 表 (含 token 占比)
 *   3. ❌ 未注入预期 part (含 B022 防回归 Iron Laws 重复检测)
 *   4. 🤖 自动召回 (Quality Gate 三段：high/mid/low)
 *   5. 📊 Adaptive Recall Policy (recall_required / path Level 1-5 / satisfied)
 *   6. 🤝 当前 agent session (Day 14-15 暂占位 · Phase 4 接 agent-sessions ledger)
 *   7. 🔔 wake-up 触发因 (V16.5.2 · 取 WS event 优先 / API fallback)
 *   8. 底部 4 按钮 [查看 raw text] [对比上一次注入] [追溯 wiki_events] [复制全文]
 *      （Day 14-15 暂禁用 · Week 5 实施真功能）
 *
 * 数据流:
 *   - usePromptInspectorData(roomId) fetch GET /api/rooms/:id/prompt-inspector
 *   - useWakeTriggerStore.getLatest(roomId, alias) 取 WS 实时 trigger (G1 commit c227eef)
 *   - 顶部 🔔 触发因优先用 store latest（实时），无则用 API.wakeUpTrigger（snapshot）
 */
export function PromptInspectorTab() {
  const activeGroup = useThreadStore((state) => state.activeGroup)
  const roomId = activeGroup?.roomId ?? null
  const { data, isLoading, error } = usePromptInspectorData(roomId)

  return (
    <div className="flex flex-col gap-3 p-3 text-xs" data-testid="prompt-inspector-tab">
      <HeaderRow roomId={roomId} isLoading={isLoading} error={error} data={data} />
      <InjectedPartsTable parts={data.injectedParts} />
      <NotInjectedSection />
      <RecallSection queries={data.recallQueries} />
      <AdaptiveRecallPolicy state={data.recallState} />
      <AgentSessionSection roomId={roomId} />
      <WakeTriggerSection roomId={roomId} apiTrigger={data.wakeUpTrigger} />
      <BottomButtonsBar />
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
  const cap = 5500 // 默认 cap 占位 — Phase 4/5 接精确度量
  const pct = cap > 0 ? Math.round((totalTokens / cap) * 100) : 0
  return (
    <div
      className="rounded border border-slate-200 bg-slate-50 px-3 py-2"
      data-testid="prompt-inspector-header"
    >
      <div className="text-[11px] font-semibold text-slate-700">
        {roomId ?? "—"} · prompt-inspector
      </div>
      <div className="mt-1 flex gap-3 text-[10px] text-slate-500">
        <span>📊 总计 {totalTokens} tok</span>
        <span>cap {cap}</span>
        <span>({pct}%)</span>
        <span>parts {data.injectedParts.length}</span>
      </div>
      {isLoading && (
        <div className="mt-1 text-[10px] text-slate-400" data-testid="prompt-inspector-loading">
          ⏳ 加载中…
        </div>
      )}
      {error && (
        <div className="mt-1 text-[10px] text-red-500" data-testid="prompt-inspector-error">
          ⚠ 加载失败：{error}
        </div>
      )}
    </div>
  )
}

// ─── 2. ✅ 注入的 part 表 ─────────────────────────────────────────

function InjectedPartsTable({ parts }: { parts: GetPromptInspectorResponse["injectedParts"] }) {
  const totalTokens = parts.reduce((sum, p) => sum + p.tokensEstimated, 0)
  return (
    <section data-testid="prompt-inspector-injected">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">✅ 注入的 part</div>
      {parts.length === 0 ? (
        <div className="rounded border border-dashed border-slate-300 p-2 text-[10px] text-slate-400">
          暂无 part 数据（prompt_audit 表为空）
        </div>
      ) : (
        <table className="w-full text-[10px]">
          <thead>
            <tr className="border-slate-200 border-b text-slate-500">
              <th className="text-left">名称</th>
              <th className="text-right">tokens</th>
              <th className="text-right">%</th>
              <th className="text-left">来源</th>
            </tr>
          </thead>
          <tbody>
            {parts.map((p) => {
              const pct = totalTokens > 0 ? Math.round((p.tokensEstimated / totalTokens) * 100) : 0
              return (
                <tr key={`${p.name}-${p.source}`} className="border-slate-100 border-b">
                  <td className="py-0.5">{p.name}</td>
                  <td className="text-right">{p.tokensEstimated}</td>
                  <td className="text-right text-slate-500">{pct}%</td>
                  <td className="truncate text-slate-400" title={p.source}>
                    {p.source}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}

// ─── 3. ❌ 未注入预期 part (B022 防回归 Iron Laws 重复检测) ──────────

function NotInjectedSection() {
  return (
    <section data-testid="prompt-inspector-not-injected">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
        ❌ 未注入预期 part
      </div>
      {/* Day 14-15 暂占位：prompt_audit row.not_injected_json 解析留 Week 5 */}
      <div className="rounded border border-dashed border-slate-300 p-2 text-[10px] text-slate-400">
        ⏳ Week 5 接：not_injected_json 解析 + Iron Laws 重复检测（B022 防回归）
      </div>
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
      <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">🤖 自动召回</div>
      <div className="mb-1 flex gap-2 text-[10px]">
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
        <div className="rounded border border-dashed border-slate-300 p-2 text-[10px] text-slate-400">
          暂无召回 query（memory_preflight 未触发或 prompt_audit 表为空）
        </div>
      ) : (
        <ul className="list-disc space-y-0.5 pl-4 text-[10px]">
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

// ─── 5. 📊 Adaptive Recall Policy ─────────────────────────────────

function AdaptiveRecallPolicy({ state }: { state: GetPromptInspectorResponse["recallState"] }) {
  return (
    <section data-testid="prompt-inspector-policy">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
        📊 Adaptive Recall Policy
      </div>
      <div className="space-y-0.5 rounded border border-slate-200 bg-slate-50 p-2 text-[10px]">
        <div>
          recallRequired:{" "}
          <span className={state.recallRequired ? "text-green-700" : "text-slate-400"}>
            {state.recallRequired ? "✅ true" : "false"}
          </span>
        </div>
        <div>
          recallPath:{" "}
          <span className="font-mono text-slate-700">
            {state.recallPath !== null ? `Level ${state.recallPath}` : "—"}
          </span>
        </div>
        <div>
          recallSatisfied:{" "}
          <span className={state.recallSatisfied ? "text-green-700" : "text-slate-400"}>
            {state.recallSatisfied ? "✅ true" : "false"}
          </span>
        </div>
        {state.escalateReason && (
          <div className="text-red-500">escalate: {state.escalateReason}</div>
        )}
        <div className="text-slate-500">
          budget: {state.budgetConsumed} / {state.budgetMax} tok
        </div>
      </div>
    </section>
  )
}

// ─── 6. 🤝 当前 agent session (Day 14-15 占位 · Phase 4 接 agent-sessions ledger) ─

function AgentSessionSection({ roomId }: { roomId: string | null }) {
  return (
    <section data-testid="prompt-inspector-agent-session">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
        🤝 当前 agent session
      </div>
      <div className="rounded border border-dashed border-slate-300 p-2 text-[10px] text-slate-400">
        ⏳ Phase 4 接：room={roomId ?? "—"} · Session #N · open_threads 列表 （从
        agent-sessions/&lt;alias&gt;/current.md 读）
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
      <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
        🔔 wake-up 触发因
      </div>
      {wsLatest ? (
        <div
          className="rounded border border-amber-300 bg-amber-50 p-2 text-[10px] text-amber-900"
          data-testid="wake-trigger-ws"
        >
          <div>
            <span className="font-semibold">{wsLatest.alias}</span> @{" "}
            <span className="font-mono">{wsLatest.triggeredAt}</span>
          </div>
          <div>
            scenario: <span className="font-mono">{wsLatest.scenario}</span>
            {wsLatest.a2aCallId && (
              <>
                {" · "}
                <span className="font-mono">[a2a_call={wsLatest.a2aCallId}]</span>
              </>
            )}
          </div>
          {/* click pill drawer 留 Week 4 实施 — 现在只显示 trigger info */}
        </div>
      ) : apiTrigger.kind ? (
        <div
          className="rounded border border-slate-300 bg-slate-50 p-2 text-[10px] text-slate-600"
          data-testid="wake-trigger-api"
        >
          (snapshot from prompt_audit) kind: {apiTrigger.kind}
          {apiTrigger.ref && (
            <>
              {" · ref: "}
              <span className="font-mono">{apiTrigger.ref}</span>
            </>
          )}
        </div>
      ) : (
        <div className="rounded border border-dashed border-slate-300 p-2 text-[10px] text-slate-400">
          暂无 trigger（WS 未推送 / prompt_audit 表为空）
        </div>
      )}
    </section>
  )
}

// ─── 8. 底部 4 按钮 (Day 14-15 暂禁用 · Week 5 实施) ──────────────

function BottomButtonsBar() {
  const buttons = ["查看 raw text", "对比上一次注入", "追溯 wiki_events", "复制全文"]
  return (
    <div
      className="flex gap-1 border-slate-200 border-t pt-2"
      data-testid="prompt-inspector-buttons"
    >
      {buttons.map((label) => (
        <button
          key={label}
          type="button"
          disabled
          className="cursor-not-allowed rounded bg-slate-100 px-2 py-0.5 text-[9px] text-slate-400"
          title="Week 5 接入"
        >
          {label}
        </button>
      ))}
    </div>
  )
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
