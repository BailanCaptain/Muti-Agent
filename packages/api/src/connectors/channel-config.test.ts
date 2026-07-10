import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { loadFeishuChannelConfig, resolveFeishuEnv } from "./channel-config"

const envTmp = fs.mkdtempSync(path.join(os.tmpdir(), "f040-env-"))
after(() => {
  try {
    fs.rmSync(envTmp, { recursive: true, force: true })
  } catch {}
})
function writeEnv(content: string): string {
  const f = path.join(envTmp, `.env-${Math.random().toString(36).slice(2)}`)
  fs.writeFileSync(f, content)
  return f
}

describe("resolveFeishuEnv（窄读 .env 的 FEISHU_，API 进程不自动 load .env）", () => {
  it("只读 FEISHU_ 前缀，非 FEISHU_（如 CORS_ORIGIN）绝不引入", () => {
    const f = writeEnv(
      "CORS_ORIGIN=http://localhost:3000\nFEISHU_APP_ID=cli_x\nFEISHU_APP_SECRET=sec\n# 注释\nFEISHU_ALLOWED_OPEN_IDS=ou_a\n",
    )
    const merged = resolveFeishuEnv({}, f)
    assert.equal(merged.FEISHU_APP_ID, "cli_x")
    assert.equal(merged.FEISHU_APP_SECRET, "sec")
    assert.equal(merged.FEISHU_ALLOWED_OPEN_IDS, "ou_a")
    assert.equal(merged.CORS_ORIGIN, undefined, "非 FEISHU_ 不引入（保护 CORS/HOST/SQLITE）")
  })

  it("系统环境变量优先于 .env 文件", () => {
    const f = writeEnv("FEISHU_APP_ID=from_file\n")
    const merged = resolveFeishuEnv({ FEISHU_APP_ID: "from_sysenv" }, f)
    assert.equal(merged.FEISHU_APP_ID, "from_sysenv")
  })

  it(".env 不存在 → 返回 processEnv 原样不崩", () => {
    const merged = resolveFeishuEnv({ FOO: "bar" }, path.join(envTmp, "nonexistent.env"))
    assert.equal(merged.FOO, "bar")
    assert.equal(merged.FEISHU_APP_ID, undefined)
  })

  it("去成对引号（单/双）", () => {
    const f = writeEnv('FEISHU_APP_ID="cli_q"\nFEISHU_APP_SECRET=\'sec_q\'\n')
    const merged = resolveFeishuEnv({}, f)
    assert.equal(merged.FEISHU_APP_ID, "cli_q")
    assert.equal(merged.FEISHU_APP_SECRET, "sec_q")
  })

  it("接 loadFeishuChannelConfig：.env 填齐 FEISHU_ → enabled", () => {
    const f = writeEnv(
      [
        "CORS_ORIGIN=http://localhost:3000", // 干扰项，不该被读
        "FEISHU_APP_ID=cli_a",
        "FEISHU_APP_SECRET=s",
        "FEISHU_ALLOWED_OPEN_IDS=ou_sun",
        "FEISHU_BIND_SESSION_GROUP=sg-1",
      ].join("\n"),
    )
    const cfg = loadFeishuChannelConfig(resolveFeishuEnv({}, f))
    assert.ok(cfg.enabled)
  })
})

/** F040 T3 / AC1 前半：env 校验 fail-closed —— 缺任一必填 → disabled + 点名缺哪个。 */

const FULL = {
  FEISHU_APP_ID: "cli_a1",
  FEISHU_APP_SECRET: "secret1",
  FEISHU_ALLOWED_OPEN_IDS: "ou_sun, ou_backup",
  FEISHU_BIND_SESSION_GROUP: "sg-mobile-1",
}

describe("loadFeishuChannelConfig", () => {
  it("全配齐 → enabled + allowlist 解析（trim + 去空）", () => {
    const c = loadFeishuChannelConfig(FULL)
    assert.ok(c.enabled)
    if (!c.enabled) return
    assert.equal(c.appId, "cli_a1")
    assert.equal(c.appSecret, "secret1")
    assert.deepEqual(c.allowedOpenIds, ["ou_sun", "ou_backup"])
    assert.equal(c.bindSessionGroup, "sg-mobile-1")
    assert.equal(c.defaultProvider, "claude")
  })

  for (const key of [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_ALLOWED_OPEN_IDS",
    "FEISHU_BIND_SESSION_GROUP",
  ] as const) {
    it(`缺 ${key} → disabled 且 reason 点名`, () => {
      const env = { ...FULL, [key]: undefined }
      const c = loadFeishuChannelConfig(env)
      assert.equal(c.enabled, false)
      if (c.enabled) return
      assert.ok(c.reason.includes(key), `reason 应含 ${key}：${c.reason}`)
    })
  }

  it("ALLOWED_OPEN_IDS 空白/纯逗号 → disabled（白名单不得为空，D5）", () => {
    for (const v of ["", "  ", ",", " , ,"]) {
      const c = loadFeishuChannelConfig({ ...FULL, FEISHU_ALLOWED_OPEN_IDS: v })
      assert.equal(c.enabled, false)
    }
  })

  it("FEISHU_DEFAULT_PROVIDER 可覆盖默认 claude", () => {
    const c = loadFeishuChannelConfig({ ...FULL, FEISHU_DEFAULT_PROVIDER: "codex" })
    assert.ok(c.enabled)
    if (!c.enabled) return
    assert.equal(c.defaultProvider, "codex")
  })

  it("必填值纯空白视为缺失", () => {
    const c = loadFeishuChannelConfig({ ...FULL, FEISHU_APP_SECRET: "   " })
    assert.equal(c.enabled, false)
  })
})

/** F040 Phase 2 T1：群三元组解析（群白名单 / 成员白名单带昵称 / 群绑定种子）。 */
describe("loadFeishuChannelConfig · Phase 2 群三元组", () => {
  it("三项全缺省 → enabled 且群模式关（空集合，p2p 行为零变化）", () => {
    const c = loadFeishuChannelConfig(FULL)
    assert.ok(c.enabled)
    if (!c.enabled) return
    assert.deepEqual(c.allowedGroupChats, [])
    assert.deepEqual(c.groupMembers, {})
    assert.deepEqual(c.groupBindings, {})
  })

  it("配齐 → 解析（trim/去空；owner=open_id ∈ ALLOWED_OPEN_IDS，其余 participant）", () => {
    const c = loadFeishuChannelConfig({
      ...FULL, // FEISHU_ALLOWED_OPEN_IDS: "ou_sun, ou_backup"
      FEISHU_ALLOWED_GROUP_CHATS: "oc_a, oc_b",
      FEISHU_GROUP_MEMBERS: "ou_sun:小孙, ou_li:小李",
      FEISHU_GROUP_BINDINGS: "oc_a:sg-room-1, oc_b:sg-room-2",
    })
    assert.ok(c.enabled)
    if (!c.enabled) return
    assert.deepEqual(c.allowedGroupChats, ["oc_a", "oc_b"])
    assert.deepEqual(c.groupMembers, {
      ou_sun: { name: "小孙", role: "owner" },
      ou_li: { name: "小李", role: "participant" },
    })
    assert.deepEqual(c.groupBindings, { oc_a: "sg-room-1", oc_b: "sg-room-2" })
  })

  it("昵称可含冒号（首冒号切分，其余归昵称）", () => {
    const c = loadFeishuChannelConfig({ ...FULL, FEISHU_GROUP_MEMBERS: "ou_x:小李:后缀" })
    assert.ok(c.enabled)
    if (!c.enabled) return
    assert.deepEqual(c.groupMembers.ou_x, { name: "小李:后缀", role: "participant" })
  })

  it("FEISHU_GROUP_MEMBERS 条目格式错（缺冒号/空 open_id/空昵称）→ disabled 点名", () => {
    for (const bad of ["ou_x", "ou_x:", ":小李", "ou_x: "]) {
      const c = loadFeishuChannelConfig({ ...FULL, FEISHU_GROUP_MEMBERS: bad })
      assert.equal(c.enabled, false, `应拒：${JSON.stringify(bad)}`)
      if (c.enabled) return
      assert.ok(c.reason.includes("FEISHU_GROUP_MEMBERS"), c.reason)
    }
  })

  it("FEISHU_GROUP_BINDINGS 条目格式错 → disabled 点名", () => {
    for (const bad of ["oc_a", "oc_a:", ":sg-1"]) {
      const c = loadFeishuChannelConfig({ ...FULL, FEISHU_GROUP_BINDINGS: bad })
      assert.equal(c.enabled, false, `应拒：${JSON.stringify(bad)}`)
      if (c.enabled) return
      assert.ok(c.reason.includes("FEISHU_GROUP_BINDINGS"), c.reason)
    }
  })

  it("配了群白名单、种子缺 → 仍 enabled（运行时门兜「群未绑定房间」，库内既有 binding 不受 env 缺失影响）", () => {
    const c = loadFeishuChannelConfig({ ...FULL, FEISHU_ALLOWED_GROUP_CHATS: "oc_a" })
    assert.ok(c.enabled)
    if (!c.enabled) return
    assert.deepEqual(c.allowedGroupChats, ["oc_a"])
    assert.deepEqual(c.groupBindings, {})
  })
})
