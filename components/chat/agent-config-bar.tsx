"use client"

import { useRuntimeConfigStore } from "@/components/stores/runtime-config-store"
import { PROVIDERS, PROVIDER_ALIASES, type Provider } from "@multi-agent/shared"
import { useEffect } from "react"

const providerTheme: Record<Provider, string> = {
  codex: "border-amber-200 bg-amber-50 text-amber-700",
  claude: "border-violet-200 bg-violet-50 text-violet-700",
  gemini: "border-sky-200 bg-sky-50 text-sky-700",
}

export function AgentConfigBar() {
  const catalog = useRuntimeConfigStore((state) => state.catalog)
  const config = useRuntimeConfigStore((state) => state.config)
  const loaded = useRuntimeConfigStore((state) => state.loaded)
  const load = useRuntimeConfigStore((state) => state.load)
  const setAgentOverride = useRuntimeConfigStore((state) => state.setAgentOverride)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  if (!catalog) return null

  return (
    <div className="flex flex-col gap-2 px-2 pt-1">
      {PROVIDERS.map((provider) => {
        const agentCatalog = catalog[provider]
        const override = config[provider] ?? {}
        const effortDisabled = agentCatalog.efforts.length === 0
        const listId = `${provider}-models`

        return (
          <div className="flex items-center gap-2" key={provider}>
            <span
              className={`w-16 shrink-0 rounded-full border px-2 py-0.5 text-center text-[10px] font-semibold ${providerTheme[provider]}`}
            >
              {PROVIDER_ALIASES[provider]}
            </span>

            <input
              className="flex-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 outline-none placeholder:text-slate-300 focus:border-slate-400"
              list={listId}
              onChange={(event) =>
                void setAgentOverride(provider, {
                  ...override,
                  model: event.target.value,
                })
              }
              placeholder={`默认（${agentCatalog.models[0]?.label ?? "model"})`}
              value={override.model ?? ""}
            />
            <datalist id={listId}>
              {agentCatalog.models.map((model) => (
                <option key={model.name} value={model.name}>
                  {model.label}
                </option>
              ))}
            </datalist>

            <select
              className="w-28 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 outline-none focus:border-slate-400 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
              disabled={effortDisabled}
              onChange={(event) =>
                void setAgentOverride(provider, {
                  ...override,
                  effort: event.target.value,
                })
              }
              title={effortDisabled ? "Gemini CLI 不支持推理强度" : "推理强度"}
              value={override.effort ?? ""}
            >
              <option value="">effort 默认</option>
              {agentCatalog.efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          </div>
        )
      })}
    </div>
  )
}
