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
  assert.equal(report.deadLinks[0].to, "wiki/concepts/missing.md")
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

test("NightlyHealthCheck · orphans 豁免 draft 路径（draft 默认未发布）", async () => {
  const check = newCheck({
    entities: [
      entity("wiki/concepts/draft/auto-1.md", "# auto draft 1\n"),
      entity("wiki/concepts/finalized.md", "# fin\n"),
    ],
  })
  const report = await check.run()
  // draft/ 路径不算 orphan（豁免）
  assert.ok(!report.orphans.includes("wiki/concepts/draft/auto-1.md"))
  // finalized 无 inbound 算 orphan
  assert.ok(report.orphans.includes("wiki/concepts/finalized.md"))
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
