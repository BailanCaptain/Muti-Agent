import type { RealtimeServerEvent } from "@multi-agent/shared"
import type { SqliteStore } from "../db/sqlite"
import type {
  ChannelCommandHandler,
  ChannelSender,
  FinalMessage,
  InboundChannelMessage,
  MessageInjector,
} from "./channel-types"

/**
 * F040 ChannelGateway —— 渠道无关的入站核心（Phase 2 群/企微复用同一套）。
 *
 * 入站链：门（chatKind p2p + open_id 白名单，AC4 fail-closed）→ lazy binding（D3）
 *  → durable 入站账本 UNIQUE 三元组先登记（AC5 幂等）→ busy-gated 单条 FIFO drain（AC7）
 *  → 注入 handleClientEvent（alias 村长，AC2）→ 回填 root_message_id（D15 出站溯源锚）。
 *
 * 排队语义：一次 drain 只注入一条；busy 时不注入。turn 结束（invocation.finished）→
 * onBindingIdle → drain 下一条。gateway 是唯一注入者，不并发踩踏。
 */

export type ChannelGatewayConfig = {
  connectorId: string
  allowedOpenIds: string[]
  bindSessionGroup: string
  defaultProvider: string
  /** Phase 2 群三元组（T2）：缺省空集合 = 群模式关（群消息走拒绝分支，等效 Phase 1） */
  allowedGroupChats: string[]
  groupMembers: Record<string, { name: string; role: "owner" | "participant" }>
  groupBindings: Record<string, string>
}

export type InboundResult =
  | "queued"
  | "rejected_allowlist"
  | "rejected_chatkind"
  | "duplicate"
  // ---- Phase 2 群门（AC10）----
  | "ignored_no_mention" // 群内未 @bot 的正常聊天：静默忽略（不审计不回执不入账本）
  | "rejected_group" // 群∉白名单：审计带 chatId（自举），不回执（防探测）
  | "rejected_member" // 成员∉白名单且非 owner：审计 + 群内回执
  | "rejected_unbound" // 群∈白名单但无绑定（种子缺失且库内无既有 binding）：回执推 owner 配置
  // ---- P2.6 命令面（AC-N1）----
  | "command_handled" // owner 命令已执行（含 executor 异常收口成失败回执）
  | "command_denied" // 非 owner 发 / 文本：仅群主可用回执，不注入
  | "command_duplicate" // 同 externalMessageId 重放（WS 补推）：静默去重

/** invocation.finished / failed 的 D16 出站相关字段（gateway 只需这几项） */
export type InvocationFinishedInput = {
  assistantMessageId: string | null
  rootMessageId: string | null
  /** 本次结束的 invocation id——Leg B 同毫秒平局判定时自排除用（缺省仍靠 isFinalEmitted 兜） */
  invocationId?: string | null
}

export type ChannelGatewayDeps = {
  db: SqliteStore
  injector: MessageInjector
  /** 渠道发送面（feishu-sender；测试 fake） */
  sender: ChannelSender
  /** assistantMessageId → 终稿内容+署名（生产接 session repository，测试 fake） */
  readFinalMessage: (assistantMessageId: string) => FinalMessage | null
  /** sessionGroup + provider → threadId（生产接 session repository，测试 fake） */
  resolveThread: (sessionGroupId: string, provider: string) => string | null
  /**
   * AC13.5 Leg B（live）：同 root 链上是否存在起笔早于（含同毫秒平局，保守阻塞）
   * beforeCreatedAt 的在飞 turn。excludeInvocationId=本次结束的 invocation（自排除）。
   * 生产接 message-service 在飞 invocation 上下文；缺省=false（重启后内存清零同语义：
   * 死 invocation 永不产 final 不该阻塞，残余顺序由 Leg A 账本承担）。
   */
  hasEarlierRunningTurn?: (
    rootMessageId: string,
    beforeCreatedAt: string,
    excludeInvocationId?: string,
  ) => boolean
  /**
   * P3 AC16 出站媒体：/uploads URL → 文件字节（装配层实现=uploadsDir + basename，
   * basename 防穿越；fs 集中装配层，gateway/sender 纯测）。缺省 = 出站媒体关。
   */
  readUploadFile?: (url: string) => Uint8Array | null
  /**
   * T7 真机修：/uploads URL → 落盘绝对路径（装配层=uploadsDir + basename 同一容器语义）。
   * 注入时把路径附进正文——CLI agent（Read/shell）能直接打开看图/读文件；只给
   * 「[图片]」标签 agent 是瞎的（真机实测仁勋原话「图片的实际内容没有一起递进来」）。
   * 缺省 = 不附路径（老行为，web contentBlocks 渲染不受影响）。
   */
  resolveAttachmentPath?: (url: string) => string | null
  /**
   * Phase 2.5（AC-M2）：getter 形态 = 每次门判定现读快照（DB-backed store 写失效后
   * 下一条消息即按新配置判定，不重启）。静态对象形态保留（既有测试/固定配置零翻改）。
   */
  config: ChannelGatewayConfig | (() => ChannelGatewayConfig)
  genId: () => string
  now: () => string
  /** 结构化审计日志（默认 console.warn；测试可注入 spy） */
  audit?: (event: string, meta: Record<string, unknown>) => void
  /**
   * Phase 2.5（AC-M3）：拒绝持久化（待放行列表数据源）。四个拒绝点上报
   * （allowlist / group-not-allowed / member-not-allowed / unbound）；
   * ignored_no_mention 设计即无痕不上报。抛异常不击穿门主链（降级审计）。
   */
  recordReject?: (r: {
    chatId: string
    chatKind: "p2p" | "group"
    openId: string
    reason: string
  }) => void
  /**
   * P2.6（AC-N1）命令面 executor。缺省 = 命令面关（`/` 文本走普通注入链，
   * Phase 1/2 语义原样）。owner 判定/幂等/异常收口在 gateway 本层。
   */
  commands?: ChannelCommandHandler
}

type BindingRow = {
  id: string
  external_chat_id: string
  chat_kind: string
  session_group_id: string
  default_provider: string
}

const OUTBOUND_MAX_ATTEMPTS = 3

/** AC13.5：held_order 超时强制放行阈值（计时基准=hold_since，非 message_created_at——长工具调用不误强放） */
const ORDER_HOLD_TIMEOUT_MS = 60_000

/**
 * AC15：占位卡 'sent' 超时 → PATCH 超时文案 + expired。取 15min——agent 长任务（写码/
 * 调研）常超 10min，过短会「超时卡+迟到终稿」并排难看；expired 后终稿到达走正常 POST 不丢。
 */
const PLACEHOLDER_EXPIRE_MS = 15 * 60_000

type InboundRow = {
  id: string
  binding_id: string
  content: string
  external_chat_id: string
  sender_open_id: string
  /** AC16：入站媒体 JSON（[{kind,url,name}]）；NULL=纯文本 */
  attachments: string | null
}

export class ChannelGateway {
  private readonly draining = new Set<string>()
  /**
   * F040 代码审 r1 P1-1：per-binding 注入后未完成 turn 标记。direct turn 不占 dispatch
   * slot（getBusyStatus 恒 null，message-service.ts:3226），不能靠它排队；gateway 自己
   * 追踪 in-flight —— 注入一条即 add，onInvocationFinished 清，其间不再注入（否则第二条
   * 撞 :1476「已经在运行中」被丢，违反 AC7/D12）。
   */
  private readonly inflight = new Set<string>()

  constructor(private readonly deps: ChannelGatewayDeps) {}

  /** 配置归一化：getter 现读（AC-M2 热生效）/ 静态对象原样（Phase 1/2 兼容） */
  private cfg(): ChannelGatewayConfig {
    const c = this.deps.config
    return typeof c === "function" ? c() : c
  }

  private audit(event: string, meta: Record<string, unknown>) {
    if (this.deps.audit) return this.deps.audit(event, meta)
    console.warn(`[F040:${event}]`, JSON.stringify(meta))
  }

  /** 拒绝持久化（AC-M3 待放行数据源）：失败降级审计，绝不击穿门主链。 */
  private safeRecordReject(r: {
    chatId: string
    chatKind: "p2p" | "group"
    openId: string
    reason: string
  }): void {
    try {
      this.deps.recordReject?.(r)
    } catch (err) {
      this.audit("reject-persist-error", { ...r, err: String(err) })
    }
  }

  /**
   * 入站：门（p2p 白名单 / 群双白名单+@bot，AC4/AC10）→ **命令面截流（AC-N1，
   * binding 之前——未绑群也要能 /newroom）** → binding → 账本登记 → 尝试 drain
   */
  async handleInbound(msg: InboundChannelMessage): Promise<InboundResult> {
    if (msg.chatKind === "group") {
      const rejected = await this.gateGroup(msg)
      if (rejected) return rejected
    } else {
      // AC4 p2p 门：open_id 白名单 fail-closed（Phase 1 原样）
      if (!this.cfg().allowedOpenIds.includes(msg.senderOpenId)) {
        this.audit("inbound-reject", {
          reason: "allowlist",
          chatId: msg.externalChatId,
          sender: msg.senderOpenId,
        })
        this.safeRecordReject({
          chatId: msg.externalChatId,
          chatKind: "p2p",
          openId: msg.senderOpenId,
          reason: "allowlist",
        })
        return "rejected_allowlist"
      }
    }

    // AC-N1：`/` 前缀整体保留给命令面（过门者才可达；不进账本不注入，回执只回飞书）
    if (this.deps.commands && msg.text.trim().startsWith("/")) {
      return this.handleCommand(msg)
    }

    const binding = this.getOrCreateBinding(msg)
    if (!binding) {
      // 仅群可能走到：种子缺失且库内无既有 binding → 回执推 owner 配置
      this.audit("inbound-reject", {
        reason: "group-unbound",
        chatId: msg.externalChatId,
        sender: msg.senderOpenId,
      })
      this.safeRecordReject({
        chatId: msg.externalChatId,
        chatKind: "group",
        openId: msg.senderOpenId,
        reason: "unbound",
      })
      // AC-N6（D20）回执双路：命令面自助（/newroom //switch）为主，管理页兜底
      await this.safeReceipt(
        msg.externalChatId,
        "这个群还没选房间：群主发 /newroom 房间名 建一个新房、或 /switch R-号 切到已有房间；也可在网页「设置 → 渠道」里选。",
      )
      return "rejected_unbound"
    }

    // AC5 幂等：UNIQUE(connector, chat, message_id) 先登记后处理
    const inserted = this.tryInsertInbound(msg, binding.id)
    if (!inserted) return "duplicate"

    await this.drainIfIdle(binding.id)

    // AC12：群消息本轮没被 drain 注入（binding 忙）→ 群内 ack 昵称+位置
    // （多人场景不知道谁的任务在排；p2p 沿用 Phase 1 静默，单人自知）。
    if (msg.chatKind === "group") {
      await this.ackIfStillQueued(msg, binding.id)
    }
    return "queued"
  }

  /**
   * AC-N1 命令面：幂等先登记（channel_command_audit UNIQUE 三元组，WS 补推真机实测；
   * 先登记后执行 = 半途死重放被去重，宁丢一次让人重敲不重复执行特权动作）→ owner 门
   * （非 owner 一律「仅群主可用」，已知/未知不区分——不向 participant 泄词表）→
   * executor（异常收口成失败回执，永不掉进注入链）。
   */
  private async handleCommand(msg: InboundChannelMessage): Promise<InboundResult> {
    const text = msg.text.trim()
    if (!this.tryInsertCommandAudit(msg, text)) return "command_duplicate"

    if (!this.cfg().allowedOpenIds.includes(msg.senderOpenId)) {
      this.setCommandResult(msg, "denied")
      this.audit("command-denied", {
        chatId: msg.externalChatId,
        sender: msg.senderOpenId,
      })
      await this.safeReceipt(msg.externalChatId, "命令面仅群主可用。")
      return "command_denied"
    }

    let receipt: string
    try {
      const binding = this.getBindingByChat(msg.externalChatId)
      const cfg = this.cfg()
      // biome-ignore lint/style/noNonNullAssertion: handleInbound 只在 commands 存在时进来
      receipt = await this.deps.commands!.execute({
        chatId: msg.externalChatId,
        chatKind: msg.chatKind,
        senderOpenId: msg.senderOpenId,
        text,
        binding: binding
          ? {
              sessionGroupId: binding.session_group_id,
              defaultProvider: binding.default_provider,
            }
          : null,
        channelDefaults: {
          bindSessionGroup: cfg.bindSessionGroup,
          defaultProvider: cfg.defaultProvider,
        },
      })
      this.setCommandResult(msg, "done")
    } catch (err) {
      this.audit("command-error", { chatId: msg.externalChatId, err: String(err) })
      this.setCommandResult(msg, `error:${String(err).slice(0, 200)}`)
      receipt = "命令执行失败，请稍后再试（详情已记录日志）。"
    }
    await this.safeReceipt(msg.externalChatId, receipt)
    return "command_handled"
  }

  /** UNIQUE 冲突 → false（重放）；raw_text 截 512（审计存证，不存全文炸库） */
  private tryInsertCommandAudit(msg: InboundChannelMessage, text: string): boolean {
    const ts = this.deps.now()
    try {
      this.deps.db.db
        .prepare(
          `INSERT INTO channel_command_audit
             (id, channel, external_chat_id, external_message_id, open_id, chat_kind, raw_text, result, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)`,
        )
        .run(
          this.deps.genId(),
          this.cfg().connectorId,
          msg.externalChatId,
          msg.externalMessageId,
          msg.senderOpenId,
          msg.chatKind,
          text.slice(0, 512),
          ts,
          ts,
        )
      return true
    } catch (err) {
      if (String(err).includes("UNIQUE")) return false
      throw err
    }
  }

  private setCommandResult(msg: InboundChannelMessage, result: string): void {
    this.deps.db.db
      .prepare(
        "UPDATE channel_command_audit SET result = ?, updated_at = ? WHERE channel = ? AND external_chat_id = ? AND external_message_id = ?",
      )
      .run(
        result,
        this.deps.now(),
        this.cfg().connectorId,
        msg.externalChatId,
        msg.externalMessageId,
      )
  }

  /** AC12：查该消息是否仍 queued，是则群内回执排队位置（尽力而为，失败只审计）。 */
  private async ackIfStillQueued(msg: InboundChannelMessage, bindingId: string): Promise<void> {
    const row = this.deps.db.db
      .prepare(
        "SELECT state, seq FROM channel_inbound_ledger WHERE connector_id = ? AND external_chat_id = ? AND external_message_id = ?",
      )
      .get(this.cfg().connectorId, msg.externalChatId, msg.externalMessageId) as
      | { state: string; seq: number }
      | undefined
    if (!row || row.state !== "queued") return
    const pos = (
      this.deps.db.db
        .prepare(
          "SELECT COUNT(*) AS n FROM channel_inbound_ledger WHERE binding_id = ? AND state = 'queued' AND seq <= ?",
        )
        .get(bindingId, row.seq) as { n: number }
    ).n
    await this.safeReceipt(
      msg.externalChatId,
      `已排队（第 ${pos} 位）｜${this.resolveAttribution(msg.senderOpenId)}`,
    )
  }

  /**
   * 群门纯判定（gateGroup 的零副作用核；precheckInbound 复用防双源漂移）。
   * 返回 null = 过门；非 null = 拒绝/忽略结果。
   */
  private evaluateGroupGate(msg: InboundChannelMessage): InboundResult | null {
    const cfg = this.cfg()
    const isOwner = cfg.allowedOpenIds.includes(msg.senderOpenId)
    if (cfg.allowedGroupChats.length === 0) return "rejected_chatkind"
    if (!msg.mentionsBot) {
      // T7 修5（小孙点名）：群裸媒体（飞书发图/文件带不了 @）——仅 owner 的放行，
      // 其他人（含成员白名单）一律静默忽略。平台 at_msg 订阅根本不推裸消息
      // （T7 ⑤实证），此分支要开通「接收群聊中所有消息」权限才可达；未开通 =
      // fail-closed 原样。媒体形态两个调用点不同：precheck 在下载前（media
      // 描述符），handleInbound 在下载后（attachments 本地 URL）——都认；
      // 下载失败两者皆空 → 照旧忽略（media-download-failed 已审计）。
      const isMedia = Boolean(msg.media) || (msg.attachments?.length ?? 0) > 0
      if (!(isMedia && isOwner)) return "ignored_no_mention"
    }
    if (!cfg.allowedGroupChats.includes(msg.externalChatId)) return "rejected_group"
    const member = cfg.groupMembers[msg.senderOpenId]
    if (!member && !isOwner) return "rejected_member"
    return null
  }

  /**
   * 门前只读预检（guardian P3 发现1）：connector 在下载媒体等**有磁盘副作用**的
   * 动作前问门——被拒/被忽略的消息不落一个字节（pre-gate 孤儿文件填盘面）。
   * 零副作用：不审计不回执不写库；真正的拒绝路径由随后的 handleInbound 走全套。
   * 契约=忠实预测 handleInbound 会不会收，含 rejected_unbound（德彪 P3-r2 P2：
   * 过门 ≠ 会被接收——群已授权但未选房间同样是拒绝路径；今天群媒体恒未 @ 到不了
   * 这步，但 parser 一旦校准出群媒体带 mentions 即现形，预检不许与真门分叉）。
   */
  precheckInbound(msg: InboundChannelMessage): boolean {
    if (msg.chatKind === "group") {
      if (this.evaluateGroupGate(msg) !== null) return false
    } else if (!this.cfg().allowedOpenIds.includes(msg.senderOpenId)) {
      return false
    }
    // 可绑性（getOrCreateBinding 同判定的只读镜像）：既有行或有种子才会被接收
    if (this.getBindingByChat(msg.externalChatId)) return true
    const seed =
      msg.chatKind === "group"
        ? this.cfg().groupBindings[msg.externalChatId]
        : this.cfg().bindSessionGroup
    return Boolean(seed)
  }

  /**
   * AC10 群门（D14 双白名单 + @bot）。返回 null = 过门。
   * 门序（回执面递减，fail-closed）：群模式关 → 未 @bot 静默 → 群白名单（审计不回执，
   * 防给未知群探测面）→ 成员白名单（owner=∈allowedOpenIds 全权；白名单群内可回执）。
   * 判定核在 evaluateGroupGate（纯）；本层只做各拒绝分支的审计/持久化/回执副作用。
   */
  private async gateGroup(msg: InboundChannelMessage): Promise<InboundResult | null> {
    const verdict = this.evaluateGroupGate(msg)
    if (verdict === null) return null
    if (verdict === "ignored_no_mention") return verdict
    if (verdict === "rejected_chatkind") {
      this.audit("inbound-reject", {
        reason: "chatkind",
        chatKind: msg.chatKind,
        chatId: msg.externalChatId,
        sender: msg.senderOpenId,
      })
      return verdict
    }
    if (verdict === "rejected_group") {
      this.audit("inbound-reject", {
        reason: "group-not-allowed",
        chatId: msg.externalChatId,
        sender: msg.senderOpenId,
      })
      this.safeRecordReject({
        chatId: msg.externalChatId,
        chatKind: "group",
        openId: msg.senderOpenId,
        reason: "group-not-allowed",
      })
      return "rejected_group"
    }
    // 余下唯一分支：rejected_member（evaluateGroupGate 的第四道门）
    this.audit("inbound-reject", {
      reason: "member-not-allowed",
      chatId: msg.externalChatId,
      sender: msg.senderOpenId,
    })
    this.safeRecordReject({
      chatId: msg.externalChatId,
      chatKind: "group",
      openId: msg.senderOpenId,
      reason: "member-not-allowed",
    })
    await this.safeReceipt(
      msg.externalChatId,
      "你还没有被授权使用机器人（已记录申请，等群主在管理页放行后再试）。",
    )
    return "rejected_member"
  }

  /**
   * 归因名解析（注入时现算，不进账本 schema——重启后从 config 重新推导，天然 durable）。
   * 昵称来自成员白名单（owner 配置命名，非用户自报）；owner 未列成员表回落「村长」。
   * 剥 `@` / `[Call:` 循环到不动点（`[C@all:` 单次剥 @ 会重拼出 `[Call:`）；剥空回落「成员」。
   */
  private resolveAttribution(senderOpenId: string): string {
    const cfg = this.cfg()
    const member = cfg.groupMembers[senderOpenId]
    const raw = member?.name ?? (cfg.allowedOpenIds.includes(senderOpenId) ? "村长" : senderOpenId)
    let name = raw
    for (;;) {
      const next = name.replaceAll("@", "").replaceAll("[Call:", "")
      if (next === name) break
      name = next
    }
    name = name.trim()
    return name.length > 0 ? name : "成员"
  }

  /** 回执是尽力而为：发送失败只审计，绝不让回执失败击穿门/账本主链（B025 家族教训）。 */
  private async safeReceipt(externalChatId: string, text: string): Promise<void> {
    try {
      await this.deps.sender.sendText(externalChatId, text)
    } catch (err) {
      this.audit("receipt-error", { chatId: externalChatId, err: String(err) })
    }
  }

  /** turn 结束（invocation.finished）后由出站 hook 调，续 drain 该 binding */
  async onBindingIdle(externalChatId: string): Promise<void> {
    const binding = this.getBindingByChat(externalChatId)
    if (binding) await this.drainIfIdle(binding.id)
  }

  /**
   * 出站入口（订阅 invocation.finished / failed）。D15 溯源：rootMessageId → injected
   * 入站行 → 来源 binding → 投递终稿；无来源不投。末尾续 drain 该 binding（AC7）。
   */
  async onInvocationFinished(input: InvocationFinishedInput): Promise<void> {
    const { assistantMessageId, rootMessageId } = input
    try {
      // D15：无 root（后台/定时产物）或无终稿 id → 不投任何 IM
      if (!rootMessageId || !assistantMessageId) {
        // AC15：failed / 空手 finished 收尾——root 占位卡还挂着且该 root 零出站行
        // （没有任何 final 已投/在投）→ PATCH 失败文案。漏网（并发 turn 稍后产 final）
        // → final 到达时占位卡已非 'sent'，正常 POST，内容不丢。
        if (rootMessageId && !assistantMessageId) {
          try {
            await this.finalizePlaceholderOnEmptyTurn(rootMessageId)
          } catch (err) {
            this.audit("placeholder-finalize-error", { rootMessageId, err: String(err) })
          }
        }
        return
      }

      const source = this.getInjectedByRoot(rootMessageId)
      if (!source) {
        // web 发起 / 已 GC → 不投（D15 负例），仅 debug
        return
      }

      // r2 P1-new：deliverFinal 可能 throw（sender/token 异常）——无论成败都必须清 inflight
      // 并续 drain，否则该 binding 队列永久卡死（后续 drain 见 inflight 直接 return）。
      try {
        await this.deliverFinal(
          source.binding_id,
          source.external_chat_id,
          assistantMessageId,
          rootMessageId,
          input.invocationId ?? null,
        )
      } catch (err) {
        this.audit("outbound-deliver-error", {
          bindingId: source.binding_id,
          messageId: assistantMessageId,
          err: String(err),
        })
      } finally {
        // turn 结束 → 清 in-flight 标记（P1-1），续 drain 该 binding 的下一条排队消息
        this.inflight.delete(source.binding_id)
        try {
          await this.onBindingIdle(source.external_chat_id)
        } catch (err) {
          this.audit("drain-after-final-error", {
            bindingId: source.binding_id,
            err: String(err),
          })
        }
      }
    } finally {
      // AC13.5：finished/failed 都触发同 root 重扫（前序 settle → 放行 held 后序）。
      // 外层 finally：即使本事件因无终稿 id 早退（如 failed 无回执体），root 链上的
      // held 行仍要有放行机会。
      if (rootMessageId) {
        try {
          await this.rescanRoot(rootMessageId)
        } catch (err) {
          this.audit("order-rescan-error", { rootMessageId, err: String(err) })
        }
      }
    }
  }

  /**
   * 出站账本状态机（D11 + AC13.5）：pending|held_order → attempted → sent | failed_terminal。
   * 德彪设计审 r2 P3 护栏：查终稿 + 判序 + 登记全部同步完成于任何发送 await 之前。
   */
  private async deliverFinal(
    bindingId: string,
    externalChatId: string,
    assistantMessageId: string,
    rootMessageId: string,
    invocationId: string | null,
  ): Promise<void> {
    const final = this.deps.readFinalMessage(assistantMessageId)
    if (!final || final.content.trim().length === 0) {
      // AC3 防空消息。德彪 P3-r1 P1-1：生产成功路径空输出（exit 0 空终稿）也带
      // assistantMessageId——onInvocationFinished 的 !assistantMessageId 收尾分支
      // 不触发，这里是空手 turn 的唯一出口，必须同套收尾（否则占位卡挂 15min）。
      try {
        await this.finalizePlaceholderOnEmptyTurn(rootMessageId)
      } catch (err) {
        this.audit("placeholder-finalize-error", { rootMessageId, err: String(err) })
      }
      return
    }

    // AC13.5：登记前判序（同步）——被阻塞则以 held_order 落账，非阻塞返回（rescan 接力）
    const blocked = this.isOrderBlocked(
      bindingId,
      rootMessageId,
      final.createdAt,
      final.orderSeq,
      invocationId ?? undefined,
    )
    const registered = this.tryRegisterOutbound(bindingId, assistantMessageId, {
      rootMessageId,
      messageCreatedAt: final.createdAt,
      messageOrderSeq: final.orderSeq,
      held: blocked,
    })
    if (!registered) return
    if (blocked) {
      this.audit("outbound-held", {
        bindingId,
        messageId: assistantMessageId,
        rootMessageId,
        messageCreatedAt: final.createdAt,
      })
      return
    }

    await this.claimAndSend(bindingId, externalChatId, assistantMessageId, final)
  }

  /**
   * AC13.5 顺序门（Leg A + Leg B）。null createdAt = legacy ready（不阻塞不被阻塞，P2-5）。
   * 同毫秒平局（德彪 P2 审 r1 P2-2）：Leg A 按 (created_at, order_seq=rowid) 与房间列表
   * 同键精确比较（任一侧 seq 缺失→平局不判，防误锁）；Leg B 无 rowid 可比→保守阻塞
   * （宁等勿乱序，sweeper 60s 兜底），自排除靠 excludeInvocationId + isFinalEmitted 双保险。
   */
  private isOrderBlocked(
    bindingId: string,
    rootMessageId: string | null,
    messageCreatedAt: string | null,
    messageOrderSeq: number | null,
    excludeInvocationId?: string,
  ): boolean {
    if (!rootMessageId || !messageCreatedAt) return false
    // Leg A（durable）：同 binding 同 root 起笔更早（含同毫秒 rowid 更小）且未终态的账本行
    const earlier = (
      this.deps.db.db
        .prepare(
          `SELECT COUNT(*) AS n FROM channel_outbound_ledger
           WHERE binding_id = ? AND root_message_id = ?
             AND message_created_at IS NOT NULL
             AND (
               message_created_at < ?
               OR (message_created_at = ? AND ? IS NOT NULL AND message_order_seq IS NOT NULL AND message_order_seq < ?)
             )
             AND state IN ('pending','attempted','held_order')`,
        )
        .get(
          bindingId,
          rootMessageId,
          messageCreatedAt,
          messageCreatedAt,
          messageOrderSeq,
          messageOrderSeq,
        ) as { n: number }
    ).n
    if (earlier > 0) return true
    // Leg B（live）：在飞 turn（重启后内存清零=自然放空，死 invocation 不产 final）
    return (
      this.deps.hasEarlierRunningTurn?.(rootMessageId, messageCreatedAt, excludeInvocationId) ??
      false
    )
  }

  /**
   * CAS claim + 发送 + 账本推进（首投/rescan 放行/sweeper/reconcile 四路共用，r2 P2-4）。
   * claim 即 attempted+attempts+1+清 hold_since；changes≠1 = 别家已抢走（不双发）。
   */
  private async claimAndSend(
    bindingId: string,
    externalChatId: string,
    internalMessageId: string,
    final: FinalMessage,
    opts: { allowAttempted?: boolean } = {},
  ): Promise<void> {
    const claimable = opts.allowAttempted
      ? "('pending','held_order','attempted')"
      : "('pending','held_order')"
    const claimed = this.deps.db.db
      .prepare(
        `UPDATE channel_outbound_ledger
           SET state = 'attempted', attempts = attempts + 1, hold_since = NULL, updated_at = ?
         WHERE binding_id = ? AND internal_message_id = ? AND state IN ${claimable}`,
      )
      .run(this.deps.now(), bindingId, internalMessageId)
    if (claimed.changes !== 1) return
    // AC15：该 root 有未消费占位卡 → CAS 认领（'sent'→'replaced'）后首片 PATCH 原地
    // 变身。认领必须先于发送——防同 root 两 final 并发双 PATCH 后者覆盖前者；发送
    // 失败则回滚认领（'replaced'→'sent'），reconcile 重投时再 PATCH（同内容幂等）。
    // 四路共用点（首投/rescan/sweeper/reconcile）= 全路径覆盖。
    const ph = this.deps.db.db
      .prepare(
        `SELECT i.id, i.placeholder_message_id FROM channel_inbound_ledger i
          WHERE i.root_message_id = (
                  SELECT root_message_id FROM channel_outbound_ledger
                   WHERE binding_id = ? AND internal_message_id = ?
                )
            AND i.placeholder_state = 'sent' AND i.placeholder_message_id IS NOT NULL
          LIMIT 1`,
      )
      .get(bindingId, internalMessageId) as
      | { id: string; placeholder_message_id: string }
      | undefined
    const phClaimed = ph
      ? this.deps.db.db
          .prepare(
            `UPDATE channel_inbound_ledger SET placeholder_state = 'replaced', updated_at = ?
              WHERE id = ? AND placeholder_state = 'sent'`,
          )
          .run(this.deps.now(), ph.id).changes === 1
      : false
    const res = await this.deps.sender.sendText(externalChatId, final.content, {
      senderAlias: final.senderAlias,
      model: final.model ?? null,
      ...(phClaimed && ph ? { replacePlaceholder: ph.placeholder_message_id } : {}),
    })
    if (res.ok) {
      this.setOutboundState(bindingId, internalMessageId, "sent")
      // AC16 出站：终稿带媒体（agent 截图/产物）→ 逐个上传回投，跟在署名卡后。
      // await 保序（同 root 串行链上后续 final 不会插进媒体前）；失败只审计——
      // 文本已 sent 即 sent，媒体是增强，不回滚账本不重投全文。
      await this.sendMediaSafe(externalChatId, final)
    } else {
      // 德彪 P3-r1 P1-2：placeholderConsumed = 首片 PATCH 已真变身（长文本余片才失败）
      // → 不回滚——占位卡在飞书侧已是终稿首片，回滚 'sent' 会让 sweeper 15min 后
      // 把它 PATCH 成超时文案毁内容；保持 'replaced'，余片 reconcile POST 补投。
      if (phClaimed && ph && !res.placeholderConsumed) {
        // 回滚占位卡认领：这次没送出去，占位卡还活着，下次（reconcile/人工）再变身
        this.deps.db.db
          .prepare(
            `UPDATE channel_inbound_ledger SET placeholder_state = 'sent', updated_at = ?
              WHERE id = ? AND placeholder_state = 'replaced'`,
          )
          .run(this.deps.now(), ph.id)
      }
      if (res.terminal) {
        this.setOutboundState(bindingId, internalMessageId, "failed_terminal", {
          error: res.error,
        })
      } else {
        // 非 terminal：留 attempted，reconcile 补投
        this.setOutboundState(bindingId, internalMessageId, "attempted", { error: res.error })
      }
    }
  }

  /**
   * AC13.5 放行引擎：同 root 的 held_order 行按起笔序逐条过门放行；链头仍被阻即停
   * （后序必然也被阻）。由 finished/failed（外层 finally）与 sweeper 驱动。
   */
  private async rescanRoot(rootMessageId: string): Promise<void> {
    for (;;) {
      const held = this.deps.db.db
        .prepare(
          `SELECT o.binding_id, o.internal_message_id, o.message_created_at, o.message_order_seq, b.external_chat_id
             FROM channel_outbound_ledger o JOIN channel_bindings b ON b.id = o.binding_id
            WHERE o.root_message_id = ? AND o.state = 'held_order'
            ORDER BY o.message_created_at ASC, o.message_order_seq ASC, o.created_at ASC LIMIT 1`,
        )
        .get(rootMessageId) as
        | {
            binding_id: string
            internal_message_id: string
            message_created_at: string | null
            message_order_seq: number | null
            external_chat_id: string
          }
        | undefined
      if (!held) return
      if (
        this.isOrderBlocked(
          held.binding_id,
          rootMessageId,
          held.message_created_at,
          held.message_order_seq,
        )
      )
        return
      const final = this.deps.readFinalMessage(held.internal_message_id)
      if (!final || final.content.trim().length === 0) return // 终稿丢失：留行给 reconcile/人工
      await this.claimAndSend(
        held.binding_id,
        held.external_chat_id,
        held.internal_message_id,
        final,
      )
      // 循环：投出后链上下一条可能就绪
    }
  }

  /**
   * AC13.5 sweeper：held_order 超时（hold_since 起算 60s）强制放行——卡死 agent 不饿死
   * 投递。临界区先重查前序：已可正常放行的不打 forced 标（r2 P2-4）。
   */
  async sweepHeldOrders(): Promise<void> {
    const nowMs = Date.parse(this.deps.now())
    const rows = this.deps.db.db
      .prepare(
        `SELECT o.binding_id, o.internal_message_id, o.message_created_at, o.message_order_seq,
                o.root_message_id, o.hold_since, b.external_chat_id
           FROM channel_outbound_ledger o JOIN channel_bindings b ON b.id = o.binding_id
          WHERE o.state = 'held_order'
          ORDER BY o.message_created_at ASC, o.message_order_seq ASC, o.created_at ASC`,
      )
      .all() as Array<{
      binding_id: string
      internal_message_id: string
      message_created_at: string | null
      message_order_seq: number | null
      root_message_id: string | null
      hold_since: string | null
      external_chat_id: string
    }>
    for (const row of rows) {
      if (!row.hold_since) continue
      const holdAgeMs = nowMs - Date.parse(row.hold_since)
      if (holdAgeMs < ORDER_HOLD_TIMEOUT_MS) continue
      const final = this.deps.readFinalMessage(row.internal_message_id)
      if (!final || final.content.trim().length === 0) continue
      // 临界区重查：blocker 已清 → 正常放行（无 forced 标）；仍阻 → 强制放行 + 审计
      const stillBlocked = this.isOrderBlocked(
        row.binding_id,
        row.root_message_id,
        row.message_created_at,
        row.message_order_seq,
      )
      if (stillBlocked) {
        const blockedBy = (
          this.deps.db.db
            .prepare(
              `SELECT internal_message_id FROM channel_outbound_ledger
               WHERE binding_id = ? AND root_message_id = ?
                 AND message_created_at IS NOT NULL
                 AND (
                   message_created_at < ?
                   OR (message_created_at = ? AND ? IS NOT NULL AND message_order_seq IS NOT NULL AND message_order_seq < ?)
                 )
                 AND state IN ('pending','attempted','held_order')`,
            )
            .all(
              row.binding_id,
              row.root_message_id,
              row.message_created_at,
              row.message_created_at,
              row.message_order_seq,
              row.message_order_seq,
            ) as Array<{
            internal_message_id: string
          }>
        ).map((r) => r.internal_message_id)
        this.audit("out-of-order-forced", {
          rootMessageId: row.root_message_id,
          bindingId: row.binding_id,
          forcedMessageId: row.internal_message_id,
          forcedCreatedAt: row.message_created_at,
          blockedBy,
          holdAgeMs,
          forceAfterMs: ORDER_HOLD_TIMEOUT_MS,
        })
      }
      await this.claimAndSend(row.binding_id, row.external_chat_id, row.internal_message_id, final)
    }
  }

  /**
   * AC16 出站媒体（best-effort）：final.mediaBlocks 逐个 readUploadFile → sendMedia。
   * 渠道不支持 / 装配缺 readUploadFile / 读盘失败 / 上传失败 → 全部只审计，
   * 绝不影响文本投递账本。
   */
  private async sendMediaSafe(externalChatId: string, final: FinalMessage): Promise<void> {
    const media = final.mediaBlocks
    if (!media || media.length === 0) return
    const send = this.deps.sender.sendMedia?.bind(this.deps.sender)
    const read = this.deps.readUploadFile
    if (!send || !read) return
    for (const m of media) {
      try {
        const data = read(m.url)
        if (!data) {
          this.audit("outbound-media-read-failed", { url: m.url })
          continue
        }
        const r = await send(externalChatId, { kind: m.kind, name: m.name, data })
        if (!r.ok) {
          this.audit("outbound-media-send-failed", { url: m.url, err: r.error })
        }
      } catch (err) {
        this.audit("outbound-media-error", { url: m.url, err: String(err) })
      }
    }
  }

  // ---- AC15 占位卡（发送中→原地变身终稿；状态机 sent→replaced|failed|expired）----

  /**
   * 发占位卡 + 落账（best-effort，drainIfIdle 注入成功后 fire-and-forget 调用）。
   * 任何失败只审计——占位卡是体验增强，绝不反向影响入站主链；没发出去时
   * placeholder 字段留 NULL，终稿走正常 POST。
   */
  private async sendPlaceholderSafe(row: InboundRow): Promise<void> {
    try {
      const send = this.deps.sender.sendPlaceholder?.bind(this.deps.sender)
      if (!send) return
      const res = await send(row.external_chat_id)
      if (!res.ok) {
        this.audit("placeholder-send-failed", { inboundId: row.id, err: res.error })
        return
      }
      this.deps.db.db
        .prepare(
          `UPDATE channel_inbound_ledger
              SET placeholder_message_id = ?, placeholder_state = 'sent', updated_at = ?
            WHERE id = ?`,
        )
        .run(res.messageId, this.deps.now(), row.id)
    } catch (err) {
      this.audit("placeholder-send-error", { inboundId: row.id, err: String(err) })
    }
  }

  /**
   * failed / 空手 finished 收尾：root 占位卡还挂着且该 root **零出站账本行**（没有任何
   * final 已投/在投）→ CAS 认领（sent→failed）+ PATCH 失败文案。有出站行则不动——
   * 交 claimAndSend 正常变身。CAS 输了（并发 final 抢先替换）= 正常，静默退。
   */
  private async finalizePlaceholderOnEmptyTurn(rootMessageId: string): Promise<void> {
    const ph = this.deps.db.db
      .prepare(
        `SELECT id, placeholder_message_id FROM channel_inbound_ledger
          WHERE root_message_id = ? AND placeholder_state = 'sent'
            AND placeholder_message_id IS NOT NULL
          LIMIT 1`,
      )
      .get(rootMessageId) as { id: string; placeholder_message_id: string } | undefined
    if (!ph) return
    const hasOutbound =
      (
        this.deps.db.db
          .prepare("SELECT COUNT(*) AS n FROM channel_outbound_ledger WHERE root_message_id = ?")
          .get(rootMessageId) as { n: number }
      ).n > 0
    if (hasOutbound) return
    const claimed =
      this.deps.db.db
        .prepare(
          `UPDATE channel_inbound_ledger SET placeholder_state = 'failed', updated_at = ?
            WHERE id = ? AND placeholder_state = 'sent'`,
        )
        .run(this.deps.now(), ph.id).changes === 1
    if (!claimed) return
    const patch = this.deps.sender.patchCard?.bind(this.deps.sender)
    if (!patch) return
    const res = await patch(ph.placeholder_message_id, {
      text: "❌ 这轮没有产出回复（agent 运行失败或空返回）——稍后再试，或到网页端看详情。",
    })
    if (!res.ok) {
      this.audit("placeholder-fail-patch-failed", { rootMessageId, err: res.error ?? "?" })
    }
  }

  /**
   * AC15 兜底 sweeper：占位卡 'sent' 超过 PLACEHOLDER_EXPIRE_MS（agent 挂死/终稿链
   * 全灭/竞态漏网）→ CAS 认领 + PATCH 超时文案。connector 30s tick 与 sweepHeldOrders
   * 同频驱动。expired 后终稿若迟到，claimAndSend 查不到 'sent' 行 → 正常 POST，内容不丢。
   */
  async sweepPlaceholders(): Promise<void> {
    const nowMs = Date.parse(this.deps.now())
    const rows = this.deps.db.db
      .prepare(
        `SELECT id, placeholder_message_id, updated_at FROM channel_inbound_ledger
          WHERE placeholder_state = 'sent' AND placeholder_message_id IS NOT NULL`,
      )
      .all() as Array<{ id: string; placeholder_message_id: string; updated_at: string }>
    for (const row of rows) {
      const ageMs = nowMs - Date.parse(row.updated_at)
      if (!(ageMs > PLACEHOLDER_EXPIRE_MS)) continue
      const claimed =
        this.deps.db.db
          .prepare(
            `UPDATE channel_inbound_ledger SET placeholder_state = 'expired', updated_at = ?
              WHERE id = ? AND placeholder_state = 'sent'`,
          )
          .run(this.deps.now(), row.id).changes === 1
      if (!claimed) continue
      const patch = this.deps.sender.patchCard?.bind(this.deps.sender)
      if (!patch) continue
      const res = await patch(row.placeholder_message_id, {
        text: "⌛ 这轮处理超时了——回复可能稍后到，或到网页端看详情。",
      })
      if (!res.ok) {
        this.audit("placeholder-expire-patch-failed", { inboundId: row.id, err: res.error ?? "?" })
      }
    }
  }

  /**
   * 启动恢复（AC8 + AC7）。顺序定死：**先出站补投**（pending 续投 / attempted 补投带
   * possible_duplicate 标记 / 超上限转 failed_terminal），**再入站 drain**（旧 final 不排新回复后）。
   */
  async reconcileOnBoot(): Promise<void> {
    await this.reconcileOutbound()

    const bindingIds = (
      this.deps.db.db
        .prepare("SELECT DISTINCT binding_id FROM channel_inbound_ledger WHERE state = 'queued'")
        .all() as Array<{ binding_id: string }>
    ).map((r) => r.binding_id)
    for (const id of bindingIds) {
      await this.drainIfIdle(id)
    }
  }

  /**
   * 出站账本恢复：未终态行（pending/attempted/held_order）按起笔序→创建序补投。
   * AC13.5（r1 P1-1 核心）：pending/held_order 同过顺序门 canReleaseOrdered——重启后
   * 顺序门不失效；attempted 行不过门（已尝试过发送，顺序船已开，按 AC8 原语义补投）。
   */
  private async reconcileOutbound(): Promise<void> {
    const rows = this.deps.db.db
      .prepare(
        "SELECT binding_id, internal_message_id, state, attempts, root_message_id, message_created_at, message_order_seq FROM channel_outbound_ledger WHERE state IN ('pending','attempted','held_order') ORDER BY COALESCE(message_created_at, created_at) ASC, message_order_seq ASC, created_at ASC",
      )
      .all() as Array<{
      binding_id: string
      internal_message_id: string
      state: string
      attempts: number
      root_message_id: string | null
      message_created_at: string | null
      message_order_seq: number | null
    }>
    for (const row of rows) {
      // attempted 且已到上限 → 放弃，转终态 + 告警（不再自动补投，推人工）
      if (row.state === "attempted" && row.attempts >= OUTBOUND_MAX_ATTEMPTS) {
        this.setOutboundState(row.binding_id, row.internal_message_id, "failed_terminal", {
          error: "exceeded max attempts",
        })
        this.audit("outbound-give-up", {
          bindingId: row.binding_id,
          messageId: row.internal_message_id,
          attempts: row.attempts,
        })
        continue
      }
      const binding = this.getBindingById(row.binding_id)
      if (!binding) continue
      const final = this.deps.readFinalMessage(row.internal_message_id)
      if (!final || final.content.trim().length === 0) continue // 终稿丢失，跳过（不误标 sent）
      // AC13.5：pending/held_order 过顺序门；被阻的 pending 转 held_order（进 sweeper 视野）
      if (
        row.state !== "attempted" &&
        this.isOrderBlocked(
          row.binding_id,
          row.root_message_id,
          row.message_created_at,
          row.message_order_seq,
        )
      ) {
        if (row.state === "pending") {
          this.deps.db.db
            .prepare(
              "UPDATE channel_outbound_ledger SET state = 'held_order', hold_since = ?, updated_at = ? WHERE binding_id = ? AND internal_message_id = ? AND state = 'pending'",
            )
            .run(this.deps.now(), this.deps.now(), row.binding_id, row.internal_message_id)
        }
        continue
      }
      // attempted 结果未知 → 补投可能重复，先打标
      if (row.state === "attempted") {
        this.setOutboundState(row.binding_id, row.internal_message_id, "attempted", {
          markDuplicate: true,
        })
      }
      await this.claimAndSend(
        row.binding_id,
        binding.external_chat_id,
        row.internal_message_id,
        final,
        { allowAttempted: true },
      )
    }
  }

  /**
   * drain 循环：inflight（有未完成 turn）或 busy 时停；注入成功即 add inflight 并停等 finished；
   * 注入被拒（group archived → 只 emit status）则继续 drain 下一条（避免死在队头，AC4/合同 #7）。
   */
  private async drainIfIdle(bindingId: string): Promise<void> {
    if (this.draining.has(bindingId)) return
    this.draining.add(bindingId)
    try {
      for (;;) {
        // P1-1：有未完成 turn → 停（direct turn 不占 slot，getBusyStatus 靠不住）
        if (this.inflight.has(bindingId)) return
        const binding = this.getBindingById(bindingId)
        if (!binding) return
        const threadId = this.deps.resolveThread(binding.session_group_id, binding.default_provider)
        if (!threadId) {
          this.audit("drain-no-thread", { bindingId, sessionGroup: binding.session_group_id })
          return
        }
        // 辅助 gate：A2A slot busy / 跨 binding 共享 group 时兜底
        if (this.deps.injector.getBusyStatus(threadId, binding.session_group_id)) return

        const next = this.getOldestQueued(bindingId)
        if (!next) return
        const result = await this.inject(next, binding, threadId)
        if (result === "injected") {
          this.inflight.add(bindingId)
          // AC15：注入成功随手发「思考中」占位卡——fire-and-forget（发卡失败不影响
          // 主链，终稿走正常 POST）；渠道不支持（fake/未来渠道）→ 零行为。
          // 发卡点在注入后 = 命令面/拒绝路径天然不发卡。
          void this.sendPlaceholderSafe(next)
          return // 注入成功，停等该 turn 的 invocation.finished
        }
        // rejected（不可发送）→ 该行已标 rejected + 回执，继续 drain 下一条
      }
    } finally {
      this.draining.delete(bindingId)
    }
  }

  /**
   * 注入一条到 room。capture 区分两种结局：
   * - user message.created → injected + 回填 root_message_id（D15 溯源锚）
   * - status（sendable 门拒绝 archived/deleted，message-service.ts:1277）→ rejected + error + 回执飞书
   *   （P1-2：不能无条件标 injected，否则消息不进 room 也不回执还被 duplicate 吞）
   */
  private async inject(
    row: InboundRow,
    binding: BindingRow,
    threadId: string,
  ): Promise<"injected" | "rejected"> {
    let userMessageId: string | null = null
    let statusReject: string | null = null
    const capture = (e: RealtimeServerEvent) => {
      if (
        e.type === "message.created" &&
        (e as { payload?: { message?: { id?: string; role?: string } } }).payload?.message?.role ===
          "user"
      ) {
        userMessageId = (e as { payload: { message: { id: string } } }).payload.message.id ?? null
      } else if (e.type === "status") {
        statusReject = (e as { payload?: { message?: string } }).payload?.message ?? "not sendable"
      }
    }
    // AC11 MVP（合同 #8）：群消息带归因前缀独立成行（同行会被 classifyMention
    // 行首 walk-left 判 gray 杀掉正文 @派发）；p2p 零前缀（Phase 1 原样）。
    // T11 正式级：真名同时走 senderDisplayName 持久化（timeline 显示用；前缀是
    // agent 视角的房间转录归因，两者按设计并存）。
    const attribution =
      binding.chat_kind === "group" ? this.resolveAttribution(row.sender_open_id) : null
    // AC16：账本附件 → send_message.contentBlocks（web composer 发图同一注入形状）。
    // JSON 破损按无附件降级（文本标签仍在正文）——附件是增强，不击穿注入。
    let contentBlocks: Array<Record<string, unknown>> | undefined
    let pathNote = ""
    if (row.attachments) {
      try {
        const parsed = JSON.parse(row.attachments) as Array<{
          kind: "image" | "file"
          url: string
          name: string
        }>
        if (Array.isArray(parsed) && parsed.length > 0) {
          contentBlocks = parsed.map((a) =>
            a.kind === "image"
              ? { type: "image", url: a.url, alt: a.name, meta: { source: "feishu_inbound" } }
              : { type: "file", url: a.url, name: a.name },
          )
          // T7 真机修：正文附落盘绝对路径——agent 靠 Read/shell 才真能「看」附件
          //（contentBlocks 只管 web 渲染，CLI prompt 走的是 content 文本）。
          // 账本仍存原文标签（原文纪律同归因前缀：路径是注入时的事）。
          const resolve = this.deps.resolveAttachmentPath
          if (resolve) {
            const lines = parsed
              .map((a) => {
                const p = resolve(a.url)
                if (!p) return null
                return `（${a.kind === "image" ? "图片" : "文件"}「${a.name}」已存到本地：${p} ——可直接读取查看）`
              })
              .filter((x): x is string => x !== null)
            if (lines.length > 0) pathNote = `\n${lines.join("\n")}`
          }
        }
      } catch {
        this.audit("inbound-attachments-parse-failed", { inboundId: row.id })
      }
    }
    const content = (attribution ? `[飞书·${attribution}]\n${row.content}` : row.content) + pathNote
    this.deps.injector.handleClientEvent(
      {
        type: "send_message",
        payload: {
          threadId,
          provider: binding.default_provider as never,
          content,
          alias: "村长",
          ...(attribution ? { senderDisplayName: attribution } : {}),
          ...(contentBlocks ? { contentBlocks: contentBlocks as never } : {}),
        },
      },
      capture,
    )

    if (userMessageId) {
      this.deps.db.db
        .prepare(
          "UPDATE channel_inbound_ledger SET state = 'injected', root_message_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(userMessageId, this.deps.now(), row.id)
      return "injected"
    }

    // 没拿到 user message = 注入被拒（sendable 门）。标 rejected + 回执，不静默。
    const reason = statusReject ?? "inject produced no user message"
    this.deps.db.db
      .prepare(
        "UPDATE channel_inbound_ledger SET state = 'rejected', error = ?, updated_at = ? WHERE id = ?",
      )
      .run(reason, this.deps.now(), row.id)
    this.audit("inject-rejected", { bindingId: binding.id, chatId: row.external_chat_id, reason })
    if (statusReject) {
      try {
        await this.deps.sender.sendText(row.external_chat_id, reason)
      } catch (err) {
        this.audit("reject-receipt-failed", { chatId: row.external_chat_id, err: String(err) })
      }
    }
    return "rejected"
  }

  // ── DB helpers ──

  private getOrCreateBinding(msg: InboundChannelMessage): BindingRow | null {
    const existing = this.getBindingByChat(msg.externalChatId)
    if (existing) return existing
    // 播种（D3：env/管理面仅 bootstrap，SQLite binding 行是运行时真相源）：
    // p2p 用 bindSessionGroup（config 必填恒有）；群用该群的 groupBindings 种子。
    const cfg = this.cfg()
    const seed =
      msg.chatKind === "group" ? cfg.groupBindings[msg.externalChatId] : cfg.bindSessionGroup
    if (!seed) return null // 仅群可能走到：种子缺失且库内无既有 binding
    const id = this.deps.genId()
    this.deps.db.db
      .prepare(
        `INSERT INTO channel_bindings (id, connector_id, external_chat_id, chat_kind, session_group_id, default_provider, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        cfg.connectorId,
        msg.externalChatId,
        msg.chatKind,
        seed,
        cfg.defaultProvider,
        this.deps.now(),
      )
    return {
      id,
      external_chat_id: msg.externalChatId,
      chat_kind: msg.chatKind,
      session_group_id: seed,
      default_provider: cfg.defaultProvider,
    }
  }

  private getBindingByChat(externalChatId: string): BindingRow | null {
    return (
      (this.deps.db.db
        .prepare(
          "SELECT id, external_chat_id, chat_kind, session_group_id, default_provider FROM channel_bindings WHERE connector_id = ? AND external_chat_id = ?",
        )
        .get(this.cfg().connectorId, externalChatId) as BindingRow | undefined) ?? null
    )
  }

  private getBindingById(bindingId: string): BindingRow | null {
    return (
      (this.deps.db.db
        .prepare(
          "SELECT id, external_chat_id, chat_kind, session_group_id, default_provider FROM channel_bindings WHERE id = ?",
        )
        .get(bindingId) as BindingRow | undefined) ?? null
    )
  }

  /** UNIQUE 冲突 → false（duplicate）；成功 → true。seq 全局单调。 */
  private tryInsertInbound(msg: InboundChannelMessage, bindingId: string): boolean {
    const seq =
      (
        this.deps.db.db
          .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM channel_inbound_ledger")
          .get() as { n: number }
      ).n ?? 1
    const ts = this.deps.now()
    try {
      this.deps.db.db
        .prepare(
          `INSERT INTO channel_inbound_ledger
             (id, connector_id, external_chat_id, external_message_id, binding_id, sender_open_id, content, seq, state, attachments, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(
          this.deps.genId(),
          msg.connectorId,
          msg.externalChatId,
          msg.externalMessageId,
          bindingId,
          msg.senderOpenId,
          msg.text,
          seq,
          // AC16：附件随账本持久化（queued 行重启后不丢）；无附件 NULL
          msg.attachments && msg.attachments.length > 0 ? JSON.stringify(msg.attachments) : null,
          ts,
          ts,
        )
      return true
    } catch (err) {
      if (String(err).includes("UNIQUE")) return false
      throw err
    }
  }

  private getOldestQueued(bindingId: string): InboundRow | null {
    return (
      (this.deps.db.db
        .prepare(
          // 德彪 r1 P3-1：seq 非事务分配，并发下可能并列 → 加 created_at/id 稳定兜底排序
          "SELECT id, binding_id, content, external_chat_id, sender_open_id, attachments FROM channel_inbound_ledger WHERE binding_id = ? AND state = 'queued' ORDER BY seq ASC, created_at ASC, id ASC LIMIT 1",
        )
        .get(bindingId) as InboundRow | undefined) ?? null
    )
  }

  private getInjectedByRoot(
    rootMessageId: string,
  ): { binding_id: string; external_chat_id: string } | null {
    return (
      (this.deps.db.db
        .prepare(
          "SELECT binding_id, external_chat_id FROM channel_inbound_ledger WHERE root_message_id = ? AND state = 'injected' LIMIT 1",
        )
        .get(rootMessageId) as { binding_id: string; external_chat_id: string } | undefined) ?? null
    )
  }

  /** UNIQUE 冲突 → false（已处理过，幂等）；成功 → true。AC13.5：带 root/起笔锚+rowid tie 键，held 落 held_order+hold_since */
  private tryRegisterOutbound(
    bindingId: string,
    internalMessageId: string,
    order: {
      rootMessageId: string | null
      messageCreatedAt: string | null
      messageOrderSeq: number | null
      held: boolean
    },
  ): boolean {
    const ts = this.deps.now()
    try {
      this.deps.db.db
        .prepare(
          `INSERT INTO channel_outbound_ledger
             (id, binding_id, internal_message_id, state, attempts, possible_duplicate, created_at, updated_at, root_message_id, message_created_at, message_order_seq, hold_since)
           VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.deps.genId(),
          bindingId,
          internalMessageId,
          order.held ? "held_order" : "pending",
          ts,
          ts,
          order.rootMessageId,
          order.messageCreatedAt,
          order.messageOrderSeq,
          order.held ? ts : null,
        )
      return true
    } catch (err) {
      if (String(err).includes("UNIQUE")) return false
      throw err
    }
  }

  private setOutboundState(
    bindingId: string,
    internalMessageId: string,
    state: "pending" | "attempted" | "sent" | "failed_terminal",
    opts: { bumpAttempts?: boolean; error?: string; markDuplicate?: boolean } = {},
  ): void {
    this.deps.db.db
      .prepare(
        `UPDATE channel_outbound_ledger
           SET state = ?,
               attempts = attempts + ?,
               possible_duplicate = CASE WHEN ? = 1 THEN 1 ELSE possible_duplicate END,
               last_error = ?,
               updated_at = ?
         WHERE binding_id = ? AND internal_message_id = ?`,
      )
      .run(
        state,
        opts.bumpAttempts ? 1 : 0,
        opts.markDuplicate ? 1 : 0,
        opts.error ?? null,
        this.deps.now(),
        bindingId,
        internalMessageId,
      )
  }
}
