"use client"

import { useRuntimeConfigStore } from "@/components/stores/runtime-config-store"
import type { Provider } from "@multi-agent/shared"
import { useEffect, useState } from "react"
import { useSaveStatus } from "./use-save-status"

type Props = { provider: Provider }

export function GlobalDefaultsTab({ provider }: Props) {
  const catalog = useRuntimeConfigStore((s) => s.catalog)
  const override = useRuntimeConfigStore((s) => s.config[provider])
  const setGlobalOverride = useRuntimeConfigStore((s) => s.setGlobalOverride)

  const [model, setModel] = useState(override?.model ?? "")
  const [effort, setEffort] = useState(override?.effort ?? "")

  // F021 P2 (范德彪 二轮 review): 切 provider 或异步到达的 override 必须同步到 input。
  useEffect(() => {
    setModel(override?.model ?? "")
    setEffort(override?.effort ?? "")
  }, [provider, override?.model, override?.effort])
  const save = useSaveStatus({ idle: "保存全局默认" })

  const providerCatalog = catalog?.[provider]
  const modelListId = `global-models-${provider}`

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-1.5 px-0.5 text-[11px] leading-relaxed text-slate-500">
        影响所有<b className="font-semibold text-slate-700">未来新建的</b>房间/会话 · 不改动任何当前运行中的会话
      </div>

      <Field label="默认模型">
        <input
          id={`global-model-${provider}`}
          aria-label="模型"
          list={modelListId}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="使用系统默认"
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

      <Field label="默认思考强度">
        <select
          id={`global-effort-${provider}`}
          aria-label="强度"
          value={effort}
          onChange={(e) => setEffort(e.target.value)}
          disabled={!providerCatalog?.efforts.length}
          className="w-full rounded-[10px] border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-900 outline-none transition focus:border-indigo-400 disabled:bg-slate-50 disabled:text-slate-400"
        >
          <option value="">默认</option>
          {providerCatalog?.efforts.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </Field>

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          disabled={save.isBusy}
          aria-busy={save.status === "saving"}
          onClick={() => void save.run(() => setGlobalOverride(provider, { model, effort }))}
          className={`flex-1 rounded-[10px] px-3 py-2.5 text-[12px] font-semibold transition disabled:cursor-not-allowed ${
            save.status === "saved"
              ? "bg-emerald-600 text-white disabled:bg-emerald-600 disabled:text-white"
              : "bg-slate-900 text-white hover:bg-slate-800 disabled:bg-slate-300 disabled:text-slate-500"
          }`}
        >
          {save.label}
        </button>
      </div>

      <div className="mt-3 rounded-[10px] border border-dashed border-amber-300 bg-amber-50 px-3 py-2.5 text-[11px] leading-relaxed text-slate-500">
        <b className="font-semibold text-amber-700">保守原则</b> · 全局默认保存后，当前正在跑的会话不会被动态改写。
        想改当前会话？切到「会话专属」Tab。
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between px-0.5 text-[12px] font-medium tracking-[0.02em] text-slate-600">
        <span>{label}</span>
      </div>
      {children}
    </div>
  )
}
