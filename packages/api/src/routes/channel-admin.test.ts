import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import Fastify from "fastify"
import { ChannelAdminStore } from "../connectors/channel-admin-store"
import { SqliteStore } from "../db/sqlite"
import { registerChannelAdminRoutes } from "./channel-admin"

/**
 * F040 Phase 2.5 M-T6（AC-M3）：渠道管理 REST。手写校验显式 400（F021 AC-29 风格，
 * 禁静默 sanitize）；末位 owner 不可删（表非空 seed 不再跑，删光 owner = p2p 永锁）；
 * 绑定房间必须存在且未归档；放行/忽略走 store 事务原语。
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-admin-routes-"))
let dbSeq = 0
const openStores: SqliteStore[] = []

after(() => {
  for (const s of openStores) {
    try {
      s.db.close()
    } catch {}
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {}
})

async function build() {
  dbSeq += 1
  const store = new SqliteStore(path.join(tmpRoot, `db-${dbSeq}.sqlite`))
  openStores.push(store)
  let tick = 0
  const adminStore = new ChannelAdminStore({
    db: store,
    channel: "feishu",
    genId: () => `aid-${++tick}`,
    now: () => `2026-07-04T00:00:${String(tick).padStart(2, "0")}.000Z`,
  })
  // 备两个房间（一个归档）供绑定校验
  store.db
    .prepare(
      "INSERT INTO session_groups (id, room_id, title, created_at, updated_at) VALUES ('sg-live','R-100','移动群房','t','t')",
    )
    .run()
  store.db
    .prepare(
      "INSERT INTO session_groups (id, room_id, title, archived_at, created_at, updated_at) VALUES ('sg-dead','R-101','已归档房','t','t','t')",
    )
    .run()
  const app = Fastify()
  registerChannelAdminRoutes(app, { adminStore, db: store })
  return { app, store, adminStore }
}

describe("M-T6 成员 CRUD", () => {
  it("POST 合法成员 → 200；overview 反映；participant 不进 owner 集", async () => {
    const { app } = await build()
    const res = await app.inject({
      method: "POST",
      url: "/api/channel-admin/members",
      payload: { openId: "ou_li", displayName: "小李", role: "participant" },
    })
    assert.equal(res.statusCode, 200)
    const ov = (
      await app.inject({ method: "GET", url: "/api/channel-admin/overview" })
    ).json() as {
      members: Array<{ openId: string; displayName: string; role: string }>
    }
    assert.equal(ov.members.length, 1)
    assert.equal(ov.members[0].openId, "ou_li")
    assert.equal(ov.members[0].displayName, "小李")
    assert.equal(ov.members[0].role, "participant")
    await app.close()
  })

  it("POST 非法载荷 → 400 显式拒（缺 openId / 空名 / 控制字符 / 未知 role / open_id 带空格）", async () => {
    const { app } = await build()
    const bads = [
      { displayName: "x", role: "participant" },
      { openId: "ou_x", displayName: "  ", role: "participant" },
      { openId: "ou_x", displayName: `a${String.fromCharCode(7)}b`, role: "participant" },
      { openId: "ou_x", displayName: "x", role: "admin" },
      { openId: "ou x", displayName: "x", role: "participant" },
    ]
    for (const payload of bads) {
      const res = await app.inject({ method: "POST", url: "/api/channel-admin/members", payload })
      assert.equal(res.statusCode, 400, JSON.stringify(payload))
    }
    await app.close()
  })

  it("PATCH 改名/升角色 → 200；未知 openId → 404", async () => {
    const { app } = await build()
    await app.inject({
      method: "POST",
      url: "/api/channel-admin/members",
      payload: { openId: "ou_li", displayName: "小李", role: "participant" },
    })
    const res = await app.inject({
      method: "PATCH",
      url: "/api/channel-admin/members/ou_li",
      payload: { displayName: "李哥", role: "owner" },
    })
    assert.equal(res.statusCode, 200)
    const missing = await app.inject({
      method: "PATCH",
      url: "/api/channel-admin/members/ou_ghost",
      payload: { displayName: "x" },
    })
    assert.equal(missing.statusCode, 404)
    await app.close()
  })

  it("DELETE 末位 owner → 400 防自锁；participant / 非末位 owner 可删", async () => {
    const { app, adminStore } = await build()
    adminStore.upsertMember("ou_sun", "村长", "owner")
    adminStore.upsertMember("ou_li", "小李", "participant")
    const guard = await app.inject({ method: "DELETE", url: "/api/channel-admin/members/ou_sun" })
    assert.equal(guard.statusCode, 400, "末位 owner 不可删")
    const okP = await app.inject({ method: "DELETE", url: "/api/channel-admin/members/ou_li" })
    assert.equal(okP.statusCode, 200)
    adminStore.upsertMember("ou_second", "二当家", "owner")
    const okO = await app.inject({ method: "DELETE", url: "/api/channel-admin/members/ou_sun" })
    assert.equal(okO.statusCode, 200, "还有别的 owner → 可删")
    await app.close()
  })
})

describe("M-T6 群 CRUD + 绑定校验", () => {
  it("POST 群（绑定活房间）→ 200；绑定不存在/已归档房间 → 400", async () => {
    const { app } = await build()
    const ok = await app.inject({
      method: "POST",
      url: "/api/channel-admin/groups",
      payload: { chatId: "oc_g1", displayName: "测试群", sessionGroupId: "sg-live" },
    })
    assert.equal(ok.statusCode, 200)
    const ghost = await app.inject({
      method: "POST",
      url: "/api/channel-admin/groups",
      payload: { chatId: "oc_g2", sessionGroupId: "sg-ghost" },
    })
    assert.equal(ghost.statusCode, 400)
    const dead = await app.inject({
      method: "POST",
      url: "/api/channel-admin/groups",
      payload: { chatId: "oc_g3", sessionGroupId: "sg-dead" },
    })
    assert.equal(dead.statusCode, 400, "归档房间不可绑")
    await app.close()
  })

  it("PATCH enabled 开关 + overview 带绑定房间名；DELETE 移除", async () => {
    const { app } = await build()
    await app.inject({
      method: "POST",
      url: "/api/channel-admin/groups",
      payload: { chatId: "oc_g1", displayName: "测试群", sessionGroupId: "sg-live" },
    })
    const toggle = await app.inject({
      method: "PATCH",
      url: "/api/channel-admin/groups/oc_g1",
      payload: { enabled: false },
    })
    assert.equal(toggle.statusCode, 200)
    const ov = (
      await app.inject({ method: "GET", url: "/api/channel-admin/overview" })
    ).json() as {
      groups: Array<{ chatId: string; enabled: boolean; roomTitle: string | null }>
    }
    assert.equal(ov.groups[0]?.enabled, false)
    assert.equal(ov.groups[0]?.roomTitle, "移动群房")
    const del = await app.inject({ method: "DELETE", url: "/api/channel-admin/groups/oc_g1" })
    assert.equal(del.statusCode, 200)
    const ov2 = (
      await app.inject({ method: "GET", url: "/api/channel-admin/overview" })
    ).json() as { groups: unknown[] }
    assert.equal(ov2.groups.length, 0)
    await app.close()
  })

  it("M-T7 换绑热更：已有 binding 行 → PATCH sessionGroupId 同步更新 channel_bindings", async () => {
    const { app, store } = await build()
    await app.inject({
      method: "POST",
      url: "/api/channel-admin/groups",
      payload: { chatId: "oc_g1", sessionGroupId: "sg-live" },
    })
    // 模拟 gateway 已 lazy-bind 的运行时行
    store.db
      .prepare(
        "INSERT INTO channel_bindings (id, connector_id, external_chat_id, chat_kind, session_group_id, default_provider, created_at) VALUES ('b-1','feishu','oc_g1','group','sg-live','claude','t')",
      )
      .run()
    // 新目标房间
    store.db
      .prepare(
        "INSERT INTO session_groups (id, room_id, title, created_at, updated_at) VALUES ('sg-next','R-102','新房','t','t')",
      )
      .run()
    const res = await app.inject({
      method: "PATCH",
      url: "/api/channel-admin/groups/oc_g1",
      payload: { sessionGroupId: "sg-next" },
    })
    assert.equal(res.statusCode, 200)
    const b = store.db
      .prepare("SELECT session_group_id FROM channel_bindings WHERE external_chat_id='oc_g1'")
      .get() as { session_group_id: string }
    assert.equal(b.session_group_id, "sg-next", "运行时 binding 行同步换绑（下一条群消息进新房）")
    await app.close()
  })
})

describe("M-T6 审计放行", () => {
  it("GET pending → allow（member 落+status 变）→ dismiss；未知 id 404；缺名 400", async () => {
    const { app, adminStore } = await build()
    adminStore.recordReject({
      chatId: "oc_g1",
      chatKind: "group",
      openId: "ou_new",
      reason: "member-not-allowed",
    })
    adminStore.recordReject({
      chatId: "oc_g1",
      chatKind: "group",
      openId: "ou_other",
      reason: "member-not-allowed",
    })
    const list = (
      await app.inject({ method: "GET", url: "/api/channel-admin/audits?status=pending" })
    ).json() as { audits: Array<{ id: string; openId: string }> }
    assert.equal(list.audits.length, 2)

    const target = list.audits.find((a) => a.openId === "ou_new")
    assert.ok(target)
    const noName = await app.inject({
      method: "POST",
      url: `/api/channel-admin/audits/${target.id}/allow`,
      payload: {},
    })
    assert.equal(noName.statusCode, 400)
    const allow = await app.inject({
      method: "POST",
      url: `/api/channel-admin/audits/${target.id}/allow`,
      payload: { displayName: "新人" },
    })
    assert.equal(allow.statusCode, 200)
    assert.equal(adminStore.getAuthView().groupMembers.ou_new?.name, "新人")

    const other = list.audits.find((a) => a.openId === "ou_other")
    assert.ok(other)
    const dis = await app.inject({
      method: "POST",
      url: `/api/channel-admin/audits/${other.id}/dismiss`,
    })
    assert.equal(dis.statusCode, 200)
    const left = (
      await app.inject({ method: "GET", url: "/api/channel-admin/audits?status=pending" })
    ).json() as { audits: unknown[] }
    assert.equal(left.audits.length, 0)

    const ghost = await app.inject({
      method: "POST",
      url: "/api/channel-admin/audits/no-such/allow",
      payload: { displayName: "x" },
    })
    assert.equal(ghost.statusCode, 404)
    await app.close()
  })

  it("德彪 P2.5-r1 P1：stale audit 放行不可覆写降级末位 owner（防自锁）", async () => {
    const { app, adminStore } = await build()
    // 时序：先被拒（audit 落 pending）→ 后被手工提成唯一 owner → 再点旧申请的放行
    adminStore.recordReject({
      chatId: "oc_g1",
      chatKind: "group",
      openId: "ou_sun",
      reason: "member-not-allowed",
    })
    adminStore.upsertMember("ou_sun", "村长", "owner")
    const audit = adminStore.listAudit("pending")[0]
    assert.ok(audit)
    // 显式 participant → 400
    const explicit = await app.inject({
      method: "POST",
      url: `/api/channel-admin/audits/${audit.id}/allow`,
      payload: { displayName: "村长", role: "participant" },
    })
    assert.equal(explicit.statusCode, 400, "显式降级末位 owner 必须拒")
    // 缺省 role（member-not-allowed → participant）同样会降级 → 400
    const defaulted = await app.inject({
      method: "POST",
      url: `/api/channel-admin/audits/${audit.id}/allow`,
      payload: { displayName: "村长" },
    })
    assert.equal(defaulted.statusCode, 400, "缺省角色路径同样不可降级末位 owner")
    // owner 原样，门没被自锁
    assert.equal(adminStore.getAuthView().allowedOpenIds.includes("ou_sun"), true)
    assert.equal(adminStore.countEnabledOwners(), 1)
    await app.close()
  })

  it("德彪 P2.5-r1 P2：allow 只收 pending 的成员类申请", async () => {
    const { app, adminStore } = await build()
    // ① 已 dismiss 的记录 → 409（不可反复改写）
    adminStore.recordReject({
      chatId: "oc_g1",
      chatKind: "group",
      openId: "ou_a",
      reason: "member-not-allowed",
    })
    const a = adminStore.listAudit("pending")[0]
    adminStore.dismissAudit(a.id)
    const onDismissed = await app.inject({
      method: "POST",
      url: `/api/channel-admin/audits/${a.id}/allow`,
      payload: { displayName: "甲" },
    })
    assert.equal(onDismissed.statusCode, 409)
    // ② group-not-allowed 类 → 400（放行不会加群白名单，走 addGroup 才是真放行）
    adminStore.recordReject({
      chatId: "oc_gx",
      chatKind: "group",
      openId: "ou_b",
      reason: "group-not-allowed",
    })
    const g = adminStore.listAudit("pending").find((x) => x.reason === "group-not-allowed")
    assert.ok(g)
    const onGroup = await app.inject({
      method: "POST",
      url: `/api/channel-admin/audits/${g.id}/allow`,
      payload: { displayName: "乙" },
    })
    assert.equal(onGroup.statusCode, 400)
    // 两条都没产生成员、审计状态没被洗
    assert.equal(adminStore.listMembers().length, 0)
    assert.equal(adminStore.listAudit("allowed").length, 0)
    await app.close()
  })

  it("德彪 P2.5-r1：role 缺省由后端按 reason 定——allowlist（p2p）放行默认 owner", async () => {
    const { app, adminStore } = await build()
    adminStore.upsertMember("ou_boss", "老板", "owner") // 已有 owner，避免路过守卫
    adminStore.recordReject({
      chatId: "oc_p2p_x",
      chatKind: "p2p",
      openId: "ou_second",
      reason: "allowlist",
    })
    const audit = adminStore.listAudit("pending")[0]
    const res = await app.inject({
      method: "POST",
      url: `/api/channel-admin/audits/${audit.id}/allow`,
      payload: { displayName: "二号" },
    })
    assert.equal(res.statusCode, 200)
    // p2p 过门要 owner（D14）——缺省必须落 owner 否则放了也进不来
    assert.equal(adminStore.getAuthView().groupMembers.ou_second?.role, "owner")
    assert.ok(adminStore.getAuthView().allowedOpenIds.includes("ou_second"))
    await app.close()
  })
})

describe("M-T6 rooms 下拉数据源", () => {
  it("GET rooms → 只出活房间（归档/删除排除）", async () => {
    const { app } = await build()
    const res = (await app.inject({ method: "GET", url: "/api/channel-admin/rooms" })).json() as {
      rooms: Array<{ sessionGroupId: string; roomId: string | null; title: string }>
    }
    assert.deepEqual(res.rooms, [{ sessionGroupId: "sg-live", roomId: "R-100", title: "移动群房" }])
    await app.close()
  })
})

describe("P2.6 T1 成员禁用（AC-N3 路由守卫矩阵，全按「可用 owner 数」）", () => {
  it("PATCH enabled=false 末位可用 owner → 400；participant → 200 且 overview 反映", async () => {
    const { app, adminStore } = await build()
    adminStore.upsertMember("ou_sun", "村长", "owner")
    adminStore.upsertMember("ou_li", "小李", "participant")
    const guard = await app.inject({
      method: "PATCH",
      url: "/api/channel-admin/members/ou_sun",
      payload: { enabled: false },
    })
    assert.equal(guard.statusCode, 400, "最后一个可用 owner 不能禁用")
    const okP = await app.inject({
      method: "PATCH",
      url: "/api/channel-admin/members/ou_li",
      payload: { enabled: false },
    })
    assert.equal(okP.statusCode, 200)
    const ov = (
      await app.inject({ method: "GET", url: "/api/channel-admin/overview" })
    ).json() as { members: Array<{ openId: string; enabled: boolean }> }
    assert.equal(ov.members.find((m) => m.openId === "ou_li")?.enabled, false)
    assert.equal(ov.members.find((m) => m.openId === "ou_sun")?.enabled, true)
    await app.close()
  })

  it("两 owner 一禁一活：删/降级活的那个 → 400（旧 countOwners 的自锁洞）；删禁用的 → 200", async () => {
    const { app, adminStore } = await build()
    adminStore.upsertMember("ou_sun", "村长", "owner")
    adminStore.upsertMember("ou_backup", "备胎", "owner")
    adminStore.setMemberEnabled("ou_backup", false)
    const del = await app.inject({ method: "DELETE", url: "/api/channel-admin/members/ou_sun" })
    assert.equal(del.statusCode, 400, "另一 owner 已禁用，删活的 = 全锁")
    const demote = await app.inject({
      method: "PATCH",
      url: "/api/channel-admin/members/ou_sun",
      payload: { role: "participant" },
    })
    assert.equal(demote.statusCode, 400, "降级同款守卫")
    const delDisabled = await app.inject({
      method: "DELETE",
      url: "/api/channel-admin/members/ou_backup",
    })
    assert.equal(delDisabled.statusCode, 200, "删禁用 owner 不减可用数，放行")
    await app.close()
  })

  it("PATCH enabled 非布尔 → 400；re-enable 禁用成员 → 200 恢复", async () => {
    const { app, adminStore } = await build()
    adminStore.upsertMember("ou_sun", "村长", "owner")
    adminStore.upsertMember("ou_li", "小李", "participant")
    adminStore.setMemberEnabled("ou_li", false)
    const bad = await app.inject({
      method: "PATCH",
      url: "/api/channel-admin/members/ou_li",
      payload: { enabled: "yes" },
    })
    assert.equal(bad.statusCode, 400)
    const ok = await app.inject({
      method: "PATCH",
      url: "/api/channel-admin/members/ou_li",
      payload: { enabled: true },
    })
    assert.equal(ok.statusCode, 200)
    assert.equal(
      adminStore.listMembers().find((m) => m.openId === "ou_li")?.enabled,
      true,
    )
    await app.close()
  })

  it("放行覆写守卫升级：备用 owner 被禁用时，stale audit 放行降级唯一可用 owner → 400", async () => {
    const { app, adminStore } = await build()
    adminStore.recordReject({
      chatId: "oc_g1",
      chatKind: "group",
      openId: "ou_sun",
      reason: "member-not-allowed",
    })
    adminStore.upsertMember("ou_sun", "村长", "owner")
    adminStore.upsertMember("ou_backup", "备胎", "owner")
    adminStore.setMemberEnabled("ou_backup", false)
    const audit = adminStore.listAudit("pending").find((a) => a.openId === "ou_sun")
    assert.ok(audit)
    const res = await app.inject({
      method: "POST",
      url: `/api/channel-admin/audits/${audit.id}/allow`,
      payload: { displayName: "村长", role: "participant" },
    })
    assert.equal(res.statusCode, 400, "唯一可用 owner 不能被放行覆写降级")
    assert.equal(
      adminStore.listMembers().find((m) => m.openId === "ou_sun")?.role,
      "owner",
    )
    await app.close()
  })
})

describe("P2.6 T3 群默认应答人（AC-N5 路由，与 /agent 同一原语）", () => {
  it("PATCH defaultProvider（群已绑房）→ binding default_provider 落库 + overview 生效值", async () => {
    const { app, adminStore } = await build()
    await app.inject({
      method: "POST",
      url: "/api/channel-admin/groups",
      payload: { chatId: "oc_g1", displayName: "测试群", sessionGroupId: "sg-live" },
    })
    const res = await app.inject({
      method: "PATCH",
      url: "/api/channel-admin/groups/oc_g1",
      payload: { defaultProvider: "codex" },
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(adminStore.getBinding("oc_g1"), {
      sessionGroupId: "sg-live",
      defaultProvider: "codex",
    })
    const ov = (
      await app.inject({ method: "GET", url: "/api/channel-admin/overview" })
    ).json() as { groups: Array<{ chatId: string; effectiveDefaultProvider: string }> }
    assert.equal(ov.groups.find((g) => g.chatId === "oc_g1")?.effectiveDefaultProvider, "codex")
    await app.close()
  })

  it("未设过应答人 → overview 回渠道默认；PATCH 非法 provider → 400", async () => {
    const { app } = await build()
    await app.inject({
      method: "POST",
      url: "/api/channel-admin/groups",
      payload: { chatId: "oc_g2", sessionGroupId: "sg-live" },
    })
    const ov = (
      await app.inject({ method: "GET", url: "/api/channel-admin/overview" })
    ).json() as { groups: Array<{ chatId: string; effectiveDefaultProvider: string }> }
    assert.equal(ov.groups.find((g) => g.chatId === "oc_g2")?.effectiveDefaultProvider, "claude")
    const bad = await app.inject({
      method: "PATCH",
      url: "/api/channel-admin/groups/oc_g2",
      payload: { defaultProvider: "chatgpt" },
    })
    assert.equal(bad.statusCode, 400)
    await app.close()
  })

  it("群没绑房（无 seed 无 binding）设应答人 → 400 引导先绑房", async () => {
    const { app } = await build()
    await app.inject({
      method: "POST",
      url: "/api/channel-admin/groups",
      payload: { chatId: "oc_unbound" },
    })
    const res = await app.inject({
      method: "PATCH",
      url: "/api/channel-admin/groups/oc_unbound",
      payload: { defaultProvider: "codex" },
    })
    assert.equal(res.statusCode, 400)
    assert.match((res.json() as { error: string }).error, /先.*房间|绑定房间/)
    await app.close()
  })

  it("PATCH 同时带 sessionGroupId + defaultProvider → 新房 + 新应答人一步到位（无 binding 也建出）", async () => {
    const { app, adminStore } = await build()
    await app.inject({
      method: "POST",
      url: "/api/channel-admin/groups",
      payload: { chatId: "oc_combo" },
    })
    const res = await app.inject({
      method: "PATCH",
      url: "/api/channel-admin/groups/oc_combo",
      payload: { sessionGroupId: "sg-live", defaultProvider: "gemini" },
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(adminStore.getBinding("oc_combo"), {
      sessionGroupId: "sg-live",
      defaultProvider: "gemini",
    })
    await app.close()
  })
})

describe("P2.6 德彪 r1 #1：PATCH groups 失败请求不得留下半截写入", () => {
  it("未绑房群 PATCH {enabled:false, defaultProvider} → 400 且 enabled/名字全部原样", async () => {
    const { app, adminStore } = await build()
    await app.inject({
      method: "POST",
      url: "/api/channel-admin/groups",
      payload: { chatId: "oc_unbound", displayName: "原名" },
    })
    const res = await app.inject({
      method: "PATCH",
      url: "/api/channel-admin/groups/oc_unbound",
      payload: { enabled: false, displayName: "改名", defaultProvider: "codex" },
    })
    assert.equal(res.statusCode, 400, "无 seed 设应答人应拒")
    const g = adminStore.listGroups().find((x) => x.chatId === "oc_unbound")
    assert.equal(g?.enabled, true, "400 的请求不许把群禁了（授权面不得被失败请求改变）")
    assert.equal(g?.displayName, "原名", "400 的请求不许改名")
    assert.equal(adminStore.getBinding("oc_unbound"), null, "binding 也不许被建出")
  })
})
