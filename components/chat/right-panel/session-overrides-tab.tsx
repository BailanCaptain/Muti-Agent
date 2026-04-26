"use client"

import { useRuntimeConfigStore } from "@/components/stores/runtime-config-store"
import type { Provider } from "@multi-agent/shared"
import { useEffect, useState } from "react"
import { useSaveStatus } from "./use-save-status"

type Props = {
  provider: Provider
  isRunning: boolean
}

export function SessionOverridesTab({ provider, isRunning }: Props) {
  const catalog = useRuntimeConfigStore((s) => s.catalog)
  const globalOverride = useRuntimeConfigStore((s) => s.config[provider])
  const sessionOverride = useRuntimeConfigStore((s) => s.sessionConfig[provider])
  const setSessionOverride = useRuntimeConfigStore((s) => s.setSessionOverride)

  const [model, setModel] = useState(sessionOverride?.model ?? "")
  const [effort, setEffort] = useState(sessionOverride?.effort ?? "")
  // F021 Phase 6: contextWindow + sealPct（UI 用百分比 string）
  const [contextWindow, setContextWindow] = useState(
    sessionOverride?.contextWindow != null ? String(sessionOverride.contextWindow) : "",
  )
  const [sealPctPercent, setSealPctPercent] = useState(
    sessionOverride?.sealPct != null
      ? String(Math.round(sessionOverride.sealPct * 100))
      : "",
  )

  // F021 P2 (范德彪 二轮 review): 切 provider 或 sessionConfig 异步到达时，
  // 本地输入必须重新同步到 store 的 sessionOverride —— 否则抽屉内切齿轮 /
  // loadSession race 会让 input 保留旧值，误保存到错的 provider/session。
  useEffect(() => {
    setModel(sessionOverride?.model ?? "")
    setEffort(sessionOverride?.effort ?? "")
    setContextWindow(
      sessionOverride?.contextWindow != null ? String(sessionOverride.contextWindow) : "",
    )
    setSealPctPercent(
      sessionOverride?.sealPct != null
        ? String(Math.round(sessionOverride.sealPct * 100))
        : "",
    )
  }, [
    provider,
    sessionOverride?.model,
    sessionOverride?.effort,
    sessionOverride?.contextWindow,
    sessionOverride?.sealPct,
  ])
  const applyStatus = useSaveStatus({ idle: "应用到当前会话" })
  const pendingStatus = useSaveStatus({ idle: "挂起到下一轮" })
  const clearStatus = useSaveStatus({
    idle: "清除覆盖",
    saving: "清除中…",
    saved: "✓ 已清除",
  })
  const anyBusy = applyStatus.isBusy || pendingStatus.isBusy || clearStatus.isBusy

  const providerCatalog = catalog?.[provider]
  const modelListId = `session-models-${provider}`

  const hasModelOverride = Boolean(sessionOverride?.model)
  const hasEffortOverride = Boolean(sessionOverride?.effort)
  const hasContextWindowOverride = sessionOverride?.contextWindow != null
  const hasSealPctOverride = sessionOverride?.sealPct != null

  const buildPayload = () => ({
    model,
    effort,
    contextWindow:
      contextWindow.trim() === "" ? undefined : Number(contextWindow),
    sealPct:
      sealPctPercent.trim() === "" ? undefined : Number(sealPctPercent) / 100,
  })

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-1.5 px-0.5 text-[11px] leading-relaxed text-slate-500">
        改这里只影响当前会话 · 未覆盖字段继承自
        <span className="ml-0.5 rounded bg-indigo-50 px-1.5 py-[1px] text-[10px] font-semibold text-indigo-500">
          全局默认
        </span>
      </div>

      <Field label="模型" badge={hasModelOverride ? "override" : "inherit"} inheritValue={globalOverride?.model}>
        <input
          id={`session-model-${provider}`}
          aria-label="模型"
          list={modelListId}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={globalOverride?.model ?? "系统默认"}
          className="w-full rounded-[10px] border border-slate-200 bg-white px-3 py-2 font-mono text-[13px] text-slate-900 outline-none transition focus:border-indigo-400"
        />
        <datalist id={modelListId}>
          {providerCatalog?.models.map((m) => (
            <option key={m.name} value={m.name}>
              {m.label}
            </option>
          ))}
        </datalist>
      </Field>

      <Field label="思考强度" badge={hasEffortOverride ? "override" : "inherit"} inheritValue={globalOverride?.effort}>
        <select
          id={`session-effort-${provider}`}
          aria-label="强度"
          value={effort}
          onChange={(e) => setEffort(e.target.value)}
          disabled={!providerCatalog?.efforts.length}
          className="w-full rounded-[10px] border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-900 outline-none transition focus:border-indigo-400 disabled:bg-slate-50 disabled:text-slate-400"
        >
          <option value="">{globalOverride?.effort ?? "默认"}</option>
          {providerCatalog?.efforts.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="最大窗口"
        badge={hasContextWindowOverride ? "override" : "inherit"}
        inheritValue={globalOverride?.contextWindow != null ? String(globalOverride.contextWindow) : null}
      >
        <input
          id={`session-context-window-${provider}`}
          aria-label="最大窗口"
          type="number"
          min={1}
          step={1}
          value={contextWindow}
          onChange={(e) => setContextWindow(e.target.value)}
          placeholder={
            globalOverride?.contextWindow != null
              ? String(globalOverride.contextWindow)
              : "模型默认"
          }
          className="w-full rounded-[10px] border border-slate-200 bg-white px-3 py-2 font-mono text-[13px] text-slate-900 outline-none transition focus:border-indigo-400"
        />
      </Field>

      <Field
        label="Seal 阈值"
        badge={hasSealPctOverride ? "override" : "inherit"}
        inheritValue={
          globalOverride?.sealPct != null
            ? `${Math.round(globalOverride.sealPct * 100)}%`
            : null
        }
      >
        <div className="flex items-center gap-2">
          <input
            id={`session-seal-pct-${provider}`}
            aria-label="Seal 阈值"
            type="number"
            min={30}
            max={100}
            step={1}
            value={sealPctPercent}
            onChange={(e) => setSealPctPercent(e.target.value)}
            placeholder={
              globalOverride?.sealPct != null
                ? String(Math.round(globalOverride.sealPct * 100))
                : "代码默认"
            }
            className="w-full rounded-[10px] border border-slate-200 bg-white px-3 py-2 font-mono text-[13px] text-slate-900 outline-none transition focus:border-indigo-400"
          />
          <span className="text-[12px] text-slate-500">%</span>
        </div>
      </Field>

      {isRunning && (
        <div className="flex gap-2 rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2.5 text-[11px] leading-relaxed text-amber-800">
          <span className="text-[13px] leading-none">⏱</span>
          <div>
            <b className="font-semibold">会话运行中 · 将在下一轮生效</b>
            <div className="mt-0.5 text-amber-700/80">
              运行中，下一轮生效（改动写入 pending，invocation 启动时自动应用）
            </div>
          </div>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          disabled={anyBusy || isRunning}
          aria-busy={applyStatus.status === "saving"}
          onClick={() =>
            void applyStatus.run(() =>
              setSessionOverride(provider, buildPayload(), false),
            )
          }
          className={`flex-1 rounded-[10px] px-3 py-2.5 text-[12px] font-semibold transition disabled:cursor-not-allowed ${
            applyStatus.status === "saved"
              ? "bg-emerald-600 text-white disabled:bg-emerald-600 disabled:text-white"
              : "bg-slate-900 text-white hover:bg-slate-800 disabled:bg-slate-300 disabled:text-slate-500"
          }`}
        >
          {applyStatus.label}
        </button>
        {isRunning && (
          <button
            type="button"
            disabled={anyBusy}
            aria-busy={pendingStatus.status === "saving"}
            onClick={() =>
              void pendingStatus.run(() =>
                setSessionOverride(provider, buildPayload(), true),
              )
            }
            className={`flex-1 rounded-[10px] px-3 py-2.5 text-[12px] font-semibold transition disabled:opacity-50 ${
              pendingStatus.status === "saved"
                ? "bg-emerald-600 text-white"
                : "bg-slate-100 text-slate-900 hover:bg-slate-200"
            }`}
          >
            {pendingStatus.label}
          </button>
        )}
      </div>

      <button
        type="button"
        disabled={anyBusy}
        aria-busy={clearStatus.status === "saving"}
        onClick={() =>
          void clearStatus.run(async () => {
            setModel("")
            setEffort("")
            setContextWindow("")
            setSealPctPercent("")
            await setSessionOverride(
              provider,
              { model: "", effort: "", contextWindow: undefined, sealPct: undefined },
              false,
            )
          })
        }
        className={`w-full rounded-[10px] border px-3 py-2 text-[11px] transition disabled:opacity-50 ${
          clearStatus.status === "saved"
            ? "border-emerald-300 bg-emerald-50 text-emerald-700"
            : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
        }`}
      >
        {clearStatus.label}
      </button>
    </div>
  )
}

function Field({
  label,
  badge,
  inheritValue,
  children,
}: {
  label: string
  badge: "override" | "inherit"
  inheritValue?: string | null | undefined
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between px-0.5 text-[12px] font-medium tracking-[0.02em] text-slate-600">
        <span>{label}</span>
        {badge === "override" ? (
          <span className="rounded bg-amber-100 px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide text-amber-700">
            已覆盖
          </span>
        ) : (
          <span className="rounded bg-indigo-50 px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide text-indigo-500">
            继承{inheritValue ? ` · ${inheritValue}` : ""}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}
