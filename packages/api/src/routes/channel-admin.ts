import { PROVIDERS } from "@multi-agent/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { AuditStatus, ChannelAdminStore } from "../connectors/channel-admin-store"
import type { SqliteStore } from "../db/sqlite"

/**
 * F040 Phase 2.5（AC-M3）：渠道管理 REST —— 群/成员 CRUD + 待放行一键放行。
 * 校验手写显式 400（F021 AC-29：拒绝非法字段，禁静默 sanitize）。
 * 🔴 adminStore 必须是与 feishu connector 共享的同一实例（AC-M2 缓存失效闭环）。
 */

type Deps = {
  adminStore: ChannelAdminStore
  /** 渠道侧 SqliteStore（session_groups 校验 / channel_bindings join 同一连接） */
  db: SqliteStore
  /**
   * P2.6 AC-N5：渠道级默认应答人（FEISHU_DEFAULT_PROVIDER，缺省 claude）——
   * 群未单独设过 binding.default_provider 时 overview 的生效值。缺省 "claude"。
   */
  channelDefaultProvider?: string
}

/** 飞书 open_id/chat_id：ASCII 可打印无空白（ou_/oc_ 前缀不强拗，别的渠道格式不同） */
const EXTERNAL_ID_RE = /^[\x21-\x7e]{1,128}$/

function isValidExternalId(v: unknown): v is string {
  return typeof v === "string" && EXTERNAL_ID_RE.test(v)
}

/** 展示名：trim 后 1-64 字，无控制字符（归因署名直接进房间正文，脏字节不收） */
function isValidDisplayName(v: unknown): v is string {
  if (typeof v !== "string") return false
  const t = v.trim()
  if (t.length === 0 || t.length > 64) return false
  for (const ch of t) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 0x20 || c === 0x7f) return false
  }
  return true
}

function isValidRole(v: unknown): v is "owner" | "participant" {
  return v === "owner" || v === "participant"
}

export function registerChannelAdminRoutes(app: FastifyInstance, deps: Deps) {
  const { adminStore, db } = deps
  const channelDefaultProvider = deps.channelDefaultProvider ?? "claude"

  function isValidProvider(v: unknown): v is string {
    return typeof v === "string" && (PROVIDERS as readonly string[]).includes(v)
  }

  /** 活房间校验（归档/删除不可绑——archived group 注入会被 fail-closed 拒，P1-2 家族） */
  function roomAlive(sessionGroupId: string): boolean {
    const row = db.db
      .prepare(
        "SELECT id FROM session_groups WHERE id = ? AND archived_at IS NULL AND deleted_at IS NULL",
      )
      .get(sessionGroupId)
    return row !== undefined
  }

  function bad(reply: FastifyReply, error: string) {
    reply.code(400)
    return { error }
  }

  // ---- 总览 ----

  app.get("/api/channel-admin/overview", async () => {
    const members = adminStore.listMembers()
    const groups = adminStore.listGroups().map((g) => {
      const binding = db.db
        .prepare(
          "SELECT session_group_id, default_provider FROM channel_bindings WHERE connector_id = ? AND external_chat_id = ?",
        )
        .get(adminStore.channel, g.chatId) as
        | { session_group_id: string; default_provider: string }
        | undefined
      // 有运行时 binding 行以它为准（真相源），否则显示种子
      const effectiveSg = binding?.session_group_id ?? g.sessionGroupId
      const room = effectiveSg
        ? (db.db.prepare("SELECT title FROM session_groups WHERE id = ?").get(effectiveSg) as
            | { title: string }
            | undefined)
        : undefined
      return {
        ...g,
        boundSessionGroupId: binding?.session_group_id ?? null,
        roomTitle: room?.title ?? null,
        // AC-N5：默认应答人生效值（binding 单独设过 ?? 渠道默认）
        effectiveDefaultProvider: binding?.default_provider ?? channelDefaultProvider,
      }
    })
    return { members, groups, pendingAudits: adminStore.listAudit("pending") }
  })

  // ---- 成员 ----

  app.post("/api/channel-admin/members", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    if (!isValidExternalId(body.openId)) {
      return bad(reply, "openId 必须是 1-128 位可打印 ASCII（无空白）。")
    }
    if (!isValidDisplayName(body.displayName)) {
      return bad(reply, "displayName 必须是 1-64 字且不含控制字符。")
    }
    const role = body.role === undefined ? "participant" : body.role
    if (!isValidRole(role)) {
      return bad(reply, "role 只能是 owner 或 participant。")
    }
    adminStore.upsertMember(body.openId, (body.displayName as string).trim(), role)
    return { ok: true }
  })

  app.patch(
    "/api/channel-admin/members/:openId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { openId } = request.params as { openId: string }
      const existing = adminStore.listMembers().find((m) => m.openId === openId)
      if (!existing) {
        reply.code(404)
        return { error: "成员不存在。" }
      }
      const body = (request.body ?? {}) as Record<string, unknown>
      if (body.displayName !== undefined && !isValidDisplayName(body.displayName)) {
        return bad(reply, "displayName 必须是 1-64 字且不含控制字符。")
      }
      if (body.role !== undefined && !isValidRole(body.role)) {
        return bad(reply, "role 只能是 owner 或 participant。")
      }
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
        return bad(reply, "enabled 必须是布尔值。")
      }
      const nextRole = (body.role as "owner" | "participant" | undefined) ?? existing.role
      const nextEnabled = (body.enabled as boolean | undefined) ?? existing.enabled
      // 末位**可用** owner 的降级/禁用 = 删除同款自锁（AC-N3：基数只数 enabled owner，
      // 否则「一禁一活删活的」按 2 放行 → 剩一个禁用 owner = p2p 永锁）
      if (
        existing.role === "owner" &&
        existing.enabled &&
        (nextRole !== "owner" || !nextEnabled) &&
        adminStore.countEnabledOwners() <= 1
      ) {
        return bad(reply, "最后一个可用 owner 不能降级或禁用（会把自己锁在门外）。")
      }
      const nextName =
        body.displayName === undefined ? existing.displayName : (body.displayName as string).trim()
      if (body.displayName !== undefined || body.role !== undefined) {
        adminStore.upsertMember(openId, nextName, nextRole)
      }
      if (body.enabled !== undefined) {
        adminStore.setMemberEnabled(openId, body.enabled as boolean)
      }
      return { ok: true }
    },
  )

  app.delete(
    "/api/channel-admin/members/:openId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { openId } = request.params as { openId: string }
      const existing = adminStore.listMembers().find((m) => m.openId === openId)
      if (!existing) {
        reply.code(404)
        return { error: "成员不存在。" }
      }
      if (existing.role === "owner" && existing.enabled && adminStore.countEnabledOwners() <= 1) {
        return bad(reply, "最后一个可用 owner 不能删除（会把自己锁在门外）。")
      }
      adminStore.removeMember(openId)
      return { ok: true }
    },
  )

  // ---- 群 ----

  app.post("/api/channel-admin/groups", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    if (!isValidExternalId(body.chatId)) {
      return bad(reply, "chatId 必须是 1-128 位可打印 ASCII（无空白）。")
    }
    if (body.displayName !== undefined && !isValidDisplayName(body.displayName)) {
      return bad(reply, "displayName 必须是 1-64 字且不含控制字符。")
    }
    if (body.sessionGroupId !== undefined) {
      if (typeof body.sessionGroupId !== "string" || !roomAlive(body.sessionGroupId)) {
        return bad(reply, "所选房间不存在或已归档。")
      }
    }
    adminStore.upsertGroup(body.chatId, {
      displayName: body.displayName === undefined ? undefined : (body.displayName as string).trim(),
      sessionGroupId: body.sessionGroupId as string | undefined,
    })
    return { ok: true }
  })

  app.patch(
    "/api/channel-admin/groups/:chatId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { chatId } = request.params as { chatId: string }
      const existing = adminStore.listGroups().find((g) => g.chatId === chatId)
      if (!existing) {
        reply.code(404)
        return { error: "群不存在。" }
      }
      const body = (request.body ?? {}) as Record<string, unknown>
      if (body.displayName !== undefined && !isValidDisplayName(body.displayName)) {
        return bad(reply, "displayName 必须是 1-64 字且不含控制字符。")
      }
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
        return bad(reply, "enabled 必须是布尔值。")
      }
      if (body.sessionGroupId !== undefined) {
        if (typeof body.sessionGroupId !== "string" || !roomAlive(body.sessionGroupId)) {
          return bad(reply, "所选房间不存在或已归档。")
        }
      }
      // P2.6 AC-N5：默认应答人（与 /agent 同一原语 setDefaultResponder）
      if (body.defaultProvider !== undefined && !isValidProvider(body.defaultProvider)) {
        return bad(reply, `defaultProvider 只能是 ${PROVIDERS.join(" / ")}。`)
      }
      // 德彪 P2.6-r1 #1：seed 解析/校验必须在**任何写入之前**——否则
      // {enabled:false, defaultProvider} 打到未绑房群会先把群禁了再 400，
      // 失败请求改变授权面（非原子）。seed 顺位：本次同请求新绑的房 →
      // 既有 binding → admin 行种子（都无 = 先绑房，零写入拒绝）。
      let responderSeed: string | null = null
      if (body.defaultProvider !== undefined) {
        responderSeed =
          (body.sessionGroupId as string | undefined) ??
          adminStore.getBinding(chatId)?.sessionGroupId ??
          existing.sessionGroupId
        if (!responderSeed) {
          return bad(reply, "这个群还没选房间：先选好房间，再设默认应答人。")
        }
      }
      // ---- 写入区（全部校验已过）----
      if (body.displayName !== undefined || body.enabled !== undefined) {
        adminStore.upsertGroup(chatId, {
          displayName:
            body.displayName === undefined ? undefined : (body.displayName as string).trim(),
          enabled: body.enabled as boolean | undefined,
        })
      }
      // AC-N6（D20 收敛）：换绑统一走 rebindChat——管理页与 /switch //newroom 同一原语，
      // binding 缺失当场建出（不再等首条消息 lazy-bind），seed 同事务同步
      if (body.sessionGroupId !== undefined) {
        adminStore.rebindChat(chatId, "group", body.sessionGroupId as string, {
          defaultProvider: adminStore.getBinding(chatId)?.defaultProvider ?? channelDefaultProvider,
        })
      }
      if (body.defaultProvider !== undefined && responderSeed) {
        adminStore.setDefaultResponder(chatId, "group", body.defaultProvider as string, {
          seedSessionGroupId: responderSeed,
        })
      }
      return { ok: true }
    },
  )

  app.delete(
    "/api/channel-admin/groups/:chatId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { chatId } = request.params as { chatId: string }
      const existing = adminStore.listGroups().find((g) => g.chatId === chatId)
      if (!existing) {
        reply.code(404)
        return { error: "群不存在。" }
      }
      adminStore.removeGroup(chatId)
      return { ok: true }
    },
  )

  // ---- 审计（待放行）----

  app.get("/api/channel-admin/audits", async (request: FastifyRequest, reply: FastifyReply) => {
    const { status } = request.query as { status?: string }
    if (status !== undefined && !["pending", "allowed", "dismissed"].includes(status)) {
      return bad(reply, "status 只能是 pending / allowed / dismissed。")
    }
    return { audits: adminStore.listAudit(status as AuditStatus | undefined) }
  })

  app.post(
    "/api/channel-admin/audits/:id/allow",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string }
      const audit = adminStore.listAudit().find((a) => a.id === id)
      if (!audit) {
        reply.code(404)
        return { error: "审计记录不存在。" }
      }
      // 德彪 P2.5-r1 #2：只放行 pending 的成员类申请。已处理记录不可反复改写；
      // 群未放行/未绑房走各自动作（加群白名单/选房间），否则「列表清了、门还拒」
      // 审计状态与授权真相源分叉。
      if (audit.status !== "pending") {
        reply.code(409)
        return { error: "该记录已处理过，只有待处理状态能放行。" }
      }
      if (audit.reason !== "allowlist" && audit.reason !== "member-not-allowed") {
        return bad(reply, "该类型不走成员放行：群未放行请加群白名单，还没选房间的请为群选一个房间。")
      }
      const body = (request.body ?? {}) as Record<string, unknown>
      if (!isValidDisplayName(body.displayName)) {
        return bad(reply, "displayName 必须是 1-64 字且不含控制字符（放行要给人起名，归因署名用）。")
      }
      // role 缺省由后端按 reason 定：p2p（allowlist）过门要 owner（D14），
      // 群成员默认 participant。显式给则校验后用。
      const role =
        body.role === undefined
          ? audit.reason === "allowlist"
            ? "owner"
            : "participant"
          : body.role
      if (!isValidRole(role)) {
        return bad(reply, "role 只能是 owner 或 participant。")
      }
      // 德彪 P2.5-r1 #1（P1）：allowFromAudit 底层是 upsert 会覆写既有成员——
      // stale audit（被拒后又被提成 owner）场景下放行=降级末位 owner=p2p 自锁。
      // 与 PATCH 降级守卫同款；AC-N3 后基数只数可用 owner（禁用 owner 不撑数）。
      const existing = adminStore.listMembers().find((m) => m.openId === audit.openId)
      if (
        existing?.role === "owner" &&
        existing.enabled &&
        role !== "owner" &&
        adminStore.countEnabledOwners() <= 1
      ) {
        return bad(reply, "最后一个可用 owner 不能被放行操作覆写降级（会把自己锁在门外）。")
      }
      adminStore.allowFromAudit(id, { displayName: (body.displayName as string).trim(), role })
      return { ok: true }
    },
  )

  app.post(
    "/api/channel-admin/audits/:id/dismiss",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string }
      const audit = adminStore.listAudit().find((a) => a.id === id)
      if (!audit) {
        reply.code(404)
        return { error: "审计记录不存在。" }
      }
      adminStore.dismissAudit(id)
      return { ok: true }
    },
  )

  // ---- 绑定下拉数据源（活房间）----

  app.get("/api/channel-admin/rooms", async () => {
    const rows = db.db
      .prepare(
        "SELECT id, room_id, title FROM session_groups WHERE archived_at IS NULL AND deleted_at IS NULL ORDER BY created_at ASC",
      )
      .all() as Array<{ id: string; room_id: string | null; title: string }>
    return {
      rooms: rows.map((r) => ({ sessionGroupId: r.id, roomId: r.room_id, title: r.title })),
    }
  })
}
