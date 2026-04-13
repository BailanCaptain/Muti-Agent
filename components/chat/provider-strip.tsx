"use client"

import { useMemo, useState } from "react"
import { PROVIDERS, type Provider } from "@multi-agent/shared"
import { useChatStore } from "@/components/stores/chat-store"
import { useThreadStore } from "@/components/stores/thread-store"

const providerMeta: Record<
  Provider,
  { badge: string; label: string; tint: string; soft: string; ring: string }
> = {
  codex: {
    badge: "范",
    label: "Codex",
    tint: "from-amber-500 to-orange-600",
    soft: "bg-amber-50",
    ring: "border-amber-200",
  },
  claude: {
    badge: "黄",
    label: "Claude Code",
    tint: "from-violet-500 to-purple-600",
    soft: "bg-violet-50",
    ring: "border-violet-200",
  },
  gemini: {
    badge: "桂",
    label: "Gemini",
    tint: "from-sky-500 to-cyan-600",
    soft: "bg-sky-50",
    ring: "border-sky-200",
  },
}

function ProviderCard({
  provider,
}: {
  provider: Provider
}) {
  const card = useThreadStore((state) => state.providers[provider])
  const catalog = useThreadStore((state) => state.catalogs[provider])
  const updateModel = useThreadStore((state) => state.updateModel)
  const stopThread = useThreadStore((state) => state.stopThread)
  const setDraftRaw = useChatStore((state) => state.setDraft)
  const activeGroupId = useThreadStore((state) => state.activeGroupId)
  const setDraft = (draft: string | ((current: string) => string)) => setDraftRaw(activeGroupId, draft)
  const [draftModel, setDraftModel] = useState(card.currentModel ?? "")
  const meta = providerMeta[provider]

  return (
    <article className="grid gap-4 rounded-[24px] border border-black/5 bg-white/90 p-4 shadow-soft">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className={`flex h-12 w-12 items-center justify-center rounded-2xl border ${meta.ring} bg-gradient-to-br ${meta.tint} text-lg font-bold text-white shadow-sm`}
          >
            {meta.badge}
          </div>
          <div className="min-w-0">
            <h3 className="truncate font-serif text-xl">{card.alias}</h3>
            <p className="text-sm text-sand-700">{meta.label}</p>
          </div>
        </div>
        <span
          className={`rounded-full border border-black/5 px-3 py-1 text-xs font-semibold ${
            card.running ? "bg-amber-100 text-amber-800" : "bg-sand-100 text-sand-700"
          }`}
        >
          {card.running ? "生成中" : "空闲"}
        </span>
      </div>

      <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-2">
        <div className={`rounded-2xl ${meta.soft} p-3`}>
          <div className="text-xs text-sand-700">当前模型</div>
          <div className="mt-1 truncate font-semibold">{card.currentModel ?? "未设置"}</div>
        </div>
        <div className={`rounded-2xl ${meta.soft} p-3`}>
          <div className="text-xs text-sand-700">额度概览</div>
          <div className="mt-1 truncate font-semibold">{card.quotaSummary}</div>
        </div>
        <div className="rounded-2xl bg-sand-50 p-3 md:col-span-3 xl:col-span-2">
          <div className="text-xs text-sand-700">最近消息</div>
          <div className="mt-1 truncate text-sm text-sand-900">{card.preview}</div>
        </div>
      </div>

      <div className="grid gap-2">
        <input
          className="rounded-2xl border border-black/10 bg-white px-3 py-2 text-sm outline-none"
          list={`model-suggestions-${provider}`}
          onChange={(event) => setDraftModel(event.target.value)}
          placeholder="输入或选择模型"
          value={draftModel}
        />
        <datalist id={`model-suggestions-${provider}`}>
          {catalog.modelSuggestions.map((model) => (
            <option key={`${provider}-${model}`} value={model} />
          ))}
        </datalist>

        <div className="grid grid-cols-3 gap-2">
          <button
            className="rounded-full border border-black/10 bg-white/80 px-3 py-2 text-xs font-semibold"
            onClick={() => setDraft((current) => `@${card.alias} ${current}`.trim())}
            type="button"
          >
            @Ta
          </button>
          <button
            className="rounded-full border border-black/10 bg-white/80 px-3 py-2 text-xs font-semibold"
            onClick={() => void stopThread(provider)}
            type="button"
          >
            停止
          </button>
          <button
            className="rounded-full bg-sand-500 px-3 py-2 text-xs font-semibold text-white"
            onClick={() => void updateModel(provider, draftModel)}
            type="button"
          >
            保存模型
          </button>
        </div>
      </div>
    </article>
  )
}

export function ProviderStrip() {
  const refresh = useThreadStore((state) => state.bootstrap)
  const createGroup = useThreadStore((state) => state.createSessionGroup)
  const cards = useMemo(() => PROVIDERS, [])

  return (
    <section className="rounded-[28px] border border-black/5 bg-white/75 p-5 shadow-soft backdrop-blur">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.28em] text-sand-500">角色面板</p>
          <h2 className="font-serif text-2xl">当前会话的三位角色</h2>
        </div>
        <div className="flex gap-2">
          <button
            className="rounded-full border border-black/10 bg-white/80 px-4 py-2 text-sm font-semibold"
            onClick={() => void refresh()}
            type="button"
          >
            刷新
          </button>
          <button
            className="rounded-full bg-sand-500 px-4 py-2 text-sm font-semibold text-white"
            onClick={() => void createGroup()}
            type="button"
          >
            新建三方会话
          </button>
        </div>
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        {cards.map((provider) => (
          <ProviderCard key={provider} provider={provider} />
        ))}
      </div>
    </section>
  )
}
