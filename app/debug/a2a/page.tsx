"use client"

import { A2ACallList, A2ATreeView } from "@/components/debug/a2a-tree-view"
import type {
  DebugA2ACallStatus,
  DebugA2AResponse,
  DebugA2ASessionTreesResponse,
  DebugA2AStatusResponse,
} from "@/components/debug/a2a-types"
import { useThreadStore } from "@/components/stores/thread-store"
import { useCallback, useEffect, useState } from "react"

/**
 * F026 P5 F10 · /debug/a2a 视图本体（spec line 380 + AC-P5-14）
 *
 * 4 tab：pending / working / timeout（直接列表）+ session-tree（聚合按 root 的递归树）。
 * 不订阅 WS（plan 明示「避免首版复杂度」），手动 refresh 按钮触发 refetch。
 *
 * 后端依赖：T3 已落 GET /debug/a2a 扩展 status filter + session-trees 视图。
 *   - ?status=pending|working|timeout  → DebugA2AStatusResponse
 *   - ?session=<gid>&view=tree         → DebugA2ASessionTreesResponse
 */

const TABS: Array<{ id: "pending" | "working" | "timeout" | "tree"; label: string }> = [
  { id: "pending", label: "Pending（待发）" },
  { id: "working", label: "Working（进行中）" },
  { id: "timeout", label: "Timeout（超时）" },
  { id: "tree", label: "Session Tree（按 root 聚合）" },
]

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"
}

export default function DebugA2APage() {
  const sessionGroups = useThreadStore((state) => state.sessionGroups)
  const bootstrap = useThreadStore((state) => state.bootstrap)

  const [activeTab, setActiveTab] = useState<"pending" | "working" | "timeout" | "tree">("pending")
  const [selectedSessionId, setSelectedSessionId] = useState<string>("")
  const [statusData, setStatusData] = useState<DebugA2AStatusResponse | null>(null)
  const [treesData, setTreesData] = useState<DebugA2ASessionTreesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null)

  // bootstrap 拿 sessionGroups 列表（dropdown 数据源）
  useEffect(() => {
    if (sessionGroups.length === 0) {
      void bootstrap().catch((e) => {
        setError(e instanceof Error ? e.message : "bootstrap 失败")
      })
    }
  }, [sessionGroups.length, bootstrap])

  // 默认选第一个 session
  useEffect(() => {
    if (!selectedSessionId && sessionGroups.length > 0) {
      setSelectedSessionId(sessionGroups[0].id)
    }
  }, [selectedSessionId, sessionGroups])

  const refetch = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const baseUrl = getApiBaseUrl()
      let url: string
      if (activeTab === "tree") {
        if (!selectedSessionId) {
          setTreesData({ kind: "session_trees", sessionGroupId: "", trees: [] })
          return
        }
        url = `${baseUrl}/debug/a2a?session=${encodeURIComponent(selectedSessionId)}&view=tree`
      } else {
        const statusValue: DebugA2ACallStatus = activeTab
        url = `${baseUrl}/debug/a2a?status=${statusValue}`
      }
      const response = await fetch(url)
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `请求失败 ${response.status}`)
      }
      const data = (await response.json()) as DebugA2AResponse
      if ("error" in data) {
        throw new Error(data.error)
      }
      if (data.kind === "status") {
        setStatusData(data)
      } else if (data.kind === "session_trees") {
        setTreesData(data)
      }
      setLastFetchedAt(new Date().toISOString())
    } catch (e) {
      setError(e instanceof Error ? e.message : "请求失败")
    } finally {
      setLoading(false)
    }
  }, [activeTab, selectedSessionId])

  // tab 切换 / session 选择变更后自动 refetch
  useEffect(() => {
    void refetch()
  }, [refetch])

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto max-w-5xl">
        <header className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-slate-800">A2A 派发对账</h1>
            <p className="text-[12px] text-slate-500">
              call-registry 实时窗口（F026 P5 F10）· 不订阅 WS，手动刷新
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={loading}
            data-testid="a2a-refresh-button"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 shadow-sm transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Loading..." : "刷新"}
          </button>
        </header>

        <nav
          data-testid="a2a-tabs"
          className="mb-4 flex flex-wrap gap-2 border-b border-slate-200"
        >
          {TABS.map((t) => {
            const active = t.id === activeTab
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                data-testid={`a2a-tab-${t.id}`}
                className={`px-3 py-2 text-[13px] font-medium transition ${
                  active
                    ? "border-b-2 border-slate-800 text-slate-900"
                    : "border-b-2 border-transparent text-slate-500 hover:text-slate-700"
                }`}
              >
                {t.label}
              </button>
            )
          })}
        </nav>

        {activeTab === "tree" ? (
          <div className="mb-4 flex items-center gap-2">
            <label htmlFor="session-select" className="text-[12px] text-slate-600">
              Session:
            </label>
            <select
              id="session-select"
              data-testid="a2a-session-select"
              value={selectedSessionId}
              onChange={(e) => setSelectedSessionId(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[12px]"
            >
              {sessionGroups.length === 0 ? (
                <option value="">（无 session）</option>
              ) : (
                sessionGroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title} ({g.id.slice(0, 8)})
                  </option>
                ))
              )}
            </select>
          </div>
        ) : null}

        {error ? (
          <div
            data-testid="a2a-error"
            className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-[12px] text-rose-700"
          >
            ⚠️ {error}
          </div>
        ) : null}

        <main>
          {activeTab === "tree" ? (
            treesData?.trees.length ? (
              <div className="flex flex-col gap-3">
                {treesData.trees.map((tree) => (
                  <A2ATreeView key={tree.rootCallId} tree={tree} />
                ))}
              </div>
            ) : (
              <div
                data-testid="a2a-empty-trees"
                className="rounded border border-dashed border-slate-200 bg-white/50 p-6 text-center text-[12px] text-slate-400"
              >
                {selectedSessionId ? "该 session 暂无 a2a 调用。" : "请选择一个 session。"}
              </div>
            )
          ) : (
            <A2ACallList calls={statusData?.calls ?? []} />
          )}
        </main>

        {lastFetchedAt ? (
          <footer className="mt-3 text-right text-[10px] text-slate-400">
            最后刷新：{lastFetchedAt}
          </footer>
        ) : null}
      </div>
    </div>
  )
}
