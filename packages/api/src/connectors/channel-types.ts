import type { RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared"

/** F040 渠道网关：渠道无关的核心类型（Phase 2 企微/群复用同一套）。 */

export type ChatKind = "p2p" | "group"

/** 适配件（feishu-event-parser 等）产出、gateway 消费的统一入站消息。 */
export type InboundChannelMessage = {
  connectorId: string
  externalChatId: string
  externalMessageId: string
  senderOpenId: string
  chatKind: ChatKind
  text: string
  /**
   * 是否 @ 了机器人（Phase 2 群门要素之一）。p2p 恒 true（私聊即对话）；
   * group 由 parser 比对 event mentions 与 bot open_id 得出（T5，fixture 校准前恒 false =
   * 群消息全部落在「未 @」静默忽略分支，与 Phase 1 拒群行为等效 fail-closed）。
   */
  mentionsBot: boolean
  /**
   * 归因昵称（Phase 2 群桥接）：gateway 按成员白名单填（owner 配置命名，非用户自报）；
   * p2p / 白名单未命中 = null（p2p 注入不加归因前缀）。parser 层恒 null（不做策略）。
   */
  senderName: string | null
  /**
   * F040 P3 AC16 入站媒体两阶段：parser 出 media（未下载的飞书 key，text 已置
   * 「[图片]」/「[文件] 名」标签）→ connector 下载落盘后转 attachments（本地
   * /uploads URL）并清 media。gateway 只消费 attachments（渠道无关），随账本
   * 持久化（queued 行重启后附件不丢），注入时转 send_message.contentBlocks。
   */
  media?: { kind: "image" | "file"; key: string; name: string } | null
  attachments?: Array<{ kind: "image" | "file"; url: string; name: string }>
}

/**
 * 出站终稿（gateway 从 readFinalMessage 拿到、递给 sender）。
 * senderAlias = 产出该终稿的 agent 花名（多 agent 协作链回投时手机端的署名依据，
 * 小孙真机反馈「无法知道是哪个 agent 回复的」）；查不到线程时为 null（无署名投递）。
 */
export type FinalMessage = {
  content: string
  senderAlias: string | null
  /** 房间起笔时刻（messages.created_at）——AC13.5 顺序投递的排序键；查不到时 null（legacy ready） */
  createdAt: string | null
  /**
   * 同毫秒 tie-breaker（德彪 P2 审 r1 P2-2）：messages.rowid——房间 UI 按
   * (created_at, rowid) 排序，顺序门必须同键，否则同毫秒双 final 退化成完成序。
   * null = legacy/查不到（平局不判，维持 created_at-only 语义）。
   */
  orderSeq: number | null
  /**
   * P2.6 AC-N4：产出该终稿的真实模型 id（messages.model，F021 追加时冻结的快照——
   * 比 config 现读诚实：改配置不改历史）。可选字段（既有 fake 零翻改）；生产 reader
   * 恒填，null = F021 前旧行/relay 行 → 卡片退回纯花名。
   */
  model?: string | null
  /**
   * P3 AC16 出站：终稿 content_blocks 里的媒体（agent 截图/产物）。可选（fake 零翻改）；
   * 生产 reader 解析 messages.content_blocks 过滤 image/file。url=/uploads/… 本地约定。
   */
  mediaBlocks?: Array<{ kind: "image" | "file"; url: string; name: string }>
}

/** 出站发送面（feishu-sender 实现；测试用 fake）。 */
export type ChannelSender = {
  sendText(
    externalChatId: string,
    text: string,
    opts?: {
      senderAlias?: string | null
      model?: string | null
      /** AC15：占位卡 message_id——首片 PATCH 原地变身（终态失败降级 POST），后续片正常 POST */
      replacePlaceholder?: string
    },
  ): Promise<
    | { ok: true }
    | {
        ok: false
        error: string
        terminal: boolean
        /**
         * 德彪 P3-r1 P1-2：失败但占位卡已被 PATCH 成功（长文本首片变身后余片失败）。
         * gateway 凭它决定不回滚认领——否则 sweeper 会把已变身终稿首片的卡再 PATCH
         * 成超时文案毁内容；余片由 reconcile 以 POST 补投（占位卡已非 'sent' 不再 PATCH）。
         */
        placeholderConsumed?: boolean
      }
  >
  /**
   * AC15：发「思考中」占位卡，返回渠道 message_id 供后续 PATCH。
   * optional——不实现的渠道（及存量 fake）自动没有占位卡行为。
   */
  sendPlaceholder?(
    externalChatId: string,
  ): Promise<{ ok: true; messageId: string } | { ok: false; error: string }>
  /** AC15：PATCH 已发卡片（失败/超时收尾文案用）。best-effort，失败只审计。 */
  patchCard?(
    messageId: string,
    opts: { text: string; senderAlias?: string | null; model?: string | null },
  ): Promise<{ ok: boolean; error?: string }>
  /**
   * AC16 出站：上传媒体拿 key → 发 image/file 消息（跟在署名卡后）。
   * bytes 由 gateway 侧 readUploadFile 提供（fs 集中装配层）；失败只审计不回滚账本。
   */
  sendMedia?(
    externalChatId: string,
    media: { kind: "image" | "file"; name: string; data: Uint8Array },
  ): Promise<{ ok: true } | { ok: false; error: string }>
}

/**
 * MessageService 的最小注入缝合面（gateway 不依赖 MessageService 具体类，
 * 便于单测 fake + 避免循环依赖）。
 */
export type MessageInjector = {
  handleClientEvent(event: RealtimeClientEvent, emit: (e: RealtimeServerEvent) => void): void
  getBusyStatus(threadId: string, sessionGroupId: string): string | null
}

/**
 * P2.6 AC-N1/N2 命令面：gateway 门后旁路把 `/` 前缀消息递给 executor，
 * 返回值 = 回执文本（markdown，只回飞书不进房间）。owner 判定/幂等/异常收口
 * 都在 gateway；executor 只做纯命令语义（channel-commands.ts 实现，server.ts 装配）。
 */
export type ChannelCommandContext = {
  chatId: string
  chatKind: ChatKind
  senderOpenId: string
  /** trim 后的原始命令文本（含 `/` 前缀） */
  text: string
  /** 当前 chat 的 binding 现值（channel_bindings 运行时真相源）；未建 → null */
  binding: { sessionGroupId: string; defaultProvider: string } | null
  /** 渠道级种子（p2p 建 binding / 显示渠道默认用） */
  channelDefaults: { bindSessionGroup: string; defaultProvider: string }
}

export type ChannelCommandHandler = {
  execute(ctx: ChannelCommandContext): Promise<string>
}
