import { randomUUID } from "node:crypto"
import fs from "node:fs"
import * as lark from "@larksuiteoapi/node-sdk"
import type { SqliteStore } from "../../db/sqlite"
import { containedUploadPath, uploadBasename } from "../../lib/upload-path"
import { createSafeHttpClient } from "../../net/safe-http-client"
import type { ChannelAdminStore } from "../channel-admin-store"
import type { FeishuChannelConfig } from "../channel-config"
import { ChannelGateway, type ChannelGatewayDeps } from "../channel-gateway"
import type { ChannelCommandHandler, FinalMessage, MessageInjector } from "../channel-types"
import { parseFeishuMessageEvent } from "./feishu-event-parser"
import { downloadFeishuMedia } from "./feishu-media"
import { createFeishuSender } from "./feishu-sender"
import { FeishuTokenManager } from "./feishu-token-manager"

/**
 * F040 T14：飞书 connector 生命周期。
 * transport（WS 长连接，包 lark.WSClient）产出 im.message.receive_v1 的 event data →
 * parser → gateway.handleInbound。单事件处理异常被吞（审计），不击穿长连接（AC1）。
 */

/** WS 长连接抽象：SDK WSClient 的最小接口（真实现包 lark.WSClient；测试用 fake）。 */
export type FeishuWsTransport = {
  /** 建连并注册事件回调（SDK 自带重连；onEvent 收到的是 im.message.receive_v1 的 event data） */
  start(onEvent: (data: unknown) => Promise<void> | void): Promise<void>
  stop(): Promise<void>
}

export type FeishuConnectorHandle = {
  stop(): Promise<void>
}

export type StartFeishuConnectorDeps = {
  transport: FeishuWsTransport
  gateway: ChannelGateway
  /** 单事件处理异常回调（默认 console.warn）；不 rethrow（保长连接不断） */
  onError?: (err: unknown) => void
  /** 机器人自身 open_id（群 @bot 判定要素）；null = 群消息 fail-closed 忽略 */
  botOpenId?: string | null
  /** T4 fixture 校准用：群事件 raw JSON 落日志（FEISHU_DEBUG_EVENTS=1 开） */
  debugRawEvents?: boolean
  /**
   * AC16：入站媒体下载（wire 组装 feishu-media 真实现；缺省=不下载）。
   * 失败降级：attachments 空，text 标签（[图片]/[文件] 名）照常注入——文本仍有信息量。
   */
  downloadMedia?: (input: {
    messageId: string
    kind: "image" | "file"
    key: string
    name: string
  }) => Promise<{ ok: true; url: string } | { ok: false; error: string }>
}

export async function startFeishuConnector(
  deps: StartFeishuConnectorDeps,
): Promise<FeishuConnectorHandle> {
  const onError = deps.onError ?? ((err) => console.warn("[F040:feishu-event-error]", err))

  try {
    await deps.transport.start(async (data) => {
      try {
        if (deps.debugRawEvents) {
          const chatType = asRecordSafe(asRecordSafe(data)?.message)?.chat_type
          if (chatType === "group") {
            console.warn("[F040:raw-group-event]", JSON.stringify(data))
          }
        }
        const parsed = parseFeishuMessageEvent(data, { botOpenId: deps.botOpenId ?? null })
        if ("skip" in parsed) return
        // AC16：媒体两阶段——先下载落盘转本地 URL，再交 gateway（gateway 渠道无关，
        // 只认 attachments）。下载失败/未配下载器 → 降级纯文本标签注入 + 审计。
        // guardian P3 发现1：下载前先过零副作用预检——门会拒的消息（非白名单群/
        // 陌生成员/未 @）不落盘，否则拒绝路径也能往 uploads 塞孤儿文件（填盘面）。
        if (parsed.media) {
          const precheckOk = deps.gateway.precheckInbound(parsed)
          const dl = deps.downloadMedia && precheckOk ? deps.downloadMedia : undefined
          if (dl) {
            const got = await dl({
              messageId: parsed.externalMessageId,
              kind: parsed.media.kind,
              key: parsed.media.key,
              name: parsed.media.name,
            })
            if (got.ok) {
              parsed.attachments = [
                { kind: parsed.media.kind, url: got.url, name: parsed.media.name },
              ]
            } else {
              onError(new Error(`[F040:media-download-failed] ${got.error}`))
            }
          }
          // T7 修9（德彪 r7 P2）：只有预检通过的消息才清描述符（下载成败/未配下载器
          // 都已定型为 attachments / 降级标签）；预检拒的保留原形态给真门复判——
          // 否则真门看到「无 @ 无媒体」退化 ignored_no_mention，rejected_group
          // 审计 / 未绑定回执全丢（预检契约是「零副作用预测」，不是「改写消息」）。
          if (precheckOk) parsed.media = null
        }
        await deps.gateway.handleInbound(parsed)
      } catch (err) {
        // 单条事件失败不能击穿长连接（否则一条毒消息 = 全渠道瘫）
        onError(err)
      }
    })
  } catch (err) {
    // 德彪 r1 P2-1：初次建连失败（凭证错/网络）不能击穿主服务 boot；SDK 自带重连会持续尝试。
    onError(err)
  }

  return {
    async stop() {
      await deps.transport.stop()
    },
  }
}

function asRecordSafe(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null
}

/**
 * boot 时取机器人自身 open_id（群 @bot 判定要素；真机 07-04 已验 bot/v3/info 可用）。
 * 任何失败 → null（群模式 fail-closed 关闭，p2p 零影响），不击穿 boot。
 */
export async function fetchBotOpenId(
  http: import("../../net/safe-http-client").SafeHttpClient,
  getToken: () => Promise<string>,
): Promise<string | null> {
  try {
    const token = await getToken()
    const res = await http.request("https://open.feishu.cn/open-apis/bot/v3/info", {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(res.text) as { code?: number; bot?: { open_id?: string } }
    if (body.code !== 0 || typeof body.bot?.open_id !== "string") return null
    return body.bot.open_id
  } catch {
    return null
  }
}

/** 真实 WS transport：包 lark.WSClient 长连接（SDK 自带重连）。不进单测（AC9 真机 capstone）。 */
export function createFeishuWsTransport(opts: {
  appId: string
  appSecret: string
}): FeishuWsTransport {
  let client: lark.WSClient | null = null
  return {
    async start(onEvent) {
      const dispatcher = new lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data: unknown) => {
          await onEvent(data)
        },
      })
      client = new lark.WSClient({ appId: opts.appId, appSecret: opts.appSecret })
      await client.start({ eventDispatcher: dispatcher })
    },
    async stop() {
      client?.close({ force: true })
    },
  }
}

/** invocation.finished / failed 事件里 gateway 需要的字段 */
type FinishedLike = {
  assistantMessageId: string | null
  rootMessageId: string | null
  /** Leg B 同毫秒平局自排除用（事件带 identity.invocationId） */
  invocationId?: string | null
}

export type WireFeishuDeps = {
  config: FeishuChannelConfig
  db: SqliteStore
  /**
   * Phase 2.5（AC-M1/M2）：渠道授权 DB 真相源。提供时 env 白名单/群配置降为首启种子
   * （表空才导），网关配置走 store 快照 getter（管理面写 → 下一条消息即生效）；
   * 🔴 必须与管理路由共享同一实例（缓存失效在实例内闭环）。缺省 = 纯 env 静态（兼容）。
   */
  adminStore?: ChannelAdminStore
  injector: MessageInjector
  findThread: (sessionGroupId: string, provider: string) => { id: string } | null
  readFinalContent: (messageId: string) => FinalMessage | null
  /** AC13.5 Leg B：同 root 起笔更早（含同毫秒平局）的在飞 turn（生产接 message-service；缺省=不阻塞） */
  hasEarlierRunningTurn?: (
    rootMessageId: string,
    beforeCreatedAt: string,
    excludeInvocationId?: string,
  ) => boolean
  eventBus: {
    on(type: "invocation.finished" | "invocation.failed", handler: (e: FinishedLike) => void): void
  }
  /**
   * P2.6（AC-N1/N2）命令面 executor（server.ts 装配 ChannelCommandExecutor）。
   * 缺省 = 命令面关（`/` 文本走注入链，Phase 1/2 语义原样）。
   */
  commands?: ChannelCommandHandler
  /** 测试注入 fake transport；默认真 SDK WS */
  transportFactory?: (opts: { appId: string; appSecret: string }) => FeishuWsTransport
  /** 测试注入 fake sender（命令回执断言用——默认真 FeishuSender 会走网络） */
  senderOverride?: import("../channel-types").ChannelSender
  /**
   * P3（AC16）入站媒体落盘目录（= server config uploadsDir，/uploads 静态服务同目录）。
   * 缺省 = 媒体不下载（降级纯文本标签注入）。
   */
  mediaDir?: string
  genId?: () => string
  now?: () => string
}

/**
 * F040 boot 接线聚合：config disabled → 不构建任何对象、只 log（AC1 主服务零影响）；
 * enabled → SafeHttpClient(open.feishu.cn) + TokenManager + Sender + gateway + 订阅 eventBus
 * + 启动 transport + reconcileOnBoot。返回 handle 供 onClose 停连。
 */
export async function wireFeishuConnector(
  deps: WireFeishuDeps,
): Promise<FeishuConnectorHandle | null> {
  const cfg = deps.config
  if (!cfg.enabled) {
    console.info(`[F040] Feishu connector disabled: ${cfg.reason}`)
    return null
  }

  const http = createSafeHttpClient({ allowedHosts: ["open.feishu.cn"] })
  const tokenMgr = new FeishuTokenManager({ appId: cfg.appId, appSecret: cfg.appSecret, http })
  const sender =
    deps.senderOverride ??
    createFeishuSender({
      http,
      getToken: () => tokenMgr.getToken(),
      invalidate: () => tokenMgr.invalidate(),
    })
  // Phase 2.5（AC-M1/M2）：adminStore 提供 → env 种子导入一次 + 配置走 store 快照 getter
  // （热生效）；缺省 → Phase 1/2 纯 env 静态配置原样。
  const adminStore = deps.adminStore
  let gatewayConfig: ChannelGatewayDeps["config"]
  if (adminStore) {
    const seeded = adminStore.seedFromEnv({
      allowedOpenIds: cfg.allowedOpenIds,
      groupMembers: cfg.groupMembers,
      allowedGroupChats: cfg.allowedGroupChats,
      groupBindings: cfg.groupBindings,
    })
    if (seeded.seededMembers > 0 || seeded.seededGroups > 0) {
      console.info(
        `[F040] 渠道授权 env 种子导入：members=${seeded.seededMembers} groups=${seeded.seededGroups}（此后 DB 为真相源，管理页维护）`,
      )
    }
    gatewayConfig = () => ({
      connectorId: "feishu",
      bindSessionGroup: cfg.bindSessionGroup,
      defaultProvider: cfg.defaultProvider,
      ...adminStore.getAuthView(),
    })
  } else {
    gatewayConfig = {
      connectorId: "feishu",
      allowedOpenIds: cfg.allowedOpenIds,
      bindSessionGroup: cfg.bindSessionGroup,
      defaultProvider: cfg.defaultProvider,
      allowedGroupChats: cfg.allowedGroupChats,
      groupMembers: cfg.groupMembers,
      groupBindings: cfg.groupBindings,
    }
  }
  const gateway = new ChannelGateway({
    db: deps.db,
    injector: deps.injector,
    sender,
    readFinalMessage: deps.readFinalContent,
    resolveThread: (sg, p) => deps.findThread(sg, p)?.id ?? null,
    hasEarlierRunningTurn: deps.hasEarlierRunningTurn,
    config: gatewayConfig,
    recordReject: adminStore ? (r) => adminStore.recordReject(r) : undefined,
    commands: deps.commands,
    // AC16 出站媒体：/uploads URL → 字节（mediaDir 提供才开）。T7 修10（德彪 r7 P2）：
    // 与 resolveAttachmentPath / final-message-reader 共用 upload-path 闸——裸 basename
    // 挡不住 "."/".."（resolve 逃容器），共享闸显式除名 + relative 复核。
    readUploadFile: deps.mediaDir
      ? (url) => {
          try {
            const name = uploadBasename(url)
            if (!name) return null
            const p = containedUploadPath(deps.mediaDir as string, name)
            if (!p) return null
            return new Uint8Array(fs.readFileSync(p))
          } catch {
            return null
          }
        }
      : undefined,
    // T7 真机修：注入正文附落盘绝对路径（CLI agent 用 Read/shell 真能看附件）；
    // 同 readUploadFile 的共享闸容器语义，闸外形态返 null 不附
    resolveAttachmentPath: deps.mediaDir
      ? (url) => {
          const name = uploadBasename(url)
          if (!name) return null
          return containedUploadPath(deps.mediaDir as string, name)
        }
      : undefined,
    genId: deps.genId ?? (() => randomUUID()),
    now: deps.now ?? (() => new Date().toISOString()),
  })

  const onFinished = (e: FinishedLike) => {
    void gateway.onInvocationFinished({
      assistantMessageId: e.assistantMessageId ?? null,
      rootMessageId: e.rootMessageId ?? null,
      invocationId: e.invocationId ?? null,
    })
  }
  deps.eventBus.on("invocation.finished", onFinished)
  deps.eventBus.on("invocation.failed", onFinished)

  // 群模式要素：bot 自身 open_id（@bot 判定）。取不到 → 群 fail-closed 忽略，p2p 零影响。
  const botOpenId = await fetchBotOpenId(http, () => tokenMgr.getToken())
  const effectiveGroups =
    typeof gatewayConfig === "function"
      ? gatewayConfig().allowedGroupChats
      : gatewayConfig.allowedGroupChats
  if (!botOpenId && effectiveGroups.length > 0) {
    console.warn("[F040] 群模式受限：bot open_id 获取失败，@bot 判定关闭（群消息将被忽略）")
  }

  const factory = deps.transportFactory ?? createFeishuWsTransport
  const transport = factory({ appId: cfg.appId, appSecret: cfg.appSecret })
  // AC16：入站媒体下载器（mediaDir 提供才组装；同 http/token 栈）
  const mediaDir = deps.mediaDir
  const handle = await startFeishuConnector({
    transport,
    gateway,
    botOpenId,
    debugRawEvents: cfg.debugEvents,
    downloadMedia: mediaDir
      ? (input) =>
          downloadFeishuMedia({ http, getToken: () => tokenMgr.getToken(), mediaDir }, input)
      : undefined,
  })
  await gateway.reconcileOnBoot()

  // AC13.5 sweeper：held_order 超时强制放行（卡死 agent 不饿死投递）。30s tick
  // （阈值 60s 的一半，最坏 1.5 倍阈值放行）；unref 不阻进程退出。
  const sweepTimer = setInterval(() => {
    void gateway.sweepHeldOrders().catch((err) => {
      console.warn("[F040:order-sweep-error]", String(err))
    })
    // AC15：占位卡超时兜底（sent 超 15min → PATCH 超时文案 + expired）
    void gateway.sweepPlaceholders().catch((err) => {
      console.warn("[F040:placeholder-sweep-error]", String(err))
    })
  }, 30_000)
  sweepTimer.unref?.()

  console.info("[F040] Feishu connector started (WS long-connection)")
  return {
    async stop() {
      clearInterval(sweepTimer)
      await handle.stop()
    },
  }
}
