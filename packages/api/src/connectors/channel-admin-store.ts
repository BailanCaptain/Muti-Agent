import type { SqliteStore } from "../db/sqlite"
import type { GroupMember } from "./channel-config"

/**
 * F040 Phase 2.5（D17 AC-M1/M2/M3）：渠道授权配置 DB 真相源 + 入站拒绝审计。
 *
 * 热生效合同（AC-M2）：getAuthView() 返回缓存快照，任何写方法先写库后失效缓存。
 * 🔴 单例约束：路由与网关必须共享**同一实例**（server.ts 无条件构建一次）——
 * connector 用独立 SQLite 连接（server.ts 双连接既有事实），若各建实例，
 * 路由写走 A、网关读走 B 的缓存，B 永不失效，热生效破功。
 *
 * seed 合同（AC-M1）：域独立判空——members 表空才导成员域（ALLOWED_OPEN_IDS ∪
 * GROUP_MEMBERS），groups 表空才导群域（ALLOWED_GROUP_CHATS + GROUP_BINDINGS 种子）；
 * 表非空 DB wins，env 改动不再生效（bootstrap-only）。
 */

export type AdminAuthView = {
  allowedOpenIds: string[]
  groupMembers: Record<string, GroupMember>
  allowedGroupChats: string[]
  groupBindings: Record<string, string>
}

export type AdminMemberRow = {
  openId: string
  displayName: string
  role: "owner" | "participant"
  /** P2.6 AC-N3：false = 禁用（按非白名单拒，行保留可一键恢复） */
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export type AdminGroupRow = {
  chatId: string
  displayName: string
  sessionGroupId: string | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export type AuditStatus = "pending" | "allowed" | "dismissed"

export type AuditRow = {
  id: string
  chatId: string
  chatKind: "p2p" | "group"
  openId: string
  reason: string
  count: number
  firstAt: string
  lastAt: string
  status: AuditStatus
}

export type RejectRecord = {
  chatId: string
  chatKind: "p2p" | "group"
  openId: string
  reason: string
}

export type SeedConfig = {
  allowedOpenIds: string[]
  groupMembers: Record<string, GroupMember>
  allowedGroupChats: string[]
  groupBindings: Record<string, string>
}

export class ChannelAdminStore {
  private view: AdminAuthView | null = null

  constructor(
    private readonly deps: {
      db: SqliteStore
      channel: string
      genId: () => string
      now: () => string
    },
  ) {}

  private get db() {
    return this.deps.db.db
  }

  /** 渠道标识（= channel_bindings.connector_id 同一命名空间），路由层 join 用 */
  get channel(): string {
    return this.deps.channel
  }

  private invalidate(): void {
    this.view = null
  }

  // ---- 读（AC-M2 热生效核：写失效 → 下次读重组）----

  getAuthView(): AdminAuthView {
    if (this.view) return this.view
    // AC-N3：禁用成员不进任何授权面（p2p 白名单/归因映射都摘），门语义 = 非白名单拒
    const members = this.listMembers().filter((m) => m.enabled)
    const groups = this.listGroups()
    const groupMembers: Record<string, GroupMember> = {}
    for (const m of members) groupMembers[m.openId] = { name: m.displayName, role: m.role }
    const enabledGroups = groups.filter((g) => g.enabled)
    const groupBindings: Record<string, string> = {}
    for (const g of enabledGroups) {
      if (g.sessionGroupId) groupBindings[g.chatId] = g.sessionGroupId
    }
    this.view = {
      allowedOpenIds: members.filter((m) => m.role === "owner").map((m) => m.openId),
      groupMembers,
      allowedGroupChats: enabledGroups.map((g) => g.chatId),
      groupBindings,
    }
    return this.view
  }

  listMembers(): AdminMemberRow[] {
    const rows = this.db
      .prepare(
        `SELECT open_id, display_name, role, enabled, created_at, updated_at
         FROM channel_admin_members WHERE channel = ?
         ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at ASC, open_id ASC`,
      )
      .all(this.deps.channel) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      openId: String(r.open_id),
      displayName: String(r.display_name),
      role: r.role === "owner" ? "owner" : "participant",
      enabled: r.enabled === 1,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }))
  }

  listGroups(): AdminGroupRow[] {
    const rows = this.db
      .prepare(
        `SELECT chat_id, display_name, session_group_id, enabled, created_at, updated_at
         FROM channel_admin_groups WHERE channel = ? ORDER BY created_at ASC, chat_id ASC`,
      )
      .all(this.deps.channel) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      chatId: String(r.chat_id),
      displayName: String(r.display_name),
      sessionGroupId: typeof r.session_group_id === "string" ? r.session_group_id : null,
      enabled: r.enabled === 1,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }))
  }

  /**
   * P2.6 AC-N3：守卫基数 = **可用** owner 数。旧 countOwners（不分 enabled）有自锁洞：
   * 两 owner 一禁一活时删/降级/禁用活的那个，守卫按 2 放行 → 剩一个禁用 owner = p2p 全锁。
   */
  countEnabledOwners(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM channel_admin_members WHERE channel = ? AND role = 'owner' AND enabled = 1`,
      )
      .get(this.deps.channel) as { c: number }
    return row.c
  }

  // ---- 种子（AC-M1）----

  seedFromEnv(cfg: SeedConfig): { seededMembers: number; seededGroups: number } {
    const t = this.deps.now()
    let seededMembers = 0
    let seededGroups = 0

    const memberCount = this.db
      .prepare("SELECT COUNT(*) AS c FROM channel_admin_members WHERE channel = ?")
      .get(this.deps.channel) as { c: number }
    if (memberCount.c === 0) {
      const insert = this.db.prepare(
        `INSERT INTO channel_admin_members (channel, open_id, display_name, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      // owner 域：ALLOWED_OPEN_IDS（名字优先取 GROUP_MEMBERS 配置，缺省「村长」——gateway 同默认）
      for (const openId of cfg.allowedOpenIds) {
        insert.run(
          this.deps.channel,
          openId,
          cfg.groupMembers[openId]?.name ?? "村长",
          "owner",
          t,
          t,
        )
        seededMembers++
      }
      for (const [openId, m] of Object.entries(cfg.groupMembers)) {
        if (cfg.allowedOpenIds.includes(openId)) continue // owner 已导
        insert.run(this.deps.channel, openId, m.name, "participant", t, t)
        seededMembers++
      }
    }

    const groupCount = this.db
      .prepare("SELECT COUNT(*) AS c FROM channel_admin_groups WHERE channel = ?")
      .get(this.deps.channel) as { c: number }
    if (groupCount.c === 0) {
      const insert = this.db.prepare(
        `INSERT INTO channel_admin_groups (channel, chat_id, display_name, session_group_id, enabled, created_at, updated_at)
         VALUES (?, ?, '', ?, 1, ?, ?)`,
      )
      for (const chatId of cfg.allowedGroupChats) {
        insert.run(this.deps.channel, chatId, cfg.groupBindings[chatId] ?? null, t, t)
        seededGroups++
      }
    }

    if (seededMembers > 0 || seededGroups > 0) this.invalidate()
    return { seededMembers, seededGroups }
  }

  // ---- 成员写 ----

  upsertMember(openId: string, displayName: string, role: "owner" | "participant"): void {
    const t = this.deps.now()
    // AC-N3：ON CONFLICT 不碰 enabled——改名/改角色不悄悄复活禁用成员（复活只走
    // setMemberEnabled / allowFromAudit 两个显式入口）；新插入默认可用。
    this.db
      .prepare(
        `INSERT INTO channel_admin_members (channel, open_id, display_name, role, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(channel, open_id) DO UPDATE SET
           display_name = excluded.display_name, role = excluded.role, updated_at = excluded.updated_at`,
      )
      .run(this.deps.channel, openId, displayName, role, t, t)
    this.invalidate()
  }

  /** P2.6 AC-N3：禁用/恢复开关（末位可用 owner 守卫在路由层，与删除/降级同款） */
  setMemberEnabled(openId: string, enabled: boolean): void {
    this.db
      .prepare(
        "UPDATE channel_admin_members SET enabled = ?, updated_at = ? WHERE channel = ? AND open_id = ?",
      )
      .run(enabled ? 1 : 0, this.deps.now(), this.deps.channel, openId)
    this.invalidate()
  }

  removeMember(openId: string): void {
    this.db
      .prepare("DELETE FROM channel_admin_members WHERE channel = ? AND open_id = ?")
      .run(this.deps.channel, openId)
    this.invalidate()
  }

  // ---- 群写 ----

  upsertGroup(
    chatId: string,
    patch: { displayName?: string; sessionGroupId?: string | null; enabled?: boolean },
  ): void {
    const t = this.deps.now()
    // M-T7 换绑热更：seed 变更 + 既有运行时 binding 行同事务改写（半截换绑 =
    // 管理页显示新房、消息进旧房）。sessionGroupId=null 只清 seed，不动 binding。
    this.db.exec("BEGIN")
    try {
      const existing = this.db
        .prepare("SELECT chat_id FROM channel_admin_groups WHERE channel = ? AND chat_id = ?")
        .get(this.deps.channel, chatId)
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO channel_admin_groups (channel, chat_id, display_name, session_group_id, enabled, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            this.deps.channel,
            chatId,
            patch.displayName ?? "",
            patch.sessionGroupId ?? null,
            patch.enabled === false ? 0 : 1,
            t,
            t,
          )
      } else {
        // patch 语义：只改给的字段（COALESCE 不适用——enabled=false/sessionGroupId=null 是合法目标值）
        if (patch.displayName !== undefined) {
          this.db
            .prepare(
              "UPDATE channel_admin_groups SET display_name = ?, updated_at = ? WHERE channel = ? AND chat_id = ?",
            )
            .run(patch.displayName, t, this.deps.channel, chatId)
        }
        if (patch.sessionGroupId !== undefined) {
          this.db
            .prepare(
              "UPDATE channel_admin_groups SET session_group_id = ?, updated_at = ? WHERE channel = ? AND chat_id = ?",
            )
            .run(patch.sessionGroupId, t, this.deps.channel, chatId)
        }
        if (patch.enabled !== undefined) {
          this.db
            .prepare(
              "UPDATE channel_admin_groups SET enabled = ?, updated_at = ? WHERE channel = ? AND chat_id = ?",
            )
            .run(patch.enabled ? 1 : 0, t, this.deps.channel, chatId)
        }
      }
      if (typeof patch.sessionGroupId === "string" && patch.sessionGroupId.length > 0) {
        this.db
          .prepare(
            "UPDATE channel_bindings SET session_group_id = ? WHERE connector_id = ? AND external_chat_id = ?",
          )
          .run(patch.sessionGroupId, this.deps.channel, chatId)
      }
      this.db.exec("COMMIT")
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
    this.invalidate()
  }

  removeGroup(chatId: string): void {
    this.db
      .prepare("DELETE FROM channel_admin_groups WHERE channel = ? AND chat_id = ?")
      .run(this.deps.channel, chatId)
    this.invalidate()
  }

  // ---- 绑定原语（P2.6 AC-N5/N2：管理页下拉、/agent、/switch、/newroom 共用一套）----

  /** binding 现值（channel_bindings 是运行时真相源，D3/D20）；无行 → null */
  getBinding(chatId: string): { sessionGroupId: string; defaultProvider: string } | null {
    const row = this.db
      .prepare(
        "SELECT session_group_id, default_provider FROM channel_bindings WHERE connector_id = ? AND external_chat_id = ?",
      )
      .get(this.deps.channel, chatId) as
      | { session_group_id: string; default_provider: string }
      | undefined
    return row
      ? { sessionGroupId: row.session_group_id, defaultProvider: row.default_provider }
      : null
  }

  /**
   * 换绑（比 upsertGroup 强一级）：binding 行缺失时**当场建出**（不等首条消息 lazy-bind），
   * 存在则只改 session_group_id（不动 default_provider）。群同事务同步 admin seed 行，
   * 管理页视图与运行时真相源不分叉；p2p 无 admin 行概念不碰群表。
   */
  rebindChat(
    chatId: string,
    chatKind: "p2p" | "group",
    sessionGroupId: string,
    opts: { defaultProvider: string },
  ): void {
    const t = this.deps.now()
    this.db.exec("BEGIN")
    try {
      if (chatKind === "group") {
        const existing = this.db
          .prepare("SELECT chat_id FROM channel_admin_groups WHERE channel = ? AND chat_id = ?")
          .get(this.deps.channel, chatId)
        if (existing) {
          this.db
            .prepare(
              "UPDATE channel_admin_groups SET session_group_id = ?, updated_at = ? WHERE channel = ? AND chat_id = ?",
            )
            .run(sessionGroupId, t, this.deps.channel, chatId)
        } else {
          this.db
            .prepare(
              `INSERT INTO channel_admin_groups (channel, chat_id, display_name, session_group_id, enabled, created_at, updated_at)
               VALUES (?, ?, '', ?, 1, ?, ?)`,
            )
            .run(this.deps.channel, chatId, sessionGroupId, t, t)
        }
      }
      const binding = this.db
        .prepare(
          "SELECT id FROM channel_bindings WHERE connector_id = ? AND external_chat_id = ?",
        )
        .get(this.deps.channel, chatId)
      if (binding) {
        this.db
          .prepare(
            "UPDATE channel_bindings SET session_group_id = ? WHERE connector_id = ? AND external_chat_id = ?",
          )
          .run(sessionGroupId, this.deps.channel, chatId)
      } else {
        this.db
          .prepare(
            `INSERT INTO channel_bindings (id, connector_id, external_chat_id, chat_kind, session_group_id, default_provider, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            this.deps.genId(),
            this.deps.channel,
            chatId,
            chatKind,
            sessionGroupId,
            opts.defaultProvider,
            t,
          )
      }
      this.db.exec("COMMIT")
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
    this.invalidate()
  }

  /**
   * 默认应答人（AC-N5 群行下拉 = AC-N2 /agent，同一原语）：binding 存在改 default_provider；
   * 缺失且有 seed → 连房间一步建出；无 seed → 显式失败（先绑房，fail-closed 不猜）。
   * binding 不进 getAuthView 快照（gateway 逐条消息现读 channel_bindings）——无需失效缓存。
   */
  setDefaultResponder(
    chatId: string,
    chatKind: "p2p" | "group",
    provider: string,
    opts: { seedSessionGroupId: string | null },
  ): void {
    const binding = this.db
      .prepare("SELECT id FROM channel_bindings WHERE connector_id = ? AND external_chat_id = ?")
      .get(this.deps.channel, chatId)
    if (binding) {
      this.db
        .prepare(
          "UPDATE channel_bindings SET default_provider = ? WHERE connector_id = ? AND external_chat_id = ?",
        )
        .run(provider, this.deps.channel, chatId)
      return
    }
    if (!opts.seedSessionGroupId) {
      throw new Error("聊天还没绑定房间：先绑定房间再设默认应答人。")
    }
    this.db
      .prepare(
        `INSERT INTO channel_bindings (id, connector_id, external_chat_id, chat_kind, session_group_id, default_provider, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.deps.genId(),
        this.deps.channel,
        chatId,
        chatKind,
        opts.seedSessionGroupId,
        provider,
        this.deps.now(),
      )
  }

  // ---- 审计（AC-M3）----

  recordReject(r: RejectRecord): void {
    const t = this.deps.now()
    // 聚合 upsert：count+1 / last_at 刷新；status 不动（dismissed 保持 dismissed，不回退 pending）
    this.db
      .prepare(
        `INSERT INTO channel_inbound_audit (id, channel, chat_id, chat_kind, open_id, reason, count, first_at, last_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'pending')
         ON CONFLICT(channel, chat_kind, chat_id, open_id, reason) DO UPDATE SET
           count = count + 1, last_at = excluded.last_at`,
      )
      .run(this.deps.genId(), this.deps.channel, r.chatId, r.chatKind, r.openId, r.reason, t, t)
  }

  listAudit(status?: AuditStatus): AuditRow[] {
    const rows = (
      status
        ? this.db
            .prepare(
              `SELECT id, chat_id, chat_kind, open_id, reason, count, first_at, last_at, status
               FROM channel_inbound_audit WHERE channel = ? AND status = ? ORDER BY last_at DESC, id ASC`,
            )
            .all(this.deps.channel, status)
        : this.db
            .prepare(
              `SELECT id, chat_id, chat_kind, open_id, reason, count, first_at, last_at, status
               FROM channel_inbound_audit WHERE channel = ? ORDER BY last_at DESC, id ASC`,
            )
            .all(this.deps.channel)
    ) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: String(r.id),
      chatId: String(r.chat_id),
      chatKind: r.chat_kind === "p2p" ? "p2p" : "group",
      openId: String(r.open_id),
      reason: String(r.reason),
      count: Number(r.count),
      firstAt: String(r.first_at),
      lastAt: String(r.last_at),
      status:
        r.status === "allowed" ? "allowed" : r.status === "dismissed" ? "dismissed" : "pending",
    }))
  }

  allowFromAudit(
    auditId: string,
    opts: { displayName: string; role: "owner" | "participant" },
  ): void {
    const audit = this.db
      .prepare("SELECT open_id FROM channel_inbound_audit WHERE channel = ? AND id = ?")
      .get(this.deps.channel, auditId) as { open_id: string } | undefined
    if (!audit) {
      throw new Error(`audit record not found: ${auditId}`)
    }
    // 事务：member 落 + status=allowed 同生共死（半截放行 = 页面显示已放行但门还在拒）
    this.db.exec("BEGIN")
    try {
      const t = this.deps.now()
      // AC-N3：放行 = 可用（禁用成员经待放行复活是二次放行的正路，enabled 显式置 1）
      this.db
        .prepare(
          `INSERT INTO channel_admin_members (channel, open_id, display_name, role, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(channel, open_id) DO UPDATE SET
             display_name = excluded.display_name, role = excluded.role, enabled = 1, updated_at = excluded.updated_at`,
        )
        .run(this.deps.channel, audit.open_id, opts.displayName, opts.role, t, t)
      this.db
        .prepare(`UPDATE channel_inbound_audit SET status = 'allowed' WHERE channel = ? AND id = ?`)
        .run(this.deps.channel, auditId)
      this.db.exec("COMMIT")
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
    this.invalidate()
  }

  dismissAudit(auditId: string): void {
    this.db
      .prepare(`UPDATE channel_inbound_audit SET status = 'dismissed' WHERE channel = ? AND id = ?`)
      .run(this.deps.channel, auditId)
  }
}
