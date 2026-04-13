"use client"

import { useChatStore } from "@/components/stores/chat-store"
import { useThreadStore } from "@/components/stores/thread-store"
import { AGENT_PROFILES, PROVIDERS, PROVIDER_ALIASES, type Provider } from "@multi-agent/shared"
import { Send, Square } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

const mentionTheme: Record<Provider, string> = {
  codex: "border-amber-200/80 bg-amber-50 text-amber-700 hover:bg-amber-100",
  claude: "border-violet-200/80 bg-violet-50 text-violet-700 hover:bg-violet-100",
  gemini: "border-sky-200/80 bg-sky-50 text-sky-700 hover:bg-sky-100",
}

const everyoneTheme = "border-slate-200/80 bg-slate-50 text-slate-700 hover:bg-slate-100"

type Suggestion =
  | { kind: "provider"; provider: Provider; label: string; role: string }
  | { kind: "everyone"; label: string; role: string }

const SUGGESTIONS: Suggestion[] = [
  ...PROVIDERS.map(
    (provider): Suggestion => ({
      kind: "provider",
      provider,
      label: PROVIDER_ALIASES[provider],
      role: AGENT_PROFILES[provider].role,
    }),
  ),
  { kind: "everyone", label: "所有人", role: "拉起三个 CLI 并行" },
]

type MentionContext = {
  start: number // index of '@'
  query: string // text after '@' up to cursor
}

/** Find the active @mention token the cursor is editing, if any. */
function findMentionContext(value: string, cursor: number): MentionContext | null {
  // Walk backwards from cursor to find the nearest '@' that starts a mention token.
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = value[i]
    if (ch === "@") {
      // '@' must be at start or preceded by whitespace/punctuation so we don't hijack emails etc.
      const prev = i > 0 ? value[i - 1] : ""
      if (prev && !/[\s(（【\[]/.test(prev)) {
        return null
      }
      const query = value.slice(i + 1, cursor)
      // Stop if the query already contains whitespace — that means we're past the mention.
      if (/\s/.test(query)) return null
      return { start: i, query }
    }
    // Abort if we hit a non-mention character (whitespace breaks the token).
    if (/\s/.test(ch)) return null
  }
  return null
}

function filterSuggestions(query: string): Suggestion[] {
  if (!query) return SUGGESTIONS
  const lower = query.toLowerCase()
  return SUGGESTIONS.filter((item) => {
    if (item.label.toLowerCase().startsWith(lower)) return true
    if (item.kind === "provider" && item.provider.toLowerCase().startsWith(lower)) return true
    return false
  })
}

export function Composer() {
  const activeGroupId = useThreadStore((state) => state.activeGroupId)
  const value = useChatStore((state) => state.drafts[activeGroupId ?? ""] ?? "")
  const setDraftRaw = useChatStore((state) => state.setDraft)
  const setDraft = (draft: string | ((current: string) => string)) => setDraftRaw(activeGroupId, draft)
  const send = useChatStore((state) => state.sendMessage)
  const status = useChatStore((state) => state.status)
  const activeGroup = useThreadStore((state) => state.activeGroup)
  const providers = useThreadStore((state) => state.providers)
  const stopThread = useThreadStore((state) => state.stopThread)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [cursor, setCursor] = useState(0)
  const [highlight, setHighlight] = useState(0)

  const runningProviders = PROVIDERS.filter((provider) => providers[provider].running)
  const hasRunningProvider = runningProviders.length > 0
  const isBusy = hasRunningProvider || Boolean(activeGroup?.hasPendingDispatches)

  const mentionContext = useMemo(() => findMentionContext(value, cursor), [value, cursor])
  const suggestions = useMemo(
    () => (mentionContext ? filterSuggestions(mentionContext.query) : []),
    [mentionContext],
  )
  const showSuggestions = Boolean(mentionContext) && suggestions.length > 0

  // Keep highlight in range whenever the suggestion list changes.
  useEffect(() => {
    if (highlight >= suggestions.length) setHighlight(0)
  }, [suggestions.length, highlight])

  function applySuggestion(suggestion: Suggestion) {
    if (!mentionContext) return
    const before = value.slice(0, mentionContext.start)
    const after = value.slice(mentionContext.start + 1 + mentionContext.query.length)
    const insert = `@${suggestion.label} `
    const nextValue = `${before}${insert}${after}`
    const nextCursor = (before + insert).length

    setDraft(nextValue)

    // Restore cursor after React commits the new value.
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.selectionStart = nextCursor
      el.selectionEnd = nextCursor
      el.focus()
      el.style.height = "auto"
      el.style.height = `${el.scrollHeight}px`
      setCursor(nextCursor)
    })
  }

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

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (showSuggestions) {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setHighlight((h) => (h + 1) % suggestions.length)
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault()
        applySuggestion(suggestions[highlight])
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        // Dismiss by pretending cursor moved elsewhere — easiest is to kill the current query match
        // by inserting a trailing space. Simpler: blur + refocus pattern is awkward; instead we just
        // bump cursor past any '@' by clearing the mention context via a no-op: append a space.
        // Keep it simple: move cursor to end to break the context.
        const el = textareaRef.current
        if (el) {
          const end = value.length
          el.selectionStart = end
          el.selectionEnd = end
          setCursor(end)
        }
        return
      }
    }

    // Submit on Enter (without shift) when suggestions are closed.
    if (event.key === "Enter" && !event.shiftKey && !showSuggestions) {
      event.preventDefault()
      if (!value.trim() || isBusy) return
      void send(value)
    }
  }

  function handleSelect(event: React.SyntheticEvent<HTMLTextAreaElement>) {
    setCursor(event.currentTarget.selectionStart ?? 0)
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
      {hasRunningProvider && (
        <div className="flex items-center gap-2 px-2 pt-1">
          <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
          <span className="text-[11px] font-medium text-amber-600">智能体正在回复中...</span>
          <span className="text-[11px] text-slate-400">继续输入，消息将自动排队。</span>
        </div>
      )}

      <div className="relative flex items-end gap-2 px-2 pb-2">
        <textarea
          className="max-h-48 w-full resize-none bg-transparent py-2 text-sm text-slate-700 outline-none placeholder:text-slate-300"
          onChange={(event) => {
            setDraft(event.target.value)
            setCursor(event.target.selectionStart ?? event.target.value.length)
            event.target.style.height = "auto"
            event.target.style.height = `${event.target.scrollHeight}px`
          }}
          onKeyDown={handleKeyDown}
          onSelect={handleSelect}
          placeholder={
            isBusy ? "继续输入指令...（消息将自动排队）" : "输入你的指令。使用 @ 可唤起智能体列表。"
          }
          ref={textareaRef}
          rows={1}
          value={value}
        />

        {showSuggestions && (
          // The textarea stays focused and drives keyboard navigation; this popup is purely visual.
          <div className="absolute bottom-full left-2 z-20 mb-2 w-64 overflow-hidden rounded-2xl border border-slate-200 bg-white/95 shadow-[0_20px_50px_rgba(15,23,42,0.12)] backdrop-blur">
            {suggestions.map((item, index) => {
              const active = index === highlight
              const theme = item.kind === "provider" ? mentionTheme[item.provider] : everyoneTheme
              return (
                <button
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                    active ? "bg-slate-100" : "bg-transparent hover:bg-slate-50"
                  }`}
                  key={item.label}
                  onClick={() => applySuggestion(item)}
                  onMouseEnter={() => setHighlight(index)}
                  // Prevent textarea from losing focus on mousedown so cursor state is preserved.
                  onMouseDown={(e) => e.preventDefault()}
                  type="button"
                >
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${theme}`}
                  >
                    @{item.label}
                  </span>
                  <span className="text-[11px] text-slate-500">{item.role}</span>
                </button>
              )
            })}
          </div>
        )}

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
        {status || "就绪，等待下一次多智能体协作。"}
      </div>
    </form>
  )
}
