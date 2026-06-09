/**
 * F027 P19.8 · NightlyHealthCheck 测试 — AC-P2-10
 *
 * 5 类问题 red/green fixture：
 *   - deadLinks: red (引用不存在 path) / green (引用全 resolve)
 *   - orphans: red (无 inbound) / green (有 inbound + draft 路径豁免)
 *   - missingFrontmatter: red (缺 sources / canonical_owner_path) / green
 *   - canonicalOwnerDrift: red (path != declared) / green
 *   - draftExpired: red (>30 天 + reviewing 缺) / green (reviewing=true 跳过)
 *
 * v2 修订验证：draft frontmatter reviewing=true 不进 draftExpired。
 */

import assert from "node:assert/strict"
import test from "node:test"
import {
  type HealthCheckReport,
  NightlyHealthCheck,
  type WikiEntity,
} from "./nightly-health-check"

function newCheck(opts: {
  entities: WikiEntity[]
  now?: Date
  ttlDays?: number
  movedRecorder?: Array<{ src: string; dst: string }>
}): NightlyHealthCheck {
  const moved = opts.movedRecorder
  return new NightlyHealthCheck({
    scanEntities: async () => opts.entities,
    clock: opts.now ? () => opts.now! : undefined,
    draftTtlDays: opts.ttlDays,
    moveExpiredDraft: moved
      ? async (src, dst) => {
          moved.push({ src, dst })
        }
      : undefined,
  })
}

function entity(p: string, body = "", fm: WikiEntity["frontmatter"] = {}): WikiEntity {
  return {
    path: p,
    body,
    frontmatter: { sources: ["src.md"], canonical_owner_path: p, ...fm },
  }
}

// ── deadLinks ────────────────────────────────────────────────────────────

test("NightlyHealthCheck · deadLinks RED — entity 引用不存在的 path", async () => {
  const check = newCheck({
    entities: [
      entity("wiki/concepts/foo.md", "# foo\n\n[[wiki/concepts/missing]]\n"),
      entity("wiki/concepts/bar.md", "# bar\n"),
    ],
  })
  const report = await check.run()
  assert.equal(report.deadLinks.length, 1)
  assert.equal(report.deadLinks[0].from, "wiki/concepts/foo.md")
  // 范-r1 P1 改：deadLink.to 报 raw target（保留 user-visible 链文本，不自动 .md 后缀）
  assert.equal(report.deadLinks[0].to, "wiki/concepts/missing")
})

// ── 范-r1 P1: wikilink resolver hook ───────────────────────────────────

test("NightlyHealthCheck · 范-r1 P1: name-style wikilink (无 /) + 无 resolver → 不报 deadLink", async () => {
  // [[Concept Name|alias]] / [[Concept Name#section]] 是 compile-prompt.ts:75 实际格式
  const check = newCheck({
    entities: [
      entity("wiki/concepts/foo.md", "see [[Concept Name|alias]] and [[Other#section]]\n"),
    ],
    // 不注入 resolveWikiLink → default 行为：name-style 不报 deadLink (避免 false positive)
  })
  const report = await check.run()
  assert.equal(
    report.deadLinks.length,
    0,
    "name-style wikilink 默认 silent skip; caller 用 resolver 接 wiki-services",
  )
})

test("NightlyHealthCheck · 范-r1 P1: name-style wikilink + resolver 返合法 path → inbound 计数 + 不 deadLink", async () => {
  const check = new NightlyHealthCheck({
    scanEntities: async () => [
      entity("wiki/concepts/foo.md", "see [[Concept Name|alias]]\n"),
      entity("wiki/concepts/concept.md", "# concept\n"),
    ],
    resolveWikiLink: (target) => {
      // alias 已被 regex 剥离 m[1] = "Concept Name"
      if (target === "Concept Name") return "wiki/concepts/concept.md"
      return null
    },
  })
  const report = await check.run()
  assert.equal(report.deadLinks.length, 0, "resolver 返合法 path → 不 deadLink")
  // concept.md 应有 inbound count (foo 引用了它)
  assert.ok(!report.orphans.includes("wiki/concepts/concept.md"))
})

test("NightlyHealthCheck · 范-r1 P1: name-style wikilink + resolver 返 null → silent skip 不 deadLink", async () => {
  const check = new NightlyHealthCheck({
    scanEntities: async () => [
      entity("wiki/concepts/foo.md", "see [[Unknown Concept]]\n"),
    ],
    resolveWikiLink: () => null, // resolver 不知道
  })
  const report = await check.run()
  assert.equal(
    report.deadLinks.length,
    0,
    "resolver 返 null 也 silent skip（resolver 自己判断不报）",
  )
})

test("NightlyHealthCheck · 范-r1 P1: alias [[Name|alias]] regex 剥离 alias 后传 resolver", async () => {
  let receivedTarget: string | null = null
  const check = new NightlyHealthCheck({
    scanEntities: async () => [
      entity("wiki/concepts/foo.md", "[[My Concept|displayed text]]\n"),
    ],
    resolveWikiLink: (target) => {
      receivedTarget = target
      return null
    },
  })
  await check.run()
  assert.equal(receivedTarget, "My Concept", "alias 'displayed text' 应被剥离")
})

test("NightlyHealthCheck · 范-r1 P1: hash [[Name#section]] regex 剥离 #section", async () => {
  let receivedTarget: string | null = null
  const check = new NightlyHealthCheck({
    scanEntities: async () => [
      entity("wiki/concepts/foo.md", "[[My Concept#sec1]]\n"),
    ],
    resolveWikiLink: (target) => {
      receivedTarget = target
      return null
    },
  })
  await check.run()
  assert.equal(receivedTarget, "My Concept", "#section 应被剥离")
})

test("NightlyHealthCheck · deadLinks GREEN — wikilink 全 resolve", async () => {
  const check = newCheck({
    entities: [
      entity("wiki/concepts/foo.md", "[[wiki/concepts/bar]]\n"),
      entity("wiki/concepts/bar.md", "# bar\n"),
    ],
  })
  const report = await check.run()
  assert.equal(report.deadLinks.length, 0)
})

test("NightlyHealthCheck · deadLinks 相对 path link (../)", async () => {
  const check = newCheck({
    entities: [
      entity("wiki/concepts/a.md", "see [b](../concepts/b.md)\n"),
      entity("wiki/concepts/b.md", "# b\n"),
    ],
  })
  const report = await check.run()
  assert.equal(report.deadLinks.length, 0)
})

test("NightlyHealthCheck · deadLinks 相对 path 不存在 → red", async () => {
  const check = newCheck({
    entities: [entity("wiki/concepts/a.md", "see [missing](./missing.md)\n")],
  })
  const report = await check.run()
  assert.equal(report.deadLinks.length, 1)
})

// ── orphans ──────────────────────────────────────────────────────────────

test("NightlyHealthCheck · orphans RED — 无 inbound link 的非 draft 文件", async () => {
  const check = newCheck({
    entities: [
      entity("wiki/concepts/popular.md", "[[wiki/concepts/popular]]\n[[wiki/concepts/orphan]]\n"),
      entity("wiki/concepts/orphan.md", "# orphan\n"),
      entity("wiki/concepts/never-referenced.md", "# unused\n"),
    ],
  })
  const report = await check.run()
  // popular 引用了 orphan（self-loop popular 不算 inbound）
  // never-referenced 是 orphan
  assert.ok(report.orphans.includes("wiki/concepts/never-referenced.md"))
})

test("NightlyHealthCheck · orphans 豁免任何 /draft/ 路径（含 _expired / _quarantined — 范-r1 P2-2）", async () => {
  const check = newCheck({
    entities: [
      entity("wiki/concepts/draft/auto-1.md", "# auto draft 1\n"),
      entity("wiki/concepts/draft/_expired/old.md", "# expired\n"),
      entity("wiki/concepts/draft/_quarantined/sus.md", "# quarantined\n"),
      entity("wiki/concepts/finalized.md", "# fin\n"),
    ],
  })
  const report = await check.run()
  // 任何 /draft/ 路径都豁免（含已归档 / 已隔离 — 它们本来就不该被引用）
  assert.ok(!report.orphans.includes("wiki/concepts/draft/auto-1.md"))
  assert.ok(!report.orphans.includes("wiki/concepts/draft/_expired/old.md"))
  assert.ok(!report.orphans.includes("wiki/concepts/draft/_quarantined/sus.md"))
  // finalized 无 inbound 算 orphan
  assert.ok(report.orphans.includes("wiki/concepts/finalized.md"))
})

// 范-r1 P2-3: self-link 不算 inbound（防自循环 orphan 被隐藏）
test("NightlyHealthCheck · 范-r1 P2-3: self-link 不算 inbound → 自循环 orphan 仍被识别", async () => {
  const check = newCheck({
    entities: [
      entity("wiki/concepts/lonely.md", "# lonely\n\n[[wiki/concepts/lonely]]\n"),
    ],
  })
  const report = await check.run()
  assert.ok(
    report.orphans.includes("wiki/concepts/lonely.md"),
    "自循环不算 inbound，lonely 仍报 orphan",
  )
})

// ── missingFrontmatter ──────────────────────────────────────────────────

test("NightlyHealthCheck · missingFrontmatter RED — 缺 sources", async () => {
  const e: WikiEntity = {
    path: "wiki/concepts/x.md",
    body: "[[wiki/concepts/x]]\n",
    frontmatter: { canonical_owner_path: "wiki/concepts/x.md" },
  }
  const check = newCheck({ entities: [e] })
  const report = await check.run()
  assert.equal(report.missingFrontmatter.length, 1)
  assert.deepEqual(report.missingFrontmatter[0].missing, ["sources"])
})

test("NightlyHealthCheck · missingFrontmatter RED — 缺 canonical_owner_path", async () => {
  const e: WikiEntity = {
    path: "wiki/concepts/y.md",
    body: "[[wiki/concepts/y]]\n",
    frontmatter: { sources: ["src.md"] },
  }
  const check = newCheck({ entities: [e] })
  const report = await check.run()
  assert.equal(report.missingFrontmatter.length, 1)
  assert.deepEqual(report.missingFrontmatter[0].missing, ["canonical_owner_path"])
})

test("NightlyHealthCheck · missingFrontmatter GREEN — 全字段在", async () => {
  const check = newCheck({
    entities: [entity("wiki/concepts/full.md", "[[wiki/concepts/full]]\n")],
  })
  const report = await check.run()
  assert.equal(report.missingFrontmatter.length, 0)
})

// ── canonicalOwnerDrift ─────────────────────────────────────────────────

test("NightlyHealthCheck · canonicalOwnerDrift RED — path != declared", async () => {
  const e: WikiEntity = {
    path: "wiki/concepts/actual.md",
    body: "[[wiki/concepts/actual]]\n",
    frontmatter: { sources: ["s.md"], canonical_owner_path: "wiki/concepts/wrong-place.md" },
  }
  const check = newCheck({ entities: [e] })
  const report = await check.run()
  assert.equal(report.canonicalOwnerDrift.length, 1)
  assert.equal(report.canonicalOwnerDrift[0].path, "wiki/concepts/actual.md")
  assert.equal(report.canonicalOwnerDrift[0].declared, "wiki/concepts/wrong-place.md")
})

test("NightlyHealthCheck · canonicalOwnerDrift GREEN — path == declared", async () => {
  const check = newCheck({
    entities: [entity("wiki/concepts/aligned.md", "[[wiki/concepts/aligned]]\n")],
  })
  const report = await check.run()
  assert.equal(report.canonicalOwnerDrift.length, 0)
})

// ── draftExpired (含 v2 修订 reviewing=true 跳过) ───────────────────────

test("NightlyHealthCheck · draftExpired RED — draft >30 天，reviewing 缺", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z")
  const oldCreated = new Date("2026-05-01T00:00:00.000Z").toISOString() // 45 天前
  const moved: Array<{ src: string; dst: string }> = []
  const check = newCheck({
    entities: [
      entity("wiki/concepts/draft/old-auto.md", "[[wiki/concepts/draft/old-auto]]\n", {
        created_at: oldCreated,
      }),
    ],
    now,
    movedRecorder: moved,
  })
  const report = await check.run()
  assert.equal(report.draftExpired.length, 1)
  assert.ok(report.draftExpired[0].ageDays >= 45)
  assert.equal(report.draftExpired[0].movedTo, "wiki/concepts/draft/_expired/old-auto.md")
  // 验证 mover 真被调
  assert.equal(moved.length, 1)
  assert.equal(moved[0].src, "wiki/concepts/draft/old-auto.md")
  assert.equal(moved[0].dst, "wiki/concepts/draft/_expired/old-auto.md")
})

test("NightlyHealthCheck · draftExpired GREEN — draft <30 天", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z")
  const recent = new Date("2026-06-10T00:00:00.000Z").toISOString() // 5 天前
  const check = newCheck({
    entities: [
      entity("wiki/concepts/draft/new.md", "[[wiki/concepts/draft/new]]\n", {
        created_at: recent,
      }),
    ],
    now,
  })
  const report = await check.run()
  assert.equal(report.draftExpired.length, 0)
})

test("NightlyHealthCheck · draftExpired v2 修订 — reviewing=true 跳过归档", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z")
  const oldCreated = new Date("2026-05-01T00:00:00.000Z").toISOString() // 45 天前
  const moved: Array<{ src: string; dst: string }> = []
  const check = newCheck({
    entities: [
      entity("wiki/concepts/draft/under-review.md", "[[x]]\n", {
        created_at: oldCreated,
        reviewing: true, // ★ v2 修订关键
      }),
    ],
    now,
    movedRecorder: moved,
  })
  const report = await check.run()
  assert.equal(
    report.draftExpired.length,
    0,
    "reviewing=true 即使 >30 天也不应归档（审核中保留）",
  )
  assert.equal(moved.length, 0, "mover 不应被调")
})

test("NightlyHealthCheck · draftExpired 无 mover → movedTo=null（dry-run 模式）", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z")
  const oldCreated = new Date("2026-05-01T00:00:00.000Z").toISOString()
  const check = newCheck({
    entities: [
      entity("wiki/concepts/draft/old.md", "[[x]]\n", { created_at: oldCreated }),
    ],
    now,
    // 无 movedRecorder → moveExpiredDraft 未注入
  })
  const report = await check.run()
  assert.equal(report.draftExpired.length, 1)
  assert.equal(report.draftExpired[0].movedTo, null, "无 mover → movedTo=null")
})

// 范-r1 P2-2: split active vs expired/quarantined draft
test("NightlyHealthCheck · 范-r1 P2-2: _expired/ 路径下 30 天前 draft 不重复归档", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z")
  const oldCreated = new Date("2026-05-01T00:00:00.000Z").toISOString() // 45 天前
  const moved: Array<{ src: string; dst: string }> = []
  const check = newCheck({
    entities: [
      entity("wiki/concepts/draft/_expired/already-archived.md", "# old\n", {
        created_at: oldCreated,
      }),
    ],
    now,
    movedRecorder: moved,
  })
  const report = await check.run()
  assert.equal(report.draftExpired.length, 0, "_expired/ 已归档不应重复触发")
  assert.equal(moved.length, 0, "mover 不应被调")
})

test("NightlyHealthCheck · 范-r1 P2-2: _quarantined/ 路径下 30 天前 draft 不归档（隔离不动）", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z")
  const oldCreated = new Date("2026-05-01T00:00:00.000Z").toISOString()
  const moved: Array<{ src: string; dst: string }> = []
  const check = newCheck({
    entities: [
      entity("wiki/concepts/draft/_quarantined/sus.md", "# blocked\n", {
        created_at: oldCreated,
      }),
    ],
    now,
    movedRecorder: moved,
  })
  const report = await check.run()
  assert.equal(report.draftExpired.length, 0, "_quarantined/ 隔离 draft 不归档")
  assert.equal(moved.length, 0)
})

test("NightlyHealthCheck · 范-r1 P2-2: _backfill / _auto active draft 仍正常归档（>30 天）", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z")
  const oldCreated = new Date("2026-05-01T00:00:00.000Z").toISOString()
  const moved: Array<{ src: string; dst: string }> = []
  const check = newCheck({
    entities: [
      entity("wiki/concepts/draft/_backfill/old-bf.md", "# bf\n", { created_at: oldCreated }),
      entity("wiki/concepts/draft/_auto/old-auto.md", "# auto\n", { created_at: oldCreated }),
    ],
    now,
    movedRecorder: moved,
  })
  const report = await check.run()
  assert.equal(report.draftExpired.length, 2, "active draft (_backfill / _auto) 仍归档")
  assert.equal(moved.length, 2)
})

test("NightlyHealthCheck · draftExpired mover throw → 落 movedTo=null + 不抛", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z")
  const oldCreated = new Date("2026-05-01T00:00:00.000Z").toISOString()
  const check = new NightlyHealthCheck({
    scanEntities: async () => [
      entity("wiki/concepts/draft/sticky.md", "[[x]]\n", { created_at: oldCreated }),
    ],
    clock: () => now,
    moveExpiredDraft: async () => {
      throw new Error("EBUSY")
    },
  })
  const report = await check.run()
  assert.equal(report.draftExpired.length, 1)
  assert.equal(report.draftExpired[0].movedTo, null)
})

// ── duplicateCanonical (F027 chunk B · lint R1 搬来) ───────────────────

test("NightlyHealthCheck · duplicateCanonical RED — 两个非 draft entity 声称同一 canonical path", async () => {
  const check = newCheck({
    entities: [
      entity("wiki/concepts/a.md", "[[wiki/concepts/a]]\n", {
        canonical_owner_path: "wiki/concepts/shared.md",
      }),
      entity("wiki/concepts/b.md", "[[wiki/concepts/b]]\n", {
        canonical_owner_path: "wiki/concepts/shared.md",
      }),
    ],
  })
  const report = await check.run()
  assert.equal(report.duplicateCanonical.length, 1)
  assert.equal(report.duplicateCanonical[0].canonicalOwnerPath, "wiki/concepts/shared.md")
  assert.deepEqual(report.duplicateCanonical[0].claimants.sort(), [
    "wiki/concepts/a.md",
    "wiki/concepts/b.md",
  ])
})

test("NightlyHealthCheck · duplicateCanonical GREEN — 每个 entity 声称自己 → 无重复", async () => {
  const check = newCheck({
    entities: [
      entity("wiki/concepts/a.md", "[[wiki/concepts/a]]\n"),
      entity("wiki/concepts/b.md", "[[wiki/concepts/b]]\n"),
    ],
  })
  const report = await check.run()
  assert.equal(report.duplicateCanonical.length, 0)
})

test("NightlyHealthCheck · duplicateCanonical 豁免 /draft/ — draft 重复声称不报", async () => {
  const check = newCheck({
    entities: [
      entity("wiki/concepts/draft/d1.md", "# d1\n", {
        canonical_owner_path: "wiki/concepts/shared.md",
      }),
      entity("wiki/concepts/draft/d2.md", "# d2\n", {
        canonical_owner_path: "wiki/concepts/shared.md",
      }),
    ],
  })
  const report = await check.run()
  assert.equal(report.duplicateCanonical.length, 0, "draft 未 promote，重复声称豁免")
})

// ── deadSupersedes (F027 chunk B · lint R3 搬来) ────────────────────────

test("NightlyHealthCheck · deadSupersedes RED — supersedes 指向不存在的 path", async () => {
  const check = newCheck({
    entities: [
      entity("wiki/concepts/new.md", "[[wiki/concepts/new]]\n", {
        supersedes: ["wiki/concepts/gone.md", "wiki/concepts/alive.md"],
      }),
      entity("wiki/concepts/alive.md", "[[wiki/concepts/alive]]\n"),
    ],
  })
  const report = await check.run()
  assert.equal(report.deadSupersedes.length, 1)
  assert.equal(report.deadSupersedes[0].path, "wiki/concepts/new.md")
  assert.deepEqual(report.deadSupersedes[0].missing, ["wiki/concepts/gone.md"])
})

test("NightlyHealthCheck · deadSupersedes GREEN — supersedes 全部存在", async () => {
  const check = newCheck({
    entities: [
      entity("wiki/concepts/new.md", "[[wiki/concepts/new]]\n", {
        supersedes: ["wiki/concepts/old.md"],
      }),
      entity("wiki/concepts/old.md", "[[wiki/concepts/old]]\n"),
    ],
  })
  const report = await check.run()
  assert.equal(report.deadSupersedes.length, 0)
})

test("NightlyHealthCheck · deadSupersedes 无 supersedes 字段 → 跳过", async () => {
  const check = newCheck({
    entities: [entity("wiki/concepts/plain.md", "[[wiki/concepts/plain]]\n")],
  })
  const report = await check.run()
  assert.equal(report.deadSupersedes.length, 0)
})

// ── 复合 fixture: 所有 5 类同时出现 ──────────────────────────────────

test("NightlyHealthCheck · 复合 fixture: 5 类问题同时出现 + report 全字段正确", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z")
  const oldCreated = new Date("2026-05-01T00:00:00.000Z").toISOString()
  const entities: WikiEntity[] = [
    // 死链来源
    entity("wiki/concepts/with-deadlink.md", "[[wiki/concepts/missing]]\n"),
    // 孤岛（非 draft，无 inbound）
    entity("wiki/concepts/orphan.md", "# orphan\n"),
    // 缺 frontmatter
    {
      path: "wiki/concepts/no-fm.md",
      body: "[[wiki/concepts/no-fm]]\n",
      frontmatter: {},
    },
    // canonical drift
    {
      path: "wiki/concepts/drifted.md",
      body: "[[wiki/concepts/drifted]]\n",
      frontmatter: { sources: ["s.md"], canonical_owner_path: "wiki/concepts/elsewhere.md" },
    },
    // expired draft
    entity("wiki/concepts/draft/expired-1.md", "# x\n", { created_at: oldCreated }),
  ]
  const moved: Array<{ src: string; dst: string }> = []
  const check = newCheck({ entities, now, movedRecorder: moved })
  const report = await check.run()

  assert.ok(report.deadLinks.length >= 1)
  assert.ok(report.orphans.length >= 1)
  assert.ok(report.missingFrontmatter.length >= 1)
  assert.ok(report.canonicalOwnerDrift.length >= 1)
  assert.ok(report.draftExpired.length >= 1)
  assert.equal(report.totalEntities, 5)
  assert.match(report.scannedAt, /^\d{4}-\d{2}-\d{2}T/)
})

// ── onReport 回调 ──────────────────────────────────────────────────────

test("NightlyHealthCheck · onReport 回调被调用 + throw 不打断", async () => {
  const reportsReceived: HealthCheckReport[] = []
  const check = new NightlyHealthCheck({
    scanEntities: async () => [
      entity("wiki/concepts/x.md", "[[wiki/concepts/x]]\n"),
    ],
    onReport: (r) => {
      reportsReceived.push(r)
      throw new Error("on-report broken")
    },
  })
  // throw 应被吞，run() 仍正常返 report
  const report = await check.run()
  assert.ok(report)
  assert.equal(reportsReceived.length, 1)
})

// ─── F027 #285 receive 德彪 r1 P2-3 · 派生视图（generated_by marker）健康检查豁免 ───
//
// 德彪实证：rooms/<id>/session-summary.md（#285 双写）会被全量 scanner 报
// missingFrontmatter（缺 sources/canonical_owner_path）+ orphan —— 但它是派生视图
// 不进 canonical KB，报警 = 每夜噪声。G3 起 viewfinder 也带 generated_by，同类同豁免。
// 不能加 canonical marker（会进全局索引污染）→ 按 generated_by 过滤。

test("P2-3 · generated_by 派生视图 → missingFrontmatter + orphans 双豁免", async () => {
  // 注意：不用 entity() helper（它默认补 sources/canonical_owner_path）。
  // 派生视图真实形态 = 只有 generated_by，没有 canonical 字段（writer/RoomCompiler 实写）。
  const entities: WikiEntity[] = [
    {
      path: "wiki/rooms/R-201/session-summary.md",
      body: "## 话题",
      frontmatter: { generated_by: "memory-service" },
    },
    {
      path: "wiki/rooms/R-201/viewfinder.md",
      body: "view",
      frontmatter: { generated_by: "room-compiler" },
    },
    // 对照组：真缺字段的非派生实体仍要报
    { path: "wiki/concepts/real-gap.md", body: "body", frontmatter: {} },
  ]
  const check = new NightlyHealthCheck({ scanEntities: async () => entities })
  const report = await check.run()
  const flaggedPaths = report.missingFrontmatter.map((m) => m.path)
  assert.ok(
    !flaggedPaths.includes("wiki/rooms/R-201/session-summary.md"),
    "session-summary 是派生视图，不报缺字段",
  )
  assert.ok(!flaggedPaths.includes("wiki/rooms/R-201/viewfinder.md"))
  assert.ok(flaggedPaths.includes("wiki/concepts/real-gap.md"), "非派生实体照报（不误豁免）")
  assert.ok(!report.orphans.includes("wiki/rooms/R-201/session-summary.md"))
  assert.ok(!report.orphans.includes("wiki/rooms/R-201/viewfinder.md"))
  assert.ok(report.orphans.includes("wiki/concepts/real-gap.md"))
})
