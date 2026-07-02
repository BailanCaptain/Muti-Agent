import type { Provider } from "./constants"
import type { ToolEvent } from "./tool-event"

export type ConnectorSource = {
  kind: "multi_mention_result"
  label: string
  initiator?: Provider
  targets: Provider[]
  fromAlias?: string
  toAlias?: string
}

// ── Inline Confirmation ─────────────────────────────────────────────

/**
 * A confirmation card embedded inside an agent's message bubble.
 * The agent raises a question that requires user decision; the card
 * renders inline (not as a standalone system card).
 */
export type InlineConfirmation = {
  /** Unique ID for this confirmation request */
  confirmationId: string
  /** Which agent raised this */
  raisedBy: Provider
  /** The question / decision point */
  question: string
  /** Selectable options (at least 2) */
  options: Array<{ id: string; label: string; description?: string }>
  /** Allow multiple selections */
  multiSelect?: boolean
  /** Current status */
  status: "pending" | "resolved" | "expired"
  /** How it was resolved */
  resolvedBy?: "user" | "consensus"
  /** The selected option IDs */
  selectedIds?: string[]
  /** Free-text user input */
  userInput?: string
}

/**
 * A pending confirmation item that must be resolved before proceeding.
 * Tracked per session-group across phases.
 */
export type PendingConfirmationItem = {
  id: string
  raisedBy: Provider
  raisedInPhase: "normal"
  question: string
  options?: string[]
  status: "pending" | "resolved" | "deferred"
  resolvedBy?: "user" | "consensus"
  resolution?: string
  /** The message ID where this confirmation card is embedded */
  messageId: string
  createdAt: string
}

// ── Content Blocks (F008: 图片一等公民) ─────────────────────────────

export type ImageMeta = {
  source?: string
  timestamp?: string
  viewport?: { width: number; height: number }
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; url: string; alt?: string; meta?: ImageMeta }

export type SkillEvent = {
  skillName: string
  matchType: "slash" | "auto"
  timestamp: string
}

export type TimelineMessage = {
  id: string
  provider: Provider
  alias: string
  role: "user" | "assistant"
  content: string
  thinking?: string
  messageType:
    | "progress"
    | "final"
    | "a2a_handoff"
    | "a2a_handoff_mcp"
    | "connector"
    | "system_notice"
  connectorSource?: ConnectorSource
  /** Inline confirmation cards embedded in this message bubble */
  inlineConfirmations?: InlineConfirmation[]
  toolEvents?: ToolEvent[]
  skillEvents?: SkillEvent[]
  contentBlocks?: ContentBlock[]
  groupId?: string
  groupRole?: "header" | "member" | "convergence"
  inputTokens?: number
  outputTokens?: number
  cachedPercent?: number
  model: string | null
  /** F026 P3.1: 派发协议 retry 次数（assistant final 入库前 hook 的 retry 计数） */
  retryCount?: number
  /** F026 P3.1: retry reason JSON 数组的解析结果（按尝试顺序） */
  retryReasons?: DispatchValidationRetryReason[]
  /** F026 P5 T0 · 关联到 a2a_calls 的 call_id（仅 a2a 派发产生的 connector message 写入） */
  a2aCallId?: string | null
  /** F026 P5 T0 · LEFT JOIN a2a_calls 取协议字段（用于 F2 溯源胶囊 / F3 超时墓碑 / F4 折叠群组等） */
  a2aParentCallId?: string | null
  a2aRootCallId?: string | null
  a2aOnBehalfOf?: string | null
  a2aConvenerId?: string | null
  /** a2a_calls.status: pending / working / done / failed / timeout / cancelled */
  a2aCallStatus?: string | null
  a2aDeadlineAt?: string | null
  /** F026 P5 T0 · derived from a2aParentCallId（envelope-builder.ts:30 同款 derive） */
  a2aDisplayMode?: "inline" | "nested" | "background"
  createdAt: string
}

export type InvocationConfigSnapshot = Partial<
  Record<Provider, { model?: string; effort?: string }>
>

export interface InvocationStats {
  sessionId: string
  agentId: string
  provider: Provider
  model: string
  startedAt: string
  status: "ACTIVE" | "IDLE" | "ERROR"
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  // F021 Phase 3.3: frozen per-provider runtime config at invocation start
  // (pending flushed into active). Undefined on legacy/pre-F021 rows.
  configSnapshot?: InvocationConfigSnapshot
}

export type SessionGroupSummary = {
  id: string
  roomId: string | null
  title: string
  updatedAt: string
  updatedAtLabel: string
  createdAt: string
  createdAtLabel: string
  projectTag?: string
  // F022 Phase 3.5 (AC-14g): 手动命名后写时间戳；前端据此渲染 🔒 图标。
  titleLockedAt?: string | null
  // F022 Phase 3.5 (AC-14i/j): 归档列表条目才带这两个时间戳；主列表恒为 null/undefined。
  archivedAt?: string | null
  deletedAt?: string | null
  participants: Provider[]
  messageCount: number
  previews: Array<{
    provider: Provider
    alias: string
    text: string
  }>
}

export type ProviderCatalog = {
  provider: Provider
  alias: string
  currentModel: string | null
  modelSuggestions: string[]
}

export type ProviderThreadView = {
  threadId: string
  alias: string
  currentModel: string | null
  quotaSummary: string
  preview: string
  running: boolean
  sopSkill?: string | null
  sopPhase?: string | null
  sopNext?: string | null
  fillRatio?: number | null
  // F021 Phase 6 (AC-32): seal 触发后置 true，直到该 thread 收到下一条 user 消息复位。
  // 派生于消息流——最新 system_notice 之后是否还有 user 消息。
  sealed?: boolean
}

export type ThreadSnapshotDelta = {
  sessionGroupId: string
  newMessages: TimelineMessage[]
  removedMessageIds?: string[]
  providers: Record<Provider, ProviderThreadView>
  invocationStats: InvocationStats[]
}

export type ActiveGroupView = {
  id: string
  roomId: string | null
  title: string
  meta: string
  timeline: TimelineMessage[]
  hasPendingDispatches: boolean
  dispatchBarrierActive: boolean
  providers: Record<Provider, ProviderThreadView>
}

export type ApprovalFingerprint = {
  tool: string
  target?: string
  risk: "low" | "medium" | "high"
}

export type ApprovalRequest = {
  requestId: string
  provider: Provider
  agentAlias: string
  threadId: string
  sessionGroupId: string
  action: string
  fingerprint: ApprovalFingerprint
  reason: string
  context?: string
  createdAt: string
}

export type ApprovalScope = "once" | "thread" | "global"

export type AuthorizationRule = {
  id: string
  provider: Provider | "*"
  action: string
  scope: "thread" | "global"
  decision: "allow" | "deny"
  threadId?: string
  sessionGroupId?: string
  createdAt: string
  createdBy: string
  reason?: string
}

export type DecisionOption = {
  id: string
  label: string
  description?: string
  provider?: Provider
}

export type DecisionRequest = {
  requestId: string
  kind: "multi_choice" | "fan_in_selector" | "inline_confirmation"
  title: string
  description?: string
  options: DecisionOption[]
  sessionGroupId: string
  sourceProvider?: Provider
  sourceAlias?: string
  multiSelect?: boolean
  /**
   * When true, the card renders a free-text input alongside the option list.
   * User can submit text without selecting an option, or combine both.
   */
  allowTextInput?: boolean
  textInputPlaceholder?: string
  /**
   * The message ID this decision card is attached to.
   * When set, the frontend renders the card inline inside the agent's
   * message bubble instead of as a standalone system card.
   */
  anchorMessageId?: string
  createdAt: string
}

export type OptionVerdict = "approved" | "rejected" | "modified"

export type DecisionVerdict = {
  optionId: string
  verdict: OptionVerdict
  modification?: string
}

// F033 · 决策卡生命周期持久化（decision_records 表）。
// pending 只存在于服务器存活期间（blocking promise 在内存）；
// 重启后残留 pending 行被 orphan——promise 与 MCP invocation 已死，fail-closed 不恢复。
export type DecisionRecordStatus = "pending" | "resolved" | "timeout" | "orphaned"

export type DecisionRecord = {
  requestId: string
  sessionGroupId: string
  kind: DecisionRequest["kind"]
  title: string
  description?: string
  options: DecisionOption[]
  multiSelect?: boolean
  anchorMessageId?: string
  sourceProvider?: Provider
  sourceAlias?: string
  status: DecisionRecordStatus
  verdicts?: DecisionVerdict[]
  userInput?: string
  createdAt: string
  resolvedAt?: string
}

export type BlockedDispatchAttempt = {
  sessionGroupId: string
  rootMessageId: string
  from: { agentId: string; messageId: string; provider: Provider }
  to: { agentId: string; provider: Provider }
  reason: "group_cancelled" | "max_hops" | "dedup"
  taskSnippet: string
}

export type RealtimeClientEvent =
  | {
      type: "send_message"
      payload: {
        threadId: string
        provider: Provider
        content: string
        alias: string
        contentBlocks?: ContentBlock[]
        clientMessageId?: string
      }
    }
  | {
      type: "stop_thread"
      payload: {
        threadId: string
      }
    }
  | {
      type: "end_session"
      payload: {
        sessionGroupId: string
      }
    }
  | {
      type: "approval.respond"
      payload: {
        requestId: string
        granted: boolean
        scope: ApprovalScope
      }
    }
  | {
      type: "decision.respond"
      payload: {
        requestId: string
        decisions: DecisionVerdict[]
        userInput?: string
      }
    }
  | {
      // F026 P0 Day2 · client 告知 server 当前房间订阅，server 侧 broadcast 按 sessionGroupId 强过滤
      type: "subscribe"
      payload: {
        sessionGroupId: string
      }
    }

export type RealtimeServerEvent =
  | {
      type: "assistant_delta"
      payload: {
        sessionGroupId: string
        messageId: string
        delta: string
        /**
         * F031 · 服务端该消息累计 content 长度（本段 append **前**捕获）。
         * 客户端 flush 时刻据此判定：=== 当前长度追加 / < 重复丢弃 / > 空洞触发 catch-up。
         * 可选 = 向后兼容：无 offset 的 legacy delta 走盲追加老行为。
         */
        offset?: number
      }
    }
  | {
      type: "assistant_thinking_delta"
      payload: {
        sessionGroupId: string
        messageId: string
        delta: string
        /**
         * F031 · 同 assistant_delta.offset，但作用于 thinking 累计器（独立 offset 空间）。
         * thinking 有两个 emit 源（onToolActivity / stderr cleaned chunk），共用同一累计器，
         * 两处都必须在 append 前捕获。
         */
        offset?: number
      }
    }
  | {
      type: "message.created"
      payload: {
        threadId: string
        sessionGroupId?: string
        message: TimelineMessage
        clientMessageId?: string
      }
    }
  | {
      type: "thread_snapshot"
      payload: {
        sessionGroupId: string
        activeGroup: ActiveGroupView
      }
    }
  | {
      type: "thread_snapshot_delta"
      payload: ThreadSnapshotDelta
    }
  | {
      type: "status"
      payload: {
        sessionGroupId?: string
        message: string
      }
    }
  | {
      type: "dispatch.blocked"
      payload: {
        attempts: BlockedDispatchAttempt[]
      }
    }
  | {
      type: "approval.request"
      payload: ApprovalRequest
    }
  | {
      type: "approval.resolved"
      payload: {
        sessionGroupId: string
        requestId: string
        granted: boolean
      }
    }
  | {
      type: "approval.auto_granted"
      payload: {
        sessionGroupId: string
        provider: Provider
        action: string
        ruleId: string
      }
    }
  | {
      type: "decision.request"
      payload: DecisionRequest
    }
  | {
      type: "decision.resolved"
      payload: {
        sessionGroupId: string
        requestId: string
        decisions: DecisionVerdict[]
        userInput?: string
      }
    }
  | {
      type: "decision.board_flush"
      payload: {
        sessionGroupId: string
        items: DecisionBoardItem[]
        flushedAt: string
      }
    }
  | {
      type: "decision.board_item_resolved"
      payload: {
        sessionGroupId: string
        itemId: string
      }
    }
  | {
      type: "assistant_tool_event"
      payload: {
        sessionGroupId: string
        messageId: string
        event: ToolEvent
      }
    }
  | {
      type: "assistant_content_block"
      payload: {
        sessionGroupId: string
        messageId: string
        block: ContentBlock
      }
    }
  | {
      type: "preview.auto_open"
      payload: {
        port: number
        path?: string
        sessionGroupId?: string
        gatewayPort: number
      }
    }
  | {
      // F022 Phase 3.5 (AC-14k): Haiku auto-titler / manual rename → push title
      // so the left sidebar updates without a browser refresh.
      type: "session.title_updated"
      payload: {
        sessionGroupId: string
        title: string
        titleLockedAt: string | null
      }
    }
  | {
      // F022 Phase 3.5 (review P2-3): archive / soft-delete / restore broadcast.
      // 多端/多标签 sidebar 需要同步主列表与归档列表的增减；没有这个事件
      // 另一个已连接客户端会看到陈旧的"已删会话还在""已恢复不出现"状态。
      type: "session.archive_state_changed"
      payload: {
        sessionGroupId: string
        archivedAt: string | null
        deletedAt: string | null
      }
    }
  | {
      // F026 P3.1: 派发协议 retry 兜底实时进度卡。
      // assistant final 写入前 detectInvalidDispatch 命中 → 拒收 + agent retry。
      // status="retrying" 表示正在重写，"settled" 表示 retry 后合规已入库（清进度卡），
      // "exhausted" 表示 MAX_DISPATCH_RETRIES 耗尽即将兜底入库（banner 接管）。
      // 前端订阅渲染：「🔄 黄仁勋 派发格式不合契约，正在重写...（第 N 次 / 最多 3 次）」
      type: "dispatch.validation_retry"
      payload: DispatchValidationRetryPayload
    }
  | {
      // F026 P5 T2: mention-router Layer 3 灰区可观测事件（spec I1' / line 74 / 269 / 390）。
      // a2a-gateway user 路径上 classifyMention 判定 gray-zone（fail-closed 不派）时广播。
      // /debug/a2a 视图（F10）订阅本事件做"为什么没派给 X"溯源；agent_events 表持久化挪 T4
      // （schema 加 nullable invocation_id 后写入），本事件 T2 仅 WS 广播。
      type: "mention.gray_zone"
      payload: MentionGrayZonePayload
    }
  | {
      // F026 P5 T4: CallRegistry mutation (openCall / advance / settle) 后广播。
      // payload 携带 rootCallId 下未结算 sibling pendingSet。前端 F1 @pill 状态机
      // / F6 状态 Pulse / F10 /debug/a2a 视图据此实时刷新派发状态可视化。
      type: "pending.change"
      payload: PendingChangePayload
    }
  | {
      /**
       * F027 Phase 3 P20 G1 (AC-P3-5 物理依赖 · plan v3.1 §1.2-9):
       * agent wake-up 时（A2A 派发 / direct turn / session bootstrap 等）后端推
       * wake.trigger event。前端 prompt-inspector 顶部据此渲染 🔔 触发因块（V16.5.2）+
       * click pill 触发 in-place drawer 展开 mini call tree（复用 F026 <A2ATreeView>）
       */
      type: "wake.trigger"
      payload: WakeTriggerPayload
    }
  | {
      /**
       * F027 Phase 4 AC-P4-8 (e2) (codex Week 5 j2 FAIL Red→Green):
       * AdaptiveRecall Level 5 escalate → 推 realtime 通知到房间, 让 Inspector UI / toast
       * 显示 "recall escalated". 后端 wiki_events action='recall_escalate' 已落, 这是
       * 额外 realtime 通道 (Inspector pull 是补充)。
       *
       * payload 跟 ProductionLevel5Sink broadcast 结构对齐 (level5-escalate-sink.ts:88-92).
       */
      type: "recall.escalated"
      payload: {
        roomId: string
        alias: string
        trigger: string
        visitedLevels: ReadonlyArray<number>
        reason: string
        totalMs: number
        critiqueCalls: number
        wikiEventId: number
        eventPath: string
        ts: string
      }
    }

/**
 * F026 P3.1: 派发协议 retry 事件 payload。
 *
 * 与 agent_events 表 row.payload (JSON.stringify 后) 同结构 + 与 WS broadcast event 同结构，
 * 让 frontend 既能从 WS 实时订阅，也能从历史 agent_events 拉取相同形态。
 */
export type DispatchValidationRetryReason = "nested_call_tag" | "naked_at_with_real_teammate"

/**
 * F026 P3.1 · retry 进度卡生命周期：
 *   - retrying : 已发现不合规，正在让 LLM 重写（前端进度卡可见）
 *   - settled  : 重写后合规，final 已入库（前端清进度卡）
 *   - exhausted: MAX_DISPATCH_RETRIES 耗尽，已兜底入库（前端清进度卡，banner 红条接管）
 *
 * AC-21 (2026-04-29): retrying 之后必须有 settled / exhausted 收尾事件，否则进度卡卡死。
 */
export type DispatchValidationRetryStatus = "retrying" | "settled" | "exhausted"

export type DispatchValidationRetryPayload = {
  sessionGroupId: string
  threadId: string
  invocationId: string
  agentId: string
  /** assistant 占位 message id（前端用以把进度卡贴在该气泡上方） */
  messageId: string
  /** 1-indexed: 第 N 次重试 */
  attemptIndex: number
  /** MAX_DISPATCH_RETRIES (default 3) */
  maxAttempts: number
  reason: DispatchValidationRetryReason
  /** 拒收的 final 文本片段（首 200 字，足以让用户判断 LLM 写错了什么） */
  originalText: string
  status: DispatchValidationRetryStatus
  /** ISO timestamp */
  occurredAt: string
  /**
   * F026 P3.1 review#2 fix · status="exhausted" 专用：兜底入库的完整 final 内容。
   * retrying 触发前端 resetAssistantStream 把气泡 content 清空，等待 retry delta；
   * 但 exhausted 后没有新 delta，必须让前端用这份内容把气泡填回去，否则刷新前一直空白。
   * retrying / settled 不带（settled 走 message.created → reconcileOptimisticMessage 回填）。
   */
  finalContent?: string
  /**
   * F026 P4 follow-up · retry-badge-realtime fix:
   * settled / exhausted 终态时携带 retry 终值。前端 thread store 直接同步到对应 message
   * 的 retryCount/retryReasons，让"重写 N 次" badge / 红 banner 不再依赖刷新页面走
   * thread_snapshot 才能渲染。retrying 阶段不携带（attemptIndex 已表达进度）。
   */
  retryCount?: number
  retryReasons?: DispatchValidationRetryReason[]
}

/**
 * F026 P5 T4: CallRegistry pending_change 事件 payload。
 *
 * 每次 mutation (openCall / advance / settle) 后由 CallRegistry.emitPendingChange 计算并发出。
 * pendingSet = 当前 rootCallId 下未结算的 sibling alias[]（不含 root 自身）。
 * 前端订阅：
 *   - F1 @pill 状态机六态（sending → ack → working → done | timeout | error）
 *   - F6 状态 Pulse「👂 正在听取 @X @Y」
 *   - F10 /debug/a2a 视图实时刷新树状态色
 *
 * F026 review#4 fix（A'）· settled 终态增量：
 *   pendingSet 只装 pending/working，settle/timeout 后 entry 直接消失。前端 AtPill
 *   命不中 pendingByRoot 时 fallback 到 message envelope snapshot，但 envelope 不重发，
 *   snapshot 仍是 pending → AtPill 卡在 ack/working 不进 done/timeout/error。
 *   修复方案：emitPendingChange 在 row 已 terminal 时附带 settled = [{callId, alias, status}]。
 *   timeoutScan 同步改为 SELECT-then-UPDATE 后逐个 emit（之前完全不 emit）。
 *   前端 thread-store 据此维护 settledByRoot terminal cache，AtPill 反查链路：
 *     pendingByRoot 命中 → settledByRoot 命中 → snapshot fallback。
 */
export type PendingChangePayload = {
  sessionGroupId: string
  rootCallId: string
  /** = rootCallId 当 mutation 发生在 root 自身；否则 = parent 链上一层 callId */
  parentCallId: string
  pendingSet: Array<{
    callId: string
    /** issuer alias（"黄仁勋" / "桂芬" / "范德彪" / "user:小孙" 等） */
    alias: string
    status: "pending" | "working"
  }>
  /**
   * F026 review#4 fix · 当前 emit 触发的 mutation 把哪些 call settle 到了 terminal 状态。
   * settle 路径：含被 settle 的 callId（单元素）。
   * timeoutScan 路径：每个被超时的 call 各 emit 一次（settled 单元素，per-call emit）。
   * openCall / advance / CAS noop：缺省（不在 terminal）。
   */
  settled?: Array<{
    callId: string
    alias: string
    status: "done" | "failed" | "timeout" | "cancelled"
  }>
  /** ISO timestamp */
  occurredAt: string
}

/**
 * F027 Phase 3 P20 G1 (AC-P3-5 物理依赖 · plan v3.1 §1.2-9) wake.trigger payload。
 *
 * agent wake-up 时（A2A 派发 / direct turn / 续推 / session bootstrap）后端推一条
 * wake.trigger event，前端 prompt-inspector 顶部据此渲染 🔔 触发因块（V16.5.2 修订），
 * click pill → in-place drawer 复用 F026 <A2ATreeView> 展开 mini call tree。
 *
 * scenario 与 adaptive-recall-coordinator 的 scenario 枚举对齐（wake_up / a2a_handoff
 * / session_bootstrap / direct_turn）。
 */
export type WakeTriggerScenario = "wake_up" | "a2a_handoff" | "session_bootstrap" | "direct_turn"

export interface WakeTriggerPayload {
  /** thread 主键（agent 实例 thread.id） */
  threadId: string
  /** room session group ID */
  sessionGroupId: string
  /** canonical roomId (R-###) 如绑定 — 旧数据 / 测试 fixture 无绑定时 null */
  roomId: string | null
  /** agent alias (黄仁勋/桂芬/范德彪/小孙/...) */
  alias: string
  /** wake-up 场景 */
  scenario: WakeTriggerScenario
  /**
   * a2a 派发 / direct turn child call 的 callId（绑 wake-up 源头）。
   * F026 callRegistry callId 形如 "call-<uuid>"；前端 click pill 时用此 ID
   * fetch GET /debug/a2a?root=<callId> 展开 mini call tree。
   * 当 scenario 与 a2a 无关时（session_bootstrap 等）可为 null。
   */
  a2aCallId: string | null
  /** 触发时间 ISO */
  triggeredAt: string
}

/**
 * F026 P5 T2: mention-router Layer 3 灰区命中事件 payload。
 *
 * spec I1' / line 74 / 269 / 390：a2a-gateway 在 user 路径 classifyMention 判定为
 * gray-zone（fail-closed 不派 + 日志）时 emit。前端 /debug/a2a 视图（F10）订阅本事件
 * 做"为什么没派给 X"溯源；agent_events 表持久化挪 T4（schema 改 nullable invocation_id
 * 后写入）。decision 字段固定 "skip"——P5 决策日志：删 5 条规则集风险大，只补观测。
 */
export type MentionGrayZonePayload = {
  sessionGroupId: string
  threadId?: string
  /** randomUUID — 给 /debug/a2a 视图做唯一定位（不与 a2a_calls.call_id 关联） */
  traceId: string
  /** issuer / source agent alias 或 user id */
  source: string
  sourceMessageId: string
  /** classifyMention 命中的 gray target alias（如 "桂芬"） */
  target: string
  /** target provider id（"claude" / "codex" / "gemini"），用于前端 ProviderAvatar */
  targetProvider: string
  /** 静默拒派原文片段（首 200 字） */
  contentSample: string
  decision: "skip"
  /** ISO timestamp */
  occurredAt: string
}

/**
 * F002: A single question held by the Decision Board, sent to the frontend
 * when SettlementDetector decides the discussion has settled. Same shape
 * as DecisionBoardEntry on the backend but strips the internal questionHash
 * and exposes only display-safe fields for raisers.
 */
export type DecisionBoardItem = {
  id: string
  question: string
  options: { id: string; label: string }[]
  raisers: { alias: string; provider: Provider }[]
  firstRaisedAt: string
  /** True when team reached consensus during Phase 2 discussion. */
  converged?: boolean
}

/**
 * F031 · WS 广播流水位线。`GET /api/session-groups/:groupId` 快照响应携带
 * （read-before-build：组装快照前读取，过投递安全 / 欠投递不安全），
 * 客户端以此换基线：seq ≤ watermark.seq 的流事件视为快照已覆盖直接丢弃。
 * bootstrap 不带（无单组语义，德彪 F031 Design Gate r1 P2）。
 */
export type WsWatermark = {
  /** 服务端进程启动时的 randomUUID；重启后 seq 归零靠 epoch 变化区分 */
  epoch: string
  /** 该 sessionGroup 当前已消耗的最大 seq（0 = 从未广播过） */
  seq: number
}

/**
 * F031 · broadcast 通道线格式：ws.ts broadcast 咽喉给带 sessionGroupId 的事件
 * 盖顶层 `{seq, epoch}`（同一事件发 N 个订阅 socket 共用同一 seq）。
 * 直发通道（send_message 的 socket-bound per-turn emit）**显式不注**——直发只达
 * 单 socket，消耗同组计数器会给其他订阅 socket 制造假 gap。
 * 交集类型一处定义，不逐 union 分支手改（德彪 r1 OQ4）。
 */
export type SequencedRealtimeServerEvent = RealtimeServerEvent & {
  seq?: number
  epoch?: string
}
