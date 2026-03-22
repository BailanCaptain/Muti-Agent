"use client"

import { useChatStore } from "@/components/stores/chat-store"
import { useThreadStore } from "@/components/stores/thread-store"
import { PROVIDERS, type Provider } from "@multi-agent/shared"
import { Send, Square } from "lucide-react"

const mentionTheme: Record<Provider, string> = {
  codex: "border-amber-200/80 bg-amber-50 text-amber-700 hover:bg-amber-100",
  claude: "border-violet-200/80 bg-violet-50 text-violet-700 hover:bg-violet-100",
  gemini: "border-emerald-200/80 bg-emerald-50 text-emerald-700 hover:bg-emerald-100",
}

export function Composer() {
  const value = useChatStore((state) => state.draft)
  const setDraft = useChatStore((state) => state.setDraft)
  const send = useChatStore((state) => state.sendMessage)
  const status = useChatStore((state) => state.status)
  const activeGroup = useThreadStore((state) => state.activeGroup)
  const providers = useThreadStore((state) => state.providers)
  const stopThread = useThreadStore((state) => state.stopThread)

  const runningProviders = PROVIDERS.filter((provider) => providers[provider].running)
  const hasRunningProvider = runningProviders.length > 0
  const isBusy = hasRunningProvider || Boolean(activeGroup?.hasPendingDispatches)

  function handleStop() {
    if (runningProviders.length > 0) {
      for (const provider of runningProviders) {
        void stopThread(provider)
      }
      return
    }
    // 没有 running provider 但队列里还有待执行任务——发给任意一个线程来取消整组
    const anyProvider = PROVIDERS.find((p) => providers[p].threadId)
    if (anyProvider) {
      void stopThread(anyProvider)
    }
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-[30px] border border-slate-200/80 bg-white/90 p-4 shadow-[0_20px_50px_rgba(15,23,42,0.08)] backdrop-blur"
      onSubmit={(event) => {
        event.preventDefault()
        if (!value.trim() || isBusy) {
          return
        }

        void send(value)
      }}
    >
      <div className="flex flex-wrap gap-2 px-2">
        {PROVIDERS.map((provider) => {
          const mention = `@${provider}`

          return (
            <button
              className={`rounded-full border px-3 py-1 text-[10px] font-semibold transition-colors ${mentionTheme[provider]}`}
              key={mention}
              onClick={() => setDraft((current) => `${mention} ${current}`.trim())}
              type="button"
            >
              {mention}
            </button>
          )
        })}
      </div>

      <div className="relative flex items-end gap-2 px-2 pb-2">
        <textarea
          className="max-h-48 w-full resize-none bg-transparent py-2 text-sm text-slate-700 outline-none placeholder:text-slate-300"
          onChange={(event) => {
            setDraft(event.target.value)
            event.target.style.height = "auto"
            event.target.style.height = `${event.target.scrollHeight}px`
          }}
          placeholder="Type a prompt. Use @codex, @claude, or @gemini to route the message."
          rows={1}
          value={value}
        />

        {isBusy ? (
          <button
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-500 text-white shadow-lg shadow-rose-500/20 transition-all hover:bg-rose-600 active:scale-95"
            onClick={handleStop}
            type="button"
          >
            <Square className="h-4 w-4 fill-current" />
          </button>
        ) : (
          <button
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500 text-white shadow-lg shadow-amber-500/20 transition-all hover:bg-amber-600 active:scale-95 disabled:bg-slate-200 disabled:shadow-none"
            disabled={!value.trim() || isBusy}
            type="submit"
          >
            <Send className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="px-2 text-[11px] text-slate-400">
        {status || "Ready for the next multi-agent turn."}
      </div>
    </form>
  )
}
