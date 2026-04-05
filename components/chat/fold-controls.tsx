"use client"

import { useFoldStore } from "@/components/stores/fold-store"
import { PROVIDERS, PROVIDER_ALIASES, type Provider } from "@multi-agent/shared"
import { ChevronsDownUp, ChevronsUpDown, Layers } from "lucide-react"

const providerChipTheme: Record<Provider, { folded: string; open: string }> = {
  codex: {
    folded: "border-amber-300 bg-amber-100 text-amber-800",
    open: "border-amber-200/70 bg-amber-50/40 text-amber-700 hover:bg-amber-50",
  },
  claude: {
    folded: "border-violet-300 bg-violet-100 text-violet-800",
    open: "border-violet-200/70 bg-violet-50/40 text-violet-700 hover:bg-violet-50",
  },
  gemini: {
    folded: "border-sky-300 bg-sky-100 text-sky-800",
    open: "border-sky-200/70 bg-sky-50/40 text-sky-700 hover:bg-sky-50",
  },
}

export function FoldControls() {
  const providerFolds = useFoldStore((s) => s.providerFolds)
  const toggleProvider = useFoldStore((s) => s.toggleProvider)
  const foldAll = useFoldStore((s) => s.foldAll)
  const unfoldAll = useFoldStore((s) => s.unfoldAll)

  // When every provider is folded, the primary action flips to "unfold all" — users rarely want to
  // re-click "fold all" when there's nothing left to fold.
  const allFolded = PROVIDERS.every((provider) => providerFolds[provider])

  return (
    <div className="rounded-[28px] border border-slate-200/70 bg-white/85 p-4 shadow-[0_18px_42px_rgba(15,23,42,0.06)]">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-slate-400" />
          <h3 className="text-sm font-semibold text-slate-800">消息折叠</h3>
        </div>
        <button
          className="flex items-center gap-1 rounded-full border border-slate-200/80 bg-slate-50 px-2.5 py-1 text-[10px] font-semibold text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-800"
          onClick={() => (allFolded ? unfoldAll() : foldAll())}
          title={allFolded ? "展开所有 agent 消息" : "折叠所有 agent 消息"}
          type="button"
        >
          {allFolded ? (
            <ChevronsUpDown className="h-3 w-3" />
          ) : (
            <ChevronsDownUp className="h-3 w-3" />
          )}
          <span>{allFolded ? "全部展开" : "全部折叠"}</span>
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {PROVIDERS.map((provider) => {
          const folded = providerFolds[provider]
          const theme = providerChipTheme[provider]
          return (
            <button
              className={`flex flex-col items-center gap-1 rounded-2xl border px-2 py-2 text-[11px] font-semibold transition-colors ${folded ? theme.folded : theme.open}`}
              key={provider}
              onClick={() => toggleProvider(provider)}
              title={
                folded ? `展开 ${PROVIDER_ALIASES[provider]}` : `折叠 ${PROVIDER_ALIASES[provider]}`
              }
              type="button"
            >
              <span>{PROVIDER_ALIASES[provider]}</span>
              <span className="text-[9px] font-normal opacity-70">
                {folded ? "已折叠" : "展开中"}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
