import type { ChatKind, InboundChannelMessage } from "../channel-types"

/**
 * F040 T4：解析飞书 im.message.receive_v1 的 WS handler data（官方类型
 * `@larksuiteoapi/node-sdk` index.d.ts:298718，无 header envelope）。
 * 只解析文本 p2p/group，其余（媒体/未知类型/破损）→ { skip }。
 * chat_kind 仅标注，授权/群门由 ChannelGateway 判（parser 不做策略）。
 */

export type ParseSkip = { skip: string }

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null
}

/**
 * 群消息 mentions 项（官方 im.message.receive_v1 schema；07-04 真机 fixture 已校准一致）。
 * 真机另有 mentioned_type:"bot"/"user" 字段——不依赖它判 @bot：open_id 精确比对在多 bot
 * 群里不会把 @别家 bot 误判成 @我们（mentioned_type 只能判「是个 bot」）。
 */
type FeishuMention = { key: string; openId: string | null; name: string }

function parseMentions(message: Record<string, unknown>): FeishuMention[] {
  const raw = message.mentions
  if (!Array.isArray(raw)) return []
  const out: FeishuMention[] = []
  for (const item of raw) {
    const rec = asRecord(item)
    if (!rec || typeof rec.key !== "string") continue
    const openId = asRecord(rec.id)?.open_id
    out.push({
      key: rec.key,
      openId: typeof openId === "string" ? openId : null,
      name: typeof rec.name === "string" ? rec.name : "",
    })
  }
  return out
}

/**
 * 群文本的 mention 占位符处理（Phase 2 T5 · 合同 #8）：
 * - bot 自身占位符整体剥除 + 首行 trimStart —— 「@bot @范德彪 …」剥后 @范德彪 保行首
 *   （classifyMention 行首 walk-left / user 路径 anywhere 派发都吃得到）
 * - 非 bot 占位符替换为**不带 @ 的**展示名：飞书人名是不可信输入，user 路径
 *   enqueuePublicMentions 按 anywhere 匹配 @花名——若有人改名「范德彪」被 @ 一下，
 *   带 @ 渲染就成了免白名单的派发注入面；去 @ 渲染只留可读性，零派发面。
 */
function stripMentionPlaceholders(
  text: string,
  mentions: FeishuMention[],
  botOpenId: string | null,
): string {
  let out = text
  for (const m of mentions) {
    if (botOpenId && m.openId === botOpenId) {
      out = out.split(m.key).join("")
    } else {
      out = out.split(m.key).join(m.name.replaceAll("@", ""))
    }
  }
  // 只削首行行首空白（bot 占位剥除残留），正文其余空白原样（r1 P3-2 语义）
  const nl = out.indexOf("\n")
  if (nl < 0) return out.trimStart()
  return out.slice(0, nl).trimStart() + out.slice(nl)
}

export function parseFeishuMessageEvent(
  data: unknown,
  opts: { botOpenId?: string | null } = {},
): InboundChannelMessage | ParseSkip {
  const root = asRecord(data)
  if (!root) return { skip: "event not an object" }

  const message = asRecord(root.message)
  if (!message) return { skip: "missing message" }

  const chatType = message.chat_type
  if (chatType !== "p2p" && chatType !== "group") {
    return { skip: `unsupported chat_type ${String(chatType)}` }
  }
  const chatKind: ChatKind = chatType

  const messageType = message.message_type
  if (messageType !== "text" && messageType !== "image" && messageType !== "file") {
    return { skip: `unsupported message_type ${String(messageType)}` }
  }

  const chatId = message.chat_id
  const messageId = message.message_id
  if (typeof chatId !== "string" || typeof messageId !== "string") {
    return { skip: "missing chat_id/message_id" }
  }

  const senderOpenId = asRecord(asRecord(root.sender)?.sender_id)?.open_id
  if (typeof senderOpenId !== "string" || senderOpenId.length === 0) {
    return { skip: "missing sender open_id" }
  }

  // F040 P3 AC16：媒体消息（image/file）——content 里是飞书 key，下载归 connector 层
  // （parser 无 IO）。text 置标签供房间正文/归因前缀复用既有链路；群门语义：媒体消息
  // 无 mentions（飞书 image/file 不能带 @）→ 群里发裸图不 @bot 落「未 @」忽略分支，
  // 与文本同一 fail-closed 门。official schema 待真机 fixture 校准（P2 T4 同款打法）。
  if (messageType === "image" || messageType === "file") {
    let mediaContent: Record<string, unknown> | null
    try {
      mediaContent = asRecord(JSON.parse(message.content as string))
    } catch {
      return { skip: "media content not valid JSON" }
    }
    const key = messageType === "image" ? mediaContent?.image_key : mediaContent?.file_key
    if (typeof key !== "string" || key.length === 0) {
      return { skip: `media message missing ${messageType} key` }
    }
    const rawName = mediaContent?.file_name
    const name =
      typeof rawName === "string" && rawName.length > 0
        ? rawName
        : messageType === "image"
          ? "图片"
          : "文件"
    return {
      connectorId: "feishu",
      externalChatId: chatId,
      externalMessageId: messageId,
      senderOpenId,
      chatKind,
      text: messageType === "image" ? "[图片]" : `[文件] ${name}`,
      mentionsBot: chatKind === "p2p", // 群裸媒体无 mentions → 未 @，fail-closed
      senderName: null,
      media: { kind: messageType, key, name },
    }
  }

  let parsedContent: Record<string, unknown> | null
  try {
    parsedContent = asRecord(JSON.parse(message.content as string))
  } catch {
    return { skip: "content not valid JSON" }
  }
  const rawText = parsedContent?.text
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    return { skip: "empty or non-string text" }
  }

  // 群：mentions 判 @bot + 占位符处理；未注入 botOpenId（boot 拿不到 bot 身份）→
  // mentionsBot 恒 false = 群消息全落「未 @」忽略分支，fail-closed 等效 Phase 1 拒群。
  const botOpenId = opts.botOpenId ?? null
  const mentions = chatKind === "group" ? parseMentions(message) : []
  const mentionsBot =
    chatKind === "p2p"
      ? true // 私聊即对话
      : botOpenId !== null && mentions.some((m) => m.openId === botOpenId)
  const text =
    chatKind === "group" ? stripMentionPlaceholders(rawText, mentions, botOpenId) : rawText
  if (text.trim().length === 0) {
    return { skip: "empty after mention strip" } // 纯 @bot 无正文
  }

  return {
    connectorId: "feishu",
    externalChatId: chatId,
    externalMessageId: messageId,
    senderOpenId,
    chatKind,
    // 德彪 r1 P3-2：trim 仅用于判空，注入正文保留原样（前后空白/换行在命令/引用场景有语义）
    text,
    mentionsBot,
    // 归因昵称是 gateway 按成员白名单填的策略产物，parser 不做策略（恒 null）。
    senderName: null,
  }
}
