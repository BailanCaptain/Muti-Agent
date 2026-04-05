"use client"

import { useFoldStore } from "@/components/stores/fold-store"
import { PROVIDERS, PROVIDER_ALIASES, type Provider } from "@multi-agent/shared"
import { Maximize2, Minimize2 } from "lucide-react"

const providerChipTheme: Record<Provider, { folded: string; open: string }> = {
  codex: {
    folded: "border-amber-400 bg-amber-100 text-amber-800",
    open: "border-amber-200/70 bg-white/80 text-amber-600 hover:bg-amber-50",
  },
  claude: {
    folded: "border-violet-400 bg-violet-100 text-violet-800",
    open: "border-violet-200/70 bg-white/80 text-violet-600 hover:bg-violet-50",
  },
  gemini: {
    folded: "border-sky-400 bg-sky-100 text-sky-800",
    open: "border-sky-200/70 bg-white/80 text-sky-600 hover:bg-sky-50",
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
    <div className="flex items-center gap-1 rounded-full border border-slate-200/80 bg-white/90 p-1 shadow-[0_12px_30px_rgba(15,23,42,0.08)] backdrop-blur">
      <button
        className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold text-slate-600 transition-colors hover:bg-slate-100"
        onClick={() => (allFolded ? unfoldAll() : foldAll())}
        title={allFolded ? "展开所有" : "折叠所有"}
        type="button"
      >
        {allFolded ? <Maximize2 className="h-3 w-3" /> : <Minimize2 className="h-3 w-3" />}
        <span>{allFolded ? "展开" : "折叠"}</span>
      </button>
      <span className="h-4 w-px bg-slate-200" />
      {PROVIDERS.map((provider) => {
        const folded = providerFolds[provider]
        const theme = providerChipTheme[provider]
        return (
          <button
            className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold transition-colors ${folded ? theme.folded : theme.open}`}
            key={provider}
            onClick={() => toggleProvider(provider)}
            title={
              folded ? `展开 ${PROVIDER_ALIASES[provider]}` : `折叠 ${PROVIDER_ALIASES[provider]}`
            }
            type="button"
          >
            {PROVIDER_ALIASES[provider]}
          </button>
        )
      })}
    </div>
  )
}
