"use client"

import { useChatStore } from "@/components/stores/chat-store"
import { selectIsBusyForActiveGroup, useThreadStore } from "@/components/stores/thread-store"
import { AGENT_PROFILES, PROVIDERS, PROVIDER_ALIASES, type Provider } from "@multi-agent/shared"
import { Clock3, ImagePlus, ListPlus, Send, Square, Users, X, Zap } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { mentionTheme, EVERYONE_THEME as everyoneTheme } from "../theme"
import { planQueueFlush, resolveLatchAfterSend } from "./queue-flush"
import { ProviderAvatar } from "./provider-avatar"
import {
  IngestModal,
  type IngestModalFile,
} from "./right-panel/runtime-log/ingest-modal/ingest-modal"
import {
  SlashCommandMenu,
  type SlashCommand,
  filterSlashCommands,
  findSlashContext,
  nextHighlightOnKey,
} from "./composer-slash-menu"

const PROVIDER_ACCENT_TEXT: Record<Provider, string> = {
  claude: "text-violet-700",
  codex: "text-amber-700",
  gemini: "text-sky-700",
}

type QueuedMention =
  | { kind: "provider"; provider: Provider; label: string }
  | { kind: "everyone"; label: string }

function parseFirstMention(text: string): QueuedMention | null {
  const m = text.match(/@([^\s@,，。!?！？:：]+)/)
  if (!m) return null
  const label = m[1]
  if (label === "所有人") return { kind: "everyone", label: "所有人" }
  for (const p of PROVIDERS) {
    if (PROVIDER_ALIASES[p] === label || p === label) {
      return { kind: "provider", provider: p, label: PROVIDER_ALIASES[p] }
    }
  }
  return null
}

function stripLeadingMention(text: string, mention: QueuedMention | null): string {
  if (!mention) return text
  return text.replace(new RegExp(`^\\s*@${mention.label}\\s*`), "").trim() || text
}

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
  start: number
  query: string
}

function findMentionContext(value: string, cursor: number): MentionContext | null {
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = value[i]
    if (ch === "@") {
      const prev = i > 0 ? value[i - 1] : ""
      if (prev && !/[\s(（【\[]/.test(prev)) {
        return null
      }
      const query = value.slice(i + 1, cursor)
      if (/\s/.test(query)) return null
      return { start: i, query }
    }
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

const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]

// F027 Phase 3 Day 19b-2 · AC-P3-6 入口 A: composer 拖文件 → IngestModal
// 拖图片 → 原 addFiles 走 ACCEPTED_IMAGE_TYPES; 拖非图片 .md/.json/.txt → IngestModal
const ACCEPTED_INGEST_EXTENSIONS = [".md", ".markdown", ".json", ".txt"]
const MAX_INGEST_BYTES = 1_048_576 // 1MB (与 contracts.MAX_INGEST_CONTENT_BYTES 一致)

function isIngestFile(file: File): boolean {
  const lower = file.name.toLowerCase()
  return ACCEPTED_INGEST_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * F027 Phase 3 Day 19b-1+2 · callerAlias 来源 (与 knowledge-base-tab 一致)
 * Phase 3 无 user session store, Phase 4 接真 auth 时移除此 hack。
 */
function getCurrentUserAlias(): string {
  return process.env.NEXT_PUBLIC_USER_ALIAS ?? "小孙"
}

const EMPTY_PENDING_IMAGES: { url: string; file: File }[] = []

// F026-P0 Day7 · 双模式 composer：
//   immediate（默认）= 不管当前 turn 是否还在跑，新消息立即发出，进后端 dispatch queue 自然排队
//   queue            = 点 Send 仍然可点；busy 时消息入前端 buffer，等 busy 清空后自动 flush
//                       依次发出。user 体验 = "我提交了、不用等"，屏幕上一次只显示一个 running turn。
type SendMode = "immediate" | "queue"
const SEND_MODE_KEY = "composer.sendMode"

type QueuedMessage = { id: string; text: string }

function loadSendMode(): SendMode {
  if (typeof window === "undefined") return "immediate"
  const v = window.localStorage.getItem(SEND_MODE_KEY)
  return v === "queue" ? "queue" : "immediate"
}

export function Composer() {
  const activeGroupId = useThreadStore((state) => state.activeGroupId)
  const value = useChatStore((state) => state.drafts[activeGroupId ?? ""] ?? "")
  const setDraftRaw = useChatStore((state) => state.setDraft)
  const setDraft = (draft: string | ((current: string) => string)) => setDraftRaw(activeGroupId, draft)
  const send = useChatStore((state) => state.sendMessage)
  const setStatus = useChatStore((state) => state.setStatus)
  const status = useChatStore((state) => state.status)
  const activeGroup = useThreadStore((state) => state.activeGroup)
  const providers = useThreadStore((state) => state.providers)
  const stopThread = useThreadStore((state) => state.stopThread)
  const pendingImages = useChatStore(
    (state) => state.pendingImages[activeGroupId ?? ""] ?? EMPTY_PENDING_IMAGES,
  )
  const addPendingImage = useChatStore((state) => state.addPendingImage)
  const clearPendingImages = useChatStore((state) => state.clearPendingImages)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [cursor, setCursor] = useState(0)
  const [highlight, setHighlight] = useState(0)

  const runningProviders = PROVIDERS.filter((provider) => providers[provider].running)
  const hasRunningProvider = runningProviders.length > 0
  // F026 P0 Day1 · isBusy 只看 activeGroup.hasPendingDispatches（不含 hasRunningProvider）
  // hasRunningProvider 仅用于下方 Stop 按钮显示，不再参与 send disable。
  const isBusy = useThreadStore(selectIsBusyForActiveGroup)

  // 排队判断用的"turn 还在跑"语义 = provider 正在流 或 dispatch 待调度。
  // Why: 仁勋流式生成中、dispatch 已被 take → isBusy=false 但 UI banner 显示"回复中"，
  // 此时排队若只看 isBusy 会直发（小孙实测 bug）。
  // 注意：hasRunningProvider 是全局（不分 group），所以切到另一房间时它可能仍 true；
  // 这只是避免误 flush，不会误入队到错误 group（入队绑当前 activeGroupId，见 queuedByGroup）。
  const isTurnLive = hasRunningProvider || isBusy

  // F026 P0 Day7 · 双模式 send：
  //   immediate：value 直接 send() 到后端（后端 dispatch queue 接）
  //   queue + turn live：value 入 queuedByGroup[activeGroupId] 本地 buffer
  //   queue + idle：跟 immediate 一样直接发
  const [sendMode, setSendModeState] = useState<SendMode>(() => "immediate")
  useEffect(() => { setSendModeState(loadSendMode()) }, [])
  const setSendMode = useCallback((mode: SendMode) => {
    setSendModeState(mode)
    if (typeof window !== "undefined") window.localStorage.setItem(SEND_MODE_KEY, mode)
  }, [])
  // 按 groupId 分桶存队列，防止切 room 时 flush 串到其它 group（小孙 R-022→R-021/023 串房实测 bug）。
  const [queuedByGroup, setQueuedByGroup] = useState<Record<string, QueuedMessage[]>>({})
  const queuedMessages = queuedByGroup[activeGroupId ?? ""] ?? []

  // Flush 策略：只要"当前 activeGroup 的桶非空 + 当前 group idle (!isTurnLive)"
  // + 当前 group 没在等上一次 flush 触发的 turn 起来 → 就发队首。
  // Why 不用下降沿 prevRef：切 room 时 activeGroupId 变、isTurnLive 也会突变，
  // prev ref 方案会把"切房"当成 turn 结束误 flush；effect-driven 直判 idle 既处理
  // 同 room turn 完成、也处理"切回有遗留队列的 room"。
  // Why 不串房：flush 瞬间 activeGroupId === 桶 key，store.sendMessage 同步读取
  // threadState.activeGroupId → 与桶 key 一致。
  // Why latch：store.sendMessage 只 WS 吼一声就 return，activeGroup.hasPendingDispatches
  // 要等 WS 回推才更新。没 latch 时 setQueuedByGroup 触发下一轮 effect，isTurnLive
  // 仍 false → 连发第二条（小孙实测"两条一下出去"bug）。
  // F026 P0 · review P1-2 修复：latch 从全局 boolean 升级为 per-group Set —
  // 切房不再串锁，且 sendMessage rejected 时 (resolveLatchAfterSend) 立即清该
  // group 的 latch，杜绝 validation fail 后永久卡死。
  const [awaitingLatch, setAwaitingLatch] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    if (!activeGroupId) return
    if (!isTurnLive) return
    if (!awaitingLatch.has(activeGroupId)) return
    setAwaitingLatch((prev) => {
      if (!prev.has(activeGroupId)) return prev
      const next = new Set(prev)
      next.delete(activeGroupId)
      return next
    })
  }, [isTurnLive, activeGroupId, awaitingLatch])

  useEffect(() => {
    const bucket = queuedByGroup[activeGroupId ?? ""] ?? []
    const decision = planQueueFlush({ activeGroupId, isTurnLive, awaitingLatch, bucket })
    if (decision.kind !== "flush") return
    const gid = activeGroupId!
    const message = decision.message
    setQueuedByGroup((prev) => ({
      ...prev,
      [gid]: (prev[gid] ?? []).filter((m) => m.id !== message.id),
    }))
    setAwaitingLatch((prev) => {
      if (prev.has(gid)) return prev
      const next = new Set(prev)
      next.add(gid)
      return next
    })
    void (async () => {
      const result = await send(message.text)
      setAwaitingLatch((prev) => resolveLatchAfterSend(prev, gid, result))
      // rejected 且不是 validation 错 → 放回队头等用户重试；validation 错时 status
      // 已在 chat-store 设置提示，消息本身丢弃避免死循环。
      if (!result.accepted && result.reason !== "validation") {
        setQueuedByGroup((prev) => ({
          ...prev,
          [gid]: [message, ...(prev[gid] ?? [])],
        }))
      }
    })()
  }, [activeGroupId, isTurnLive, queuedByGroup, awaitingLatch, send])

  const mentionContext = useMemo(() => findMentionContext(value, cursor), [value, cursor])
  const suggestions = useMemo(
    () => (mentionContext ? filterSuggestions(mentionContext.query) : []),
    [mentionContext],
  )
  const showSuggestions = Boolean(mentionContext) && suggestions.length > 0

  useEffect(() => {
    if (highlight >= suggestions.length) setHighlight(0)
  }, [suggestions.length, highlight])

  // F027 Phase 3 Day 19c-2 · AC-P3-6 入口 C: composer / 命令面板
  // mention `@` 优先 (showSuggestions); 无 mention 时才检测 slash `/`
  const slashContext = useMemo(
    () => (mentionContext ? null : findSlashContext(value, cursor)),
    [value, cursor, mentionContext],
  )
  const slashCommands = useMemo(
    () => (slashContext ? filterSlashCommands(slashContext.query) : []),
    [slashContext],
  )
  // Day 19c r2 P2 fix (范-r1): dismissed state, key = (start, query) 二元组
  // 防 end-of-input 时 cursor 不能移走 → slashContext 仍 truthy → Escape/outside click 失效
  // 文本/cursor 变化生成新 key → dismissed 自动失效 (重新打开 menu)
  const [dismissedSlashKey, setDismissedSlashKey] = useState<string | null>(null)
  const currentSlashKey = slashContext
    ? `${slashContext.start}:${slashContext.query}`
    : null
  const showSlashMenu =
    Boolean(slashContext) && slashCommands.length > 0 && currentSlashKey !== dismissedSlashKey
  const [slashHighlight, setSlashHighlight] = useState(0)
  // 默认 highlight 跳到第一个 enabled command
  useEffect(() => {
    if (slashCommands.length === 0) return
    const firstEnabled = slashCommands.findIndex((c) => c.enabled)
    setSlashHighlight(firstEnabled >= 0 ? firstEnabled : 0)
  }, [slashCommands])

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) continue
        const url = URL.createObjectURL(file)
        addPendingImage(activeGroupId, { url, file })
      }
    },
    [activeGroupId, addPendingImage],
  )

  // F027 Phase 3 Day 19b-2 · AC-P3-6 入口 A: composer 拖文件 → IngestModal
  const [dragOver, setDragOver] = useState(false)
  const [ingestModalFile, setIngestModalFile] = useState<IngestModalFile | null>(null)
  const [ingestDropError, setIngestDropError] = useState<string | null>(null)
  const dragCounterRef = useRef(0) // 防 child enter/leave 抖动

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLFormElement>) => {
    e.preventDefault()
    dragCounterRef.current += 1
    if (e.dataTransfer.types.includes("Files")) setDragOver(true)
  }, [])
  const handleDragOver = useCallback((e: React.DragEvent<HTMLFormElement>) => {
    e.preventDefault() // 必须 preventDefault 才能触发 drop
  }, [])
  const handleDragLeave = useCallback((e: React.DragEvent<HTMLFormElement>) => {
    e.preventDefault()
    dragCounterRef.current -= 1
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0
      setDragOver(false)
    }
  }, [])
  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLFormElement>) => {
      e.preventDefault()
      dragCounterRef.current = 0
      setDragOver(false)
      setIngestDropError(null)
      const files = Array.from(e.dataTransfer.files)
      if (files.length === 0) return

      // 分流: 图片走 addFiles (走原 pendingImages); ingest 文件走 IngestModal
      const imageFiles = files.filter((f) => ACCEPTED_IMAGE_TYPES.includes(f.type))
      const ingestFiles = files.filter((f) => isIngestFile(f))
      const rejected = files.filter(
        (f) => !ACCEPTED_IMAGE_TYPES.includes(f.type) && !isIngestFile(f),
      )

      if (imageFiles.length > 0) addFiles(imageFiles)

      if (rejected.length > 0) {
        setIngestDropError(
          `拒收 ${rejected.length} 个文件 (限图片或 .md/.markdown/.json/.txt): ${rejected.map((f) => f.name).join(", ")}`,
        )
      }

      // Phase 3 Day 19b-2: 单文件 ingest only (multi-drop chained 防误检 Phase 4)
      if (ingestFiles.length === 0) return
      if (ingestFiles.length > 1) {
        setIngestDropError(
          `多文件 ingest Phase 4 接 series_id, 当前只取第一个: ${ingestFiles[0].name}`,
        )
      }
      const file = ingestFiles[0]
      if (file.size > MAX_INGEST_BYTES) {
        setIngestDropError(`文件过大: ${file.name} (${Math.round(file.size / 1024)}KB > 1MB)`)
        return
      }
      try {
        const content = await file.text()
        setIngestModalFile({ name: file.name, content, sizeBytes: file.size })
      } catch (err) {
        setIngestDropError(`读取失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [addFiles],
  )

  const handleIngestModalClose = useCallback(() => {
    setIngestModalFile(null)
  }, [])

  // F027 Phase 3 Day 19c-2 · /ingest 选中 → 触发隐藏 ingest file picker
  const ingestFileInputRef = useRef<HTMLInputElement>(null)
  const handleIngestFilePicked = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ""
      if (!file) return
      if (!isIngestFile(file)) {
        setIngestDropError(`不支持的文件类型：${file.name}`)
        return
      }
      if (file.size > MAX_INGEST_BYTES) {
        setIngestDropError(`文件过大：${file.name}`)
        return
      }
      try {
        const content = await file.text()
        setIngestModalFile({ name: file.name, content, sizeBytes: file.size })
      } catch (err) {
        setIngestDropError(`读取失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [],
  )

  // / 选中 → 清 textarea 里的 /xxx + 触发 file picker (ingest only Phase 3)
  const applySlashCommand = useCallback(
    (cmd: SlashCommand) => {
      if (!cmd.enabled || !slashContext) return
      // 清除 /xxx 字符
      const before = value.slice(0, slashContext.start)
      const after = value.slice(slashContext.start + 1 + slashContext.query.length)
      setDraft(`${before}${after}`)
      const nextCursor = before.length
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (el) {
          el.selectionStart = nextCursor
          el.selectionEnd = nextCursor
          el.focus()
        }
        setCursor(nextCursor)
      })
      // 触发对应动作 (Phase 3 只 ingest)
      if (cmd.key === "ingest") {
        ingestFileInputRef.current?.click()
      }
    },
    [slashContext, value, setDraft],
  )

  // Day 19c r2 P2 fix: 改用 dismissedSlashKey state, end-of-input 也能 dismiss
  // (cursor 移末尾不再有效 — cursor 已经在末尾时 slashContext 仍存在)
  const handleSlashMenuClose = useCallback(() => {
    if (currentSlashKey) setDismissedSlashKey(currentSlashKey)
  }, [currentSlashKey])

  function applySuggestion(suggestion: Suggestion) {
    if (!mentionContext) return
    const before = value.slice(0, mentionContext.start)
    const after = value.slice(mentionContext.start + 1 + mentionContext.query.length)
    const insert = `@${suggestion.label} `
    const nextValue = `${before}${insert}${after}`
    const nextCursor = (before + insert).length

    setDraft(nextValue)

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

  // 统一提交入口：queue 模式 + turn live + 纯文本 → 入前端 buffer；其他情况 → 直接 send()。
  // 图片消息不进前端队列（图片附件语义复杂，简化为直发）。
  const submitMessage = useCallback((textValue: string) => {
    const hasText = textValue.trim().length > 0
    const hasImages = pendingImages.length > 0
    if (!hasText && !hasImages) return
    if (sendMode === "queue" && isTurnLive && hasText && !hasImages && activeGroupId) {
      // F026 P0 · review P1-2 修复：入队前先 validate，避免非法消息进队后
      // sendMessage 校验 fail / latch 永不清。校验逻辑与 chat-store.sendMessage
      // 的 preValidation 保持一致（buildSendPayload 返回 null = 没 @ 到 agent）。
      const threadState = useThreadStore.getState()
      const preValidation = threadState.buildSendPayload(textValue)
      if (!preValidation) {
        setStatus("请用 @ 指定智能体：@黄仁勋 / @范德彪 / @桂芬 / @所有人")
        return
      }
      const id =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const gid = activeGroupId
      setQueuedByGroup((prev) => ({
        ...prev,
        [gid]: [...(prev[gid] ?? []), { id, text: textValue }],
      }))
      setDraft("")
      const el = textareaRef.current
      if (el) el.style.height = "auto"
      return
    }
    void send(textValue)
  }, [sendMode, isTurnLive, pendingImages.length, send, setDraft, setStatus, activeGroupId])

  function removeQueuedMessage(id: string) {
    if (!activeGroupId) return
    const gid = activeGroupId
    setQueuedByGroup((prev) => ({
      ...prev,
      [gid]: (prev[gid] ?? []).filter((m) => m.id !== id),
    }))
  }

  function handleStop() {
    if (runningProviders.length > 0) {
      for (const provider of runningProviders) {
        void stopThread(provider)
      }
      return
    }
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

    // F027 Phase 3 Day 19c-2 · slash menu 键盘导航 (mention 优先, slash 次之)
    if (showSlashMenu) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const next = nextHighlightOnKey(event.key, slashCommands, slashHighlight)
        if (next !== null) {
          event.preventDefault()
          setSlashHighlight(next)
        }
        return
      }
      if (event.key === "Enter" || event.key === "Tab") {
        // Day 19c r2 P3 fix (范-r1): slash menu open 时 Enter/Tab 始终 preventDefault
        // 防 disabled command 漏出 native textarea Enter (换行) / Tab (跳焦点)
        event.preventDefault()
        const cmd = slashCommands[slashHighlight]
        if (cmd?.enabled) {
          applySlashCommand(cmd)
        }
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        handleSlashMenuClose()
        return
      }
    }

    // F033 AC4: 中文 IME 组合态的 Enter 是候选确认，不是发送（clowder B3 教训）
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      !showSuggestions &&
      !showSlashMenu
    ) {
      event.preventDefault()
      submitMessage(value)
    }
  }

  function handleSelect(event: React.SyntheticEvent<HTMLTextAreaElement>) {
    setCursor(event.currentTarget.selectionStart ?? 0)
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = event.clipboardData?.files
    if (files && files.length > 0) {
      const imageFiles = Array.from(files).filter((f) => ACCEPTED_IMAGE_TYPES.includes(f.type))
      if (imageFiles.length > 0) {
        event.preventDefault()
        addFiles(imageFiles)
      }
    }
  }

  return (
    <>
    <form
      className={`flex flex-col gap-3 rounded-panel border bg-surface-sunken p-4 transition-colors ${
        dragOver
          ? "border-accent-400 bg-accent-50 ring-2 ring-accent-200"
          : "border-slate-200 focus-within:border-slate-300"
      }`}
      data-testid="composer-form"
      data-drag-over={dragOver ? "true" : "false"}
      onSubmit={(event) => {
        event.preventDefault()
        submitMessage(value)
      }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div
          className="rounded-2xl border-2 border-accent-300 border-dashed bg-accent-50 px-4 py-2 text-center text-[11px] text-accent-700"
          data-testid="composer-drag-hint"
        >
          📎 拖入 .md / .markdown / .json / .txt → IngestModal；图片 → 附件
        </div>
      )}
      {ingestDropError && (
        <div
          className="rounded-xl border border-red-200 bg-red-50 px-3 py-1.5 text-[11px] text-red-600"
          data-testid="composer-ingest-drop-error"
        >
          ⚠ {ingestDropError}
          <button
            type="button"
            onClick={() => setIngestDropError(null)}
            className="ml-2 text-red-400 hover:text-red-600"
            aria-label="关闭提示"
          >
            ✕
          </button>
        </div>
      )}
      {hasRunningProvider && (
        <div className="flex items-center gap-2 px-2 pt-1">
          <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
          <span className="text-[11px] font-medium text-amber-600">智能体正在回复中...</span>
          {sendMode === "immediate" && (
            <span className="text-[11px] text-slate-400">立即模式：新消息会立刻发出。</span>
          )}
          {sendMode === "queue" && queuedMessages.length === 0 && (
            <span className="text-[11px] text-slate-400">
              排队模式：下一条会等当前回复结束后发出。
            </span>
          )}
        </div>
      )}

      {queuedMessages.length > 0 && (
        <div className="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-1.5 shadow-inner">
          <div className="flex items-center justify-between px-2 py-1">
            <div className="flex items-center gap-1.5 text-[11px]">
              <Clock3 className="h-3 w-3 text-slate-400" />
              <span className="font-semibold text-slate-700">
                排队中 · {queuedMessages.length} 条
              </span>
              <span className="text-slate-400">· 回复结束后依次发出</span>
            </div>
          </div>
          <div className="mt-0.5 flex flex-col gap-1">
            {queuedMessages.map((m, i) => {
              const mention = parseFirstMention(m.text)
              const body = stripLeadingMention(m.text, mention)
              const isNext = i === 0
              return (
                <div
                  key={m.id}
                  className={`group flex items-center gap-2 rounded-xl border px-2.5 py-1.5 transition-colors ${
                    isNext
                      ? "border-amber-200/80 bg-gradient-to-r from-amber-50 to-white shadow-sm ring-1 ring-amber-100/60"
                      : "border-slate-200 bg-surface-canvas hover:bg-surface-elevated"
                  }`}
                >
                  {isNext ? (
                    <span className="shrink-0 rounded-md bg-slate-900 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white">
                      下一条
                    </span>
                  ) : (
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-slate-200 text-[10px] font-semibold text-slate-600">
                      {i + 1}
                    </span>
                  )}
                  {mention?.kind === "provider" && (
                    <ProviderAvatar identity={mention.provider} size="2xs" />
                  )}
                  {mention?.kind === "everyone" && (
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-slate-200 text-slate-600">
                      <Users className="h-3 w-3" />
                    </span>
                  )}
                  {mention && (
                    <span
                      className={`shrink-0 text-[11px] font-medium ${
                        mention.kind === "provider"
                          ? PROVIDER_ACCENT_TEXT[mention.provider]
                          : "text-slate-700"
                      }`}
                    >
                      @{mention.label}
                    </span>
                  )}
                  <span
                    className="min-w-0 flex-1 truncate text-[12px] text-slate-600"
                    title={m.text}
                  >
                    {body}
                  </span>
                  <button
                    type="button"
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700"
                    onClick={() => removeQueuedMessage(m.id)}
                    title="撤回排队消息"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {pendingImages.length > 0 && (
        <div className="flex flex-wrap gap-2 px-2">
          {pendingImages.map((img, i) => (
            <div key={img.url} className="group relative">
              <img
                src={img.url}
                alt={img.file.name}
                className="h-16 w-16 rounded-lg border border-slate-200 object-cover"
              />
              <button
                type="button"
                className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-slate-600 text-white opacity-0 transition-opacity group-hover:opacity-100"
                onClick={() => {
                  URL.revokeObjectURL(img.url)
                  const store = useChatStore.getState()
                  const key = activeGroupId ?? ""
                  const updated = (store.pendingImages[key] ?? []).filter((_, idx) => idx !== i)
                  useChatStore.setState({
                    pendingImages: { ...store.pendingImages, [key]: updated },
                  })
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="relative flex items-end gap-2 px-2 pb-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files)
            e.target.value = ""
          }}
        />

        {/* F027 Phase 3 Day 19c-2 · /ingest 触发的隐藏 ingest file picker */}
        <input
          ref={ingestFileInputRef}
          type="file"
          accept=".md,.markdown,.json,.txt,text/markdown,text/plain,application/json"
          className="hidden"
          onChange={handleIngestFilePicked}
          data-testid="composer-ingest-file-input"
        />

        <button
          type="button"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          onClick={() => fileInputRef.current?.click()}
          title="上传图片"
        >
          <ImagePlus className="h-4 w-4" />
        </button>

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
          onPaste={handlePaste}
          placeholder={
            isTurnLive && sendMode === "queue"
              ? "排队模式：点发送后消息会在当前回复结束后发出..."
              : isTurnLive
                ? "立即模式：消息会立刻发出（后端 dispatch queue 自然排队）..."
                : "输入你的指令。使用 @ 可唤起智能体列表。支持粘贴图片。"
          }
          ref={textareaRef}
          rows={1}
          value={value}
        />

        {showSuggestions && (
          <div className="absolute bottom-full left-2 z-20 mb-2 w-64 overflow-hidden rounded-2xl border border-slate-200 bg-surface-canvas shadow-lg">
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

        {/* F027 Phase 3 Day 19c-2 · slash 命令面板 (AC-P3-6 入口 C) */}
        <SlashCommandMenu
          open={showSlashMenu}
          commands={slashCommands}
          highlight={slashHighlight}
          onSelect={applySlashCommand}
          onHighlightChange={setSlashHighlight}
          onClose={handleSlashMenuClose}
        />

        {/* Stop 按钮：busy 时小尺寸并存在 Send 左边，允许中止 active turn。
            Send 按钮始终可点：immediate 直发；queue + busy 入前端 buffer；queue + idle 直发。 */}
        {(hasRunningProvider || isBusy) && (
          <button
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-rose-500 text-white shadow-md shadow-rose-500/20 transition-all hover:bg-rose-600 active:scale-95"
            onClick={handleStop}
            type="button"
            title="停止当前回复"
          >
            <Square className="h-3 w-3 fill-current" />
          </button>
        )}
        <button
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500 text-white shadow-lg shadow-amber-500/20 transition-all hover:bg-amber-600 active:scale-95 disabled:bg-slate-200 disabled:shadow-none"
          disabled={!value.trim() && pendingImages.length === 0}
          type="submit"
          title={
            sendMode === "queue" && isTurnLive
              ? "排队：会在当前回复结束后发出"
              : "发送消息"
          }
        >
          <Send className="h-4 w-4" />
        </button>
      </div>

      <div className="flex items-center justify-between gap-2 px-2 text-[11px]">
        <span className="text-slate-400">
          {status || "就绪，等待下一次多智能体协作。"}
        </span>
        <div className="flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 p-0.5">
          <button
            type="button"
            onClick={() => setSendMode("immediate")}
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 font-medium transition-colors ${
              sendMode === "immediate"
                ? "bg-amber-500 text-white"
                : "text-slate-500 hover:text-slate-700"
            }`}
            title="立即模式：新消息会立刻发出，进 dispatch queue 自然处理"
          >
            <Zap className="h-3 w-3" />
            立即
          </button>
          <button
            type="button"
            onClick={() => setSendMode("queue")}
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 font-medium transition-colors ${
              sendMode === "queue"
                ? "bg-slate-700 text-white"
                : "text-slate-500 hover:text-slate-700"
            }`}
            title="排队模式：等当前回复结束再发"
          >
            <ListPlus className="h-3 w-3" />
            排队
          </button>
        </div>
      </div>
    </form>
    <IngestModal
      open={ingestModalFile !== null}
      file={ingestModalFile}
      callerAlias={getCurrentUserAlias()}
      onClose={handleIngestModalClose}
    />
    </>
  )
}
