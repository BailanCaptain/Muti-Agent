import { type SafeHttpClient, buildMultipartBody } from "../../net/safe-http-client"
import type { ChannelSender } from "../channel-types"

/**
 * F040 T13：飞书文本发送（ChannelSender 实现，AC3 回推）。
 * REST 走注入 SafeHttpClient（host pin open.feishu.cn，D9）。长文本分片；
 * token 失效 → invalidate + 重试一次；错误分 terminal / 非 terminal（后者由出站 reconcile 补投）。
 */

const MESSAGES_URL = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id"
/** AC15：PATCH /im/v1/messages/:id 更新卡片（终态 schema 1.7；真机 T7 校准） */
const MESSAGE_ITEM_URL = "https://open.feishu.cn/open-apis/im/v1/messages/"
/** AC16 出站：上传拿 key（终态 schema 1.7；真机 T7 校准） */
const IMAGES_URL = "https://open.feishu.cn/open-apis/im/v1/images"
const FILES_URL = "https://open.feishu.cn/open-apis/im/v1/files"
const DEFAULT_MAX_CHUNK = 2000
/** AC15：占位卡文案（无署名头——发卡时还不知道哪个 agent 接活） */
const PLACEHOLDER_MARKDOWN = "⏳ 收到，正在思考…"

/** 飞书 file_type 闭集映射（上传文件 API 必填）；未知扩展名走 stream 通用型 */
function feishuFileType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  if (ext === "mp4") return "mp4"
  if (ext === "pdf") return "pdf"
  if (ext === "doc" || ext === "docx") return "doc"
  if (ext === "xls" || ext === "xlsx") return "xls"
  if (ext === "ppt" || ext === "pptx") return "ppt"
  if (ext === "opus") return "opus"
  return "stream"
}

/**
 * 飞书 tenant_access_token 失效相关错误码。
 * ⚠️ 待真机校准（Measure Before Assert）：99991663=token 失效为常见值，AC9 真机验证时
 * 对照 open.feishu.cn 官方码表补全；此处保守只认几个明确的 token 码，其余按 terminal 处理。
 */
const TOKEN_INVALID_CODES = new Set([99991663, 99991661, 99991664, 99991000])

/**
 * 署名头配色（飞书卡片 header template 白名单色）：每个 agent 固定一色，
 * 手机端扫一眼就知道谁在说话。未知花名（未来新 agent）→ turquoise 兜底。
 */
const HEADER_TEMPLATE_BY_ALIAS: Record<string, string> = {
  黄仁勋: "blue",
  范德彪: "orange",
  桂芬: "green",
}

export type FeishuSenderDeps = {
  http: SafeHttpClient
  getToken: () => Promise<string>
  invalidate: () => void
  maxChunk?: number
}

/** tokenInvalid：token 重试后仍失效的终态标记（r4 P2：此类终态禁进文本兜底）。 */
type SendResult =
  | { ok: true; messageId?: string; data?: Record<string, unknown>; patched?: boolean }
  | { ok: false; error: string; terminal: boolean; tokenInvalid?: boolean }

/** 卡片 JSON 构造（sendOne / patchCard 同一形状——PATCH 替换整卡，头部署名规则一致） */
function buildCardJson(
  chunk: string,
  senderAlias: string | null,
  model: string | null,
): Record<string, unknown> {
  const headerTitle = senderAlias ? (model ? `${senderAlias} · ${model}` : senderAlias) : null
  const cardJson: Record<string, unknown> = {
    elements: [{ tag: "markdown", content: chunk }],
  }
  if (senderAlias && headerTitle) {
    cardJson.header = {
      title: { tag: "plain_text", content: headerTitle },
      template: HEADER_TEMPLATE_BY_ALIAS[senderAlias] ?? "turquoise",
    }
  }
  return cardJson
}

function splitChunks(text: string, max: number): string[] {
  if (text.length <= max) return [text]
  const parts: string[] = []
  for (let i = 0; i < text.length; i += max) parts.push(text.slice(i, i + max))
  const n = parts.length
  return parts.map((p, i) => `${p} (${i + 1}/${n})`)
}

export function createFeishuSender(deps: FeishuSenderDeps): ChannelSender {
  const maxChunk = deps.maxChunk ?? DEFAULT_MAX_CHUNK

  /**
   * 底层消息 API 调用（create POST / patch PATCH 共用），含 token 失效一次重试。
   * 成功时透传 data.message_id（create 返回，patch 一般不带——caller 不依赖）。
   */
  async function callApi(
    url: string,
    method: "POST" | "PATCH",
    payload: {
      jsonBody?: Record<string, unknown>
      rawBody?: { contentType: string; body: Uint8Array }
    },
  ): Promise<SendResult> {
    let retriedOnTokenInvalid = false
    for (;;) {
      // r2 P1-new 加固：getToken 的 HTTP/解析/业务错也不外抛 —— sender 合同是返回 SendResult
      let token: string
      try {
        token = await deps.getToken()
      } catch (err) {
        return { ok: false, error: `token: ${String(err)}`, terminal: false }
      }
      let res: { status: number; text: string }
      try {
        res = await deps.http.request(url, {
          method,
          headers: { authorization: `Bearer ${token}` },
          ...(payload.jsonBody !== undefined ? { jsonBody: payload.jsonBody } : {}),
          ...(payload.rawBody !== undefined ? { rawBody: payload.rawBody } : {}),
        })
      } catch (err) {
        // SafeHttpClient 抛 = 网络/超时/安全 → 非 terminal（host 固定，实际只会是网络类）
        return { ok: false, error: `transport: ${String(err)}`, terminal: false }
      }

      // HTTP 层：5xx 非 terminal（可补），4xx 若非 token 失效则 terminal
      if (res.status >= 500) return { ok: false, error: `http ${res.status}`, terminal: false }

      let body: { code?: number; msg?: string; data?: Record<string, unknown> }
      try {
        body = JSON.parse(res.text)
      } catch {
        return { ok: false, error: `non-JSON (http ${res.status})`, terminal: res.status < 500 }
      }

      if (body.code === 0) {
        const messageId = body.data?.message_id
        return {
          ok: true,
          ...(typeof messageId === "string" && messageId.length > 0 ? { messageId } : {}),
          ...(body.data ? { data: body.data } : {}),
        }
      }

      // token 失效 → invalidate + 重试一次
      if (typeof body.code === "number" && TOKEN_INVALID_CODES.has(body.code)) {
        if (!retriedOnTokenInvalid) {
          deps.invalidate()
          retriedOnTokenInvalid = true
          continue
        }
        return {
          ok: false,
          error: `token invalid code=${body.code}`,
          terminal: true,
          tokenInvalid: true,
        }
      }

      // 其他业务错误码 → terminal（参数/权限错误，无限补投只会打扰飞书；推人工）
      return { ok: false, error: `code=${body.code} msg=${body.msg ?? "?"}`, terminal: true }
    }
  }

  /** 单 payload 发送（create 路径）。 */
  async function sendPayload(
    externalChatId: string,
    msgType: "interactive" | "text" | "image" | "file",
    content: string,
  ): Promise<SendResult> {
    return callApi(MESSAGES_URL, "POST", {
      jsonBody: {
        receive_id: externalChatId,
        msg_type: msgType,
        content,
      },
    })
  }

  /**
   * 单片发送：markdown 卡片优先（agent 终稿是 markdown，interactive 卡片按
   * clowder-ai 同款 `{tag:"markdown"}` 元素渲染，手机端可读性远好于裸 text）；
   * senderAlias 有值 → 卡片加彩色署名头（小孙真机反馈「无法知道是哪个 agent
   * 回复的」+「白条难看」，一个 header 双解；多 agent 乱序到达时靠署名区分）。
   * 卡片被**终态**拒（schema/权限类业务码）→ 同片纯文本兜底一次（宁丑勿丢，
   * 兜底文本用【花名】前缀保住署名）。非终态失败（5xx/网络/token）不击穿兜底
   * —— 出站账本 reconcile 会带卡片重投。
   */
  async function sendOne(
    externalChatId: string,
    chunk: string,
    senderAlias: string | null,
    model: string | null,
    replaceMessageId?: string,
  ): Promise<SendResult> {
    // AC-N4：署名头带真实型号（如「黄仁勋 · claude-opus-4-8」）——「调用的啥模型
    // 也不知道」从此可见。配色仍按花名 key 查表（型号后缀不参与配色）。
    const cardJson = buildCardJson(chunk, senderAlias, model)
    // AC15：有占位卡 → PATCH 原地变身。非终态失败按原样返（reconcile 重投时再 PATCH，
    // 内容相同幂等无害）；终态失败（卡被删/不可编辑类业务码）降级正常 POST（宁重复勿丢）；
    // token 终态例外——换路径解决不了凭证问题，直接返交账本推人工。
    if (replaceMessageId) {
      const patched = await callApi(
        `${MESSAGE_ITEM_URL}${encodeURIComponent(replaceMessageId)}`,
        "PATCH",
        { jsonBody: { content: JSON.stringify(cardJson) } },
      )
      // patched 标记（德彪 P3-r1 P1-2）：只有 PATCH 路径真成功才算占位卡被消费——
      // 降级 POST 成功不算（占位卡没动）
      if (patched.ok) return { ...patched, patched: true }
      if (!patched.terminal || patched.tokenInvalid) return patched
    }
    const card = await sendPayload(externalChatId, "interactive", JSON.stringify(cardJson))
    if (card.ok || !card.terminal) return card
    // r4 P2：token/auth 类终态不进文本兜底——换通道解决不了凭证问题，
    // 只会白耗 2 次网络 + 双重 invalidate；按原样返回交账本推人工。
    if (card.tokenInvalid) return card
    const headerTitle = senderAlias ? (model ? `${senderAlias} · ${model}` : senderAlias) : null
    const fallbackText = headerTitle ? `【${headerTitle}】\n${chunk}` : chunk
    const text = await sendPayload(externalChatId, "text", JSON.stringify({ text: fallbackText }))
    if (text.ok) return text
    return { ...text, error: `card: ${card.error}; text-fallback: ${text.error}` }
  }

  return {
    async sendText(externalChatId, text, opts) {
      const senderAlias = opts?.senderAlias ?? null
      const model = opts?.model ?? null
      const chunks = splitChunks(text, maxChunk)
      // 德彪 P3-r1 P1-2：跟踪占位卡是否已被 PATCH 消费——余片失败时把「部分成功」
      // 结构化透出，gateway 不回滚认领（否则 sweeper 毁已变身卡）
      let placeholderConsumed = false
      for (let i = 0; i < chunks.length; i++) {
        // AC15：占位卡只替换首片；长文本余片正常 POST 跟在后面
        const replaceId = i === 0 ? opts?.replacePlaceholder : undefined
        const r = await sendOne(externalChatId, chunks[i], senderAlias, model, replaceId)
        if (r.ok && replaceId && r.patched) placeholderConsumed = true
        if (!r.ok) {
          return placeholderConsumed ? { ...r, placeholderConsumed: true } : r
        }
      }
      return { ok: true }
    },

    async sendPlaceholder(externalChatId) {
      const res = await sendPayload(
        externalChatId,
        "interactive",
        JSON.stringify({ elements: [{ tag: "markdown", content: PLACEHOLDER_MARKDOWN }] }),
      )
      if (!res.ok) return { ok: false, error: res.error }
      if (!res.messageId) return { ok: false, error: "create ok but no message_id in response" }
      return { ok: true, messageId: res.messageId }
    },

    async patchCard(messageId, opts) {
      const cardJson = buildCardJson(opts.text, opts.senderAlias ?? null, opts.model ?? null)
      const res = await callApi(`${MESSAGE_ITEM_URL}${encodeURIComponent(messageId)}`, "PATCH", {
        jsonBody: { content: JSON.stringify(cardJson) },
      })
      return res.ok ? { ok: true } : { ok: false, error: res.error }
    },

    async sendMedia(externalChatId, media) {
      // 上传拿 key（multipart，字段形状=官方 im/v1 images|files；真机 T7 校准）
      const isImage = media.kind === "image"
      const mp = isImage
        ? buildMultipartBody(
            { image_type: "message" },
            {
              field: "image",
              filename: media.name,
              contentType: "application/octet-stream",
              data: media.data,
            },
          )
        : buildMultipartBody(
            { file_type: feishuFileType(media.name), file_name: media.name },
            {
              field: "file",
              filename: media.name,
              contentType: "application/octet-stream",
              data: media.data,
            },
          )
      const up = await callApi(isImage ? IMAGES_URL : FILES_URL, "POST", { rawBody: mp })
      if (!up.ok) return { ok: false, error: `upload: ${up.error}` }
      const key = isImage ? up.data?.image_key : up.data?.file_key
      if (typeof key !== "string" || key.length === 0) {
        return { ok: false, error: "upload ok but no key in response" }
      }
      // 发媒体消息（跟在署名卡后，独立一条）
      const sent = await sendPayload(
        externalChatId,
        isImage ? "image" : "file",
        JSON.stringify(isImage ? { image_key: key } : { file_key: key }),
      )
      return sent.ok ? { ok: true } : { ok: false, error: `send: ${sent.error}` }
    },
  }
}
