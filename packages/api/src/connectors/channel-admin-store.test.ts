import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, describe, it } from "node:test"
import { SqliteStore } from "../db/sqlite"
import { ChannelAdminStore } from "./channel-admin-store"

/**
 * F040 Phase 2.5 M-T2/M-T3（AC-M1/M2/M3 核）：ChannelAdminStore。
 * - seedFromEnv：域独立判空（members/groups 各自表空才导）；表非空 DB wins（env 只是种子）
 * - getAuthView：缓存快照；任何写方法失效 → 下一次读即新值（AC-M2 热生效的单机语义）
 * - recordReject：聚合 upsert（count+1 / last_at 刷新 / status 不回退）
 * - allowFromAudit：事务 = member 落 + status='allowed'
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-admin-store-"))
let n = 0
function freshStore(): ChannelAdminStore {
  const db = new SqliteStore(path.join(tmpRoot, `db-${n++}.sqlite`))
  opened.push(db)
  let tick = 0
  return new ChannelAdminStore({
    db,
    channel: "feishu",
    genId: () => `id-${++tick}`,
    now: () => `2026-07-04T00:00:${String(tick).padStart(2, "0")}.000Z`,
  })
}
const opened: SqliteStore[] = []
after(() => {
  for (const db of opened) db.db.close()
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {}
})

const ENV_CFG = {
  allowedOpenIds: ["ou_sun"],
  groupMembers: {
    ou_sun: { name: "村长", role: "owner" as const },
    ou_biao: { name: "彪哥", role: "participant" as const },
  },
  allowedGroupChats: ["oc_g1", "oc_g2"],
  groupBindings: { oc_g1: "sg-group-1" },
}

describe("M-T2 seedFromEnv", () => {
  it("表空导入：owner 并集 + participant + 群（绑定种子可缺）", () => {
    const s = freshStore()
    const r = s.seedFromEnv(ENV_CFG)
    assert.deepEqual(r, { seededMembers: 2, seededGroups: 2 })
    const view = s.getAuthView()
    assert.deepEqual(view.allowedOpenIds, ["ou_sun"])
    assert.deepEqual(view.groupMembers, {
      ou_sun: { name: "村长", role: "owner" },
      ou_biao: { name: "彪哥", role: "participant" },
    })
    assert.deepEqual(view.allowedGroupChats, ["oc_g1", "oc_g2"])
    assert.deepEqual(view.groupBindings, { oc_g1: "sg-group-1" })
  })

  it("owner 不在 groupMembers 里 → 默认名「村长」", () => {
    const s = freshStore()
    s.seedFromEnv({ ...ENV_CFG, groupMembers: {} })
    assert.deepEqual(s.getAuthView().groupMembers, {
      ou_sun: { name: "村长", role: "owner" },
    })
  })

  it("幂等 / DB wins：表非空重跑零写入，手工改名不被 env 冲掉", () => {
    const s = freshStore()
    s.seedFromEnv(ENV_CFG)
    s.upsertMember("ou_biao", "德彪", "participant")
    const r2 = s.seedFromEnv(ENV_CFG)
    assert.deepEqual(r2, { seededMembers: 0, seededGroups: 0 })
    assert.equal(s.getAuthView().groupMembers.ou_biao?.name, "德彪")
  })

  it("域独立：members 非空 groups 空 → 只导 groups", () => {
    const s = freshStore()
    s.upsertMember("ou_pre", "先来的", "owner")
    const r = s.seedFromEnv(ENV_CFG)
    assert.equal(r.seededMembers, 0)
    assert.equal(r.seededGroups, 2)
    // members 域 DB wins：env 的 ou_sun/ou_biao 没进来
    assert.deepEqual(Object.keys(s.getAuthView().groupMembers), ["ou_pre"])
  })
})

describe("M-T2 getAuthView + 写失效（AC-M2 单机语义）", () => {
  it("upsertMember 后同实例立即可见（缓存失效）", () => {
    const s = freshStore()
    s.seedFromEnv(ENV_CFG)
    assert.equal(s.getAuthView().groupMembers.ou_new, undefined)
    s.upsertMember("ou_new", "新人", "participant")
    assert.deepEqual(s.getAuthView().groupMembers.ou_new, { name: "新人", role: "participant" })
    // participant 不进 p2p 白名单
    assert.ok(!s.getAuthView().allowedOpenIds.includes("ou_new"))
    // 升 owner → 进 p2p 白名单
    s.upsertMember("ou_new", "新人", "owner")
    assert.ok(s.getAuthView().allowedOpenIds.includes("ou_new"))
  })

  it("removeMember / removeGroup 后立即消失", () => {
    const s = freshStore()
    s.seedFromEnv(ENV_CFG)
    s.removeMember("ou_biao")
    assert.equal(s.getAuthView().groupMembers.ou_biao, undefined)
    s.removeGroup("oc_g2")
    assert.deepEqual(s.getAuthView().allowedGroupChats, ["oc_g1"])
  })

  it("群开关：enabled=0 从白名单摘除（陌生群语义），re-enable 回来", () => {
    const s = freshStore()
    s.seedFromEnv(ENV_CFG)
    s.upsertGroup("oc_g1", { enabled: false })
    assert.deepEqual(s.getAuthView().allowedGroupChats, ["oc_g2"])
    // 关掉的群绑定种子也不再暴露（disabled 群不该被 lazy-bind）
    assert.equal(s.getAuthView().groupBindings.oc_g1, undefined)
    s.upsertGroup("oc_g1", { enabled: true })
    assert.deepEqual(s.getAuthView().allowedGroupChats, ["oc_g1", "oc_g2"])
    assert.equal(s.getAuthView().groupBindings.oc_g1, "sg-group-1")
  })

  it("upsertGroup patch 语义：新 chat 插入默认值 / 已有只改给的字段", () => {
    const s = freshStore()
    s.upsertGroup("oc_new", { displayName: "测试群" })
    const g = s.listGroups().find((x) => x.chatId === "oc_new")
    assert.ok(g)
    assert.equal(g.displayName, "测试群")
    assert.equal(g.enabled, true)
    assert.equal(g.sessionGroupId, null)
    s.upsertGroup("oc_new", { sessionGroupId: "sg-x" })
    const g2 = s.listGroups().find((x) => x.chatId === "oc_new")
    assert.equal(g2?.displayName, "测试群")
    assert.equal(g2?.sessionGroupId, "sg-x")
  })

  it("countEnabledOwners / listMembers", () => {
    const s = freshStore()
    s.seedFromEnv(ENV_CFG)
    assert.equal(s.countEnabledOwners(), 1)
    assert.deepEqual(
      s.listMembers().map((m) => m.openId),
      ["ou_sun", "ou_biao"],
    )
  })
})

describe("M-T3 审计聚合 + 放行", () => {
  const REJECT = {
    chatId: "oc_g1",
    chatKind: "group" as const,
    openId: "ou_stranger",
    reason: "member-not-allowed",
  }

  it("recordReject 首拒 insert，再拒聚合 count+1 + last_at 刷新", () => {
    const s = freshStore()
    s.recordReject(REJECT)
    s.recordReject(REJECT)
    const rows = s.listAudit("pending")
    assert.equal(rows.length, 1)
    assert.equal(rows[0].count, 2)
    assert.equal(rows[0].openId, "ou_stranger")
    assert.ok(rows[0].lastAt > rows[0].firstAt)
  })

  it("不同 reason / chat 各成一行（聚合键隔离）", () => {
    const s = freshStore()
    s.recordReject(REJECT)
    s.recordReject({ ...REJECT, reason: "group-not-allowed" })
    s.recordReject({ ...REJECT, chatId: "oc_g2" })
    assert.equal(s.listAudit("pending").length, 3)
  })

  it("allowFromAudit：member 落 + status=allowed + 快照立即可见", () => {
    const s = freshStore()
    s.recordReject(REJECT)
    const audit = s.listAudit("pending")[0]
    s.allowFromAudit(audit.id, { displayName: "小李", role: "participant" })
    assert.deepEqual(s.getAuthView().groupMembers.ou_stranger, {
      name: "小李",
      role: "participant",
    })
    assert.equal(s.listAudit("pending").length, 0)
    assert.equal(s.listAudit("allowed").length, 1)
  })

  it("dismissAudit：status=dismissed；后续再拒 count 涨但 status 不回退 pending", () => {
    const s = freshStore()
    s.recordReject(REJECT)
    const audit = s.listAudit("pending")[0]
    s.dismissAudit(audit.id)
    assert.equal(s.listAudit("pending").length, 0)
    s.recordReject(REJECT)
    assert.equal(s.listAudit("pending").length, 0)
    const dismissed = s.listAudit("dismissed")
    assert.equal(dismissed.length, 1)
    assert.equal(dismissed[0].count, 2)
  })

  it("allowFromAudit 不存在的 id → 抛（显式失败不静默）", () => {
    const s = freshStore()
    assert.throws(() => s.allowFromAudit("no-such", { displayName: "x", role: "participant" }))
  })
})

describe("P2.6 T1 成员禁用（AC-N3 store 面）", () => {
  it("存量库（2.5 版无 enabled 列）→ ALTER 迁移补列，旧行默认可用", () => {
    const dbPath = path.join(tmpRoot, `db-migrate-${n++}.sqlite`)
    const raw = new DatabaseSync(dbPath)
    raw.exec(`CREATE TABLE channel_admin_members (
      channel TEXT NOT NULL,
      open_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','participant')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (channel, open_id)
    )`)
    raw
      .prepare("INSERT INTO channel_admin_members VALUES ('feishu','ou_old','老成员','owner','t','t')")
      .run()
    raw.close()
    const db = new SqliteStore(dbPath)
    opened.push(db)
    const s = new ChannelAdminStore({ db, channel: "feishu", genId: () => "x", now: () => "t" })
    const rows = s.listMembers()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].enabled, true)
    assert.ok(s.getAuthView().allowedOpenIds.includes("ou_old"))
  })

  it("setMemberEnabled(false)：p2p 白名单 + 归因映射双摘除；re-enable 回来", () => {
    const s = freshStore()
    s.seedFromEnv(ENV_CFG)
    s.setMemberEnabled("ou_sun", false)
    assert.ok(!s.getAuthView().allowedOpenIds.includes("ou_sun"))
    assert.equal(s.getAuthView().groupMembers.ou_sun, undefined)
    assert.equal(s.listMembers().find((m) => m.openId === "ou_sun")?.enabled, false)
    s.setMemberEnabled("ou_sun", true)
    assert.ok(s.getAuthView().allowedOpenIds.includes("ou_sun"))
    assert.deepEqual(s.getAuthView().groupMembers.ou_sun, { name: "村长", role: "owner" })
  })

  it("upsertMember 改名/改角色不复活禁用成员（ON CONFLICT 不碰 enabled）", () => {
    const s = freshStore()
    s.seedFromEnv(ENV_CFG)
    s.setMemberEnabled("ou_biao", false)
    s.upsertMember("ou_biao", "彪总", "participant")
    const row = s.listMembers().find((m) => m.openId === "ou_biao")
    assert.equal(row?.displayName, "彪总")
    assert.equal(row?.enabled, false)
    assert.equal(s.getAuthView().groupMembers.ou_biao, undefined)
  })

  it("allowFromAudit 放行 = 复活（enabled 置回 1）", () => {
    const s = freshStore()
    s.seedFromEnv(ENV_CFG)
    s.setMemberEnabled("ou_biao", false)
    s.recordReject({
      chatId: "oc_g1",
      chatKind: "group",
      openId: "ou_biao",
      reason: "member-not-allowed",
    })
    const audit = s.listAudit("pending").find((a) => a.openId === "ou_biao")
    assert.ok(audit, "禁用成员再敲门应进待放行")
    s.allowFromAudit(audit.id, { displayName: "彪哥回归", role: "participant" })
    const row = s.listMembers().find((m) => m.openId === "ou_biao")
    assert.equal(row?.enabled, true)
    assert.deepEqual(s.getAuthView().groupMembers.ou_biao, { name: "彪哥回归", role: "participant" })
  })

  it("countEnabledOwners 只数可用 owner（禁用 owner 不算）", () => {
    const s = freshStore()
    s.upsertMember("ou_a", "A", "owner")
    s.upsertMember("ou_b", "B", "owner")
    assert.equal(s.countEnabledOwners(), 2)
    s.setMemberEnabled("ou_b", false)
    assert.equal(s.countEnabledOwners(), 1)
  })
})

describe("P2.6 T3 绑定原语（管理页下拉 / /agent / /switch 三入口共用）", () => {
  function bindingOf(s: ChannelAdminStore, db: SqliteStore, chatId: string) {
    const row = db.db
      .prepare(
        "SELECT chat_kind, session_group_id, default_provider FROM channel_bindings WHERE connector_id = ? AND external_chat_id = ?",
      )
      .get(s.channel, chatId) as
      | { chat_kind: string; session_group_id: string; default_provider: string }
      | undefined
    // node:sqlite 行是 null-prototype，deepEqual 前必 spread（F040 P2 既有坑）
    return row ? { ...row } : undefined
  }

  it("rebindChat 群：无 binding 行 → INSERT + admin seed 同步；有 → UPDATE 双写", () => {
    const dbPath = path.join(tmpRoot, `db-${n++}.sqlite`)
    const db = new SqliteStore(dbPath)
    opened.push(db)
    let tick = 0
    const s = new ChannelAdminStore({
      db,
      channel: "feishu",
      genId: () => `bid-${++tick}`,
      now: () => "t",
    })
    // 无 binding：一步建 binding + admin 行种子
    s.rebindChat("oc_new", "group", "sg-room-a", { defaultProvider: "claude" })
    assert.deepEqual(bindingOf(s, db, "oc_new"), {
      chat_kind: "group",
      session_group_id: "sg-room-a",
      default_provider: "claude",
    })
    assert.equal(s.listGroups().find((g) => g.chatId === "oc_new")?.sessionGroupId, "sg-room-a")
    assert.equal(s.getAuthView().groupBindings.oc_new, "sg-room-a")
    // 已有 binding：换绑 UPDATE（provider 不被覆写）
    s.rebindChat("oc_new", "group", "sg-room-b", { defaultProvider: "gemini" })
    const after = bindingOf(s, db, "oc_new")
    assert.equal(after?.session_group_id, "sg-room-b")
    assert.equal(after?.default_provider, "claude", "换绑不动已有默认应答人")
    assert.equal(s.listGroups().find((g) => g.chatId === "oc_new")?.sessionGroupId, "sg-room-b")
  })

  it("rebindChat p2p：建/换 binding，不碰 admin 群表", () => {
    const s = freshStore()
    const db = opened[opened.length - 1]
    s.rebindChat("p2p_sun", "p2p", "sg-mobile", { defaultProvider: "claude" })
    assert.equal(bindingOf(s, db, "p2p_sun")?.session_group_id, "sg-mobile")
    assert.equal(s.listGroups().length, 0)
    s.rebindChat("p2p_sun", "p2p", "sg-other", { defaultProvider: "claude" })
    assert.equal(bindingOf(s, db, "p2p_sun")?.session_group_id, "sg-other")
  })

  it("setDefaultResponder：有 binding → 改 provider；无 binding 有 seed → INSERT；无 seed → throw", () => {
    const s = freshStore()
    const db = opened[opened.length - 1]
    s.rebindChat("oc_g", "group", "sg-room", { defaultProvider: "claude" })
    s.setDefaultResponder("oc_g", "group", "codex", { seedSessionGroupId: null })
    assert.equal(bindingOf(s, db, "oc_g")?.default_provider, "codex")
    assert.equal(bindingOf(s, db, "oc_g")?.session_group_id, "sg-room", "改应答人不动绑定")
    // 无 binding + seed → 一步建 binding 带指定 provider
    s.setDefaultResponder("oc_fresh", "group", "gemini", { seedSessionGroupId: "sg-seed" })
    assert.deepEqual(bindingOf(s, db, "oc_fresh"), {
      chat_kind: "group",
      session_group_id: "sg-seed",
      default_provider: "gemini",
    })
    // 无 binding 无 seed → 显式失败（先绑房）
    assert.throws(() =>
      s.setDefaultResponder("oc_nowhere", "group", "codex", { seedSessionGroupId: null }),
    )
  })

  it("getBinding：读 binding 现值；不存在 → null", () => {
    const s = freshStore()
    assert.equal(s.getBinding("oc_none"), null)
    s.rebindChat("oc_x", "group", "sg-1", { defaultProvider: "claude" })
    assert.deepEqual(s.getBinding("oc_x"), { sessionGroupId: "sg-1", defaultProvider: "claude" })
  })
})
