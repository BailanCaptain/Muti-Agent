/**
 * F027 P19.13 · ArchiveYearlySessions 测试 — AC-P2-15
 *
 * 覆盖：
 *   - 往年 session → yearly pack + mv archive；当年 active 不动
 *   - archivePathFor: wiki/archive/agent-sessions/<room>/<alias>/<year>/<base>
 *   - buildYearlyPack: metadata + digest 保留 + room/alias 排序
 *   - Jan-1 边界（mock clock）：2027-01-01 跑 → 归档 2026 及更早
 *   - 多年混合 → 按年分别 pack
 *   - archiveSessionFile throw → 落 failed 不打断
 *   - dry-run（无 writer/mover）→ 仍记录
 *   - **AC-P2-15 100k session fixture** — 跑完不 OOM + 线性
 */

import assert from "node:assert/strict"
import test from "node:test"
import {
  ArchiveYearlySessions,
  type SessionEntry,
  archivePathFor,
  buildYearlyPack,
} from "./archive-yearly-sessions"

function session(over: Partial<SessionEntry> = {}): SessionEntry {
  return {
    path: "wiki/agent-sessions/R-1/黄/S-0001.md",
    roomId: "R-1",
    alias: "黄",
    year: 2026,
    digest: "digest content",
    ...over,
  }
}

// ── archivePathFor / buildYearlyPack ────────────────────────────────────

test("ArchiveYearlySessions · archivePathFor 路径正确", () => {
  const dst = archivePathFor(
    session({ path: "wiki/agent-sessions/R-201/范/S-0042.md", roomId: "R-201", alias: "范", year: 2025 }),
  )
  assert.equal(dst, "wiki/archive/agent-sessions/R-201/范/2025/S-0042.md")
})

test("ArchiveYearlySessions · buildYearlyPack 含 metadata + digest", () => {
  const pack = buildYearlyPack(2026, [
    session({ path: "S-1.md", roomId: "R-1", alias: "黄", digest: "session 1 digest" }),
    session({ path: "S-2.md", roomId: "R-1", alias: "范", digest: "session 2 digest" }),
  ])
  assert.match(pack, /Yearly Pack — 2026/)
  assert.match(pack, /Total sessions: 2/)
  assert.match(pack, /session 1 digest/)
  assert.match(pack, /session 2 digest/)
})

// ── 往年归档 + 当年不动 ─────────────────────────────────────────────────

test("ArchiveYearlySessions · AC-P2-15: 往年 session 归档，当年 active 不动", async () => {
  const sessions: SessionEntry[] = [
    session({ path: "S-old-1.md", year: 2025 }),
    session({ path: "S-old-2.md", year: 2026 }),
    session({ path: "S-current.md", year: 2027 }), // 当年 — 不动
  ]
  const packsWritten: Array<{ year: number; content: string }> = []
  const moved: Array<{ src: string; dst: string }> = []
  const archiver = new ArchiveYearlySessions({
    scanSessions: async () => sessions,
    clock: () => new Date("2027-06-01T03:00:00.000Z"), // currentYear=2027
    writeYearlyPack: async (year, content) => {
      packsWritten.push({ year, content })
      return `wiki/agent-sessions/packs/${year}.md`
    },
    archiveSessionFile: async (src, dst) => {
      moved.push({ src, dst })
    },
  })
  const result = await archiver.run()

  assert.equal(result.currentYear, 2027)
  assert.equal(result.totalSessionsScanned, 3)
  assert.equal(result.sessionsArchived, 2, "2025 + 2026 归档；2027 当年不动")
  assert.equal(result.packs.length, 2, "2 年各一 pack")
  assert.equal(moved.length, 2)
  // 当年 session 不在归档列表
  assert.ok(!moved.some((m) => m.src === "S-current.md"))
})

// ── Jan-1 边界 ───────────────────────────────────────────────────────────

test("ArchiveYearlySessions · AC-P2-15 Jan-1 边界: 2027-01-01 CST 跑 → 归档 2026 及更早", async () => {
  const sessions: SessionEntry[] = [
    session({ path: "S-2025.md", year: 2025 }),
    session({ path: "S-2026.md", year: 2026 }),
    session({ path: "S-2027.md", year: 2027 }),
  ]
  const archiver = new ArchiveYearlySessions({
    scanSessions: async () => sessions,
    // 2027-01-01 03:00 CST = 2026-12-31 19:00 UTC
    clock: () => new Date("2026-12-31T19:00:00.000Z"),
  })
  const result = await archiver.run()
  assert.equal(result.currentYear, 2027, "CST 年份应是 2027")
  assert.equal(result.sessionsArchived, 2, "归档 2025 + 2026")
})

test("ArchiveYearlySessions · 多年混合 → 按年分别 pack", async () => {
  const sessions: SessionEntry[] = [
    session({ path: "S-a.md", year: 2024 }),
    session({ path: "S-b.md", year: 2024 }),
    session({ path: "S-c.md", year: 2025 }),
    session({ path: "S-d.md", year: 2026 }),
  ]
  const archiver = new ArchiveYearlySessions({
    scanSessions: async () => sessions,
    clock: () => new Date("2027-03-01T03:00:00.000Z"),
  })
  const result = await archiver.run()
  assert.equal(result.packs.length, 3, "2024/2025/2026 三个 pack")
  const byYear = new Map(result.packs.map((p) => [p.year, p.sessionCount]))
  assert.equal(byYear.get(2024), 2)
  assert.equal(byYear.get(2025), 1)
  assert.equal(byYear.get(2026), 1)
})

// ── 错误处理 ─────────────────────────────────────────────────────────────

test("ArchiveYearlySessions · archiveSessionFile throw → 落 failed 不打断", async () => {
  const sessions: SessionEntry[] = [
    session({ path: "S-ok.md", year: 2026 }),
    session({ path: "S-fail.md", year: 2026 }),
  ]
  const archiver = new ArchiveYearlySessions({
    scanSessions: async () => sessions,
    clock: () => new Date("2027-06-01T03:00:00.000Z"),
    archiveSessionFile: async (src) => {
      if (src === "S-fail.md") throw new Error("EPERM")
    },
  })
  const result = await archiver.run()
  assert.equal(result.archivedFiles.length, 1, "S-ok 成功")
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].src, "S-fail.md")
  assert.match(result.failed[0].error, /EPERM/)
})

test("ArchiveYearlySessions · dry-run（无 writer/mover）→ 仍记录归档目标", async () => {
  const archiver = new ArchiveYearlySessions({
    scanSessions: async () => [session({ path: "S-1.md", year: 2026 })],
    clock: () => new Date("2027-06-01T03:00:00.000Z"),
  })
  const result = await archiver.run()
  assert.equal(result.sessionsArchived, 1)
  assert.equal(result.packs[0].packPath, null, "无 writer → packPath null")
  assert.equal(result.archivedFiles.length, 1, "dry-run 仍记录归档目标")
})

test("ArchiveYearlySessions · 空 session → 空 result", async () => {
  const archiver = new ArchiveYearlySessions({
    scanSessions: async () => [],
    clock: () => new Date("2027-06-01T03:00:00.000Z"),
  })
  const result = await archiver.run()
  assert.equal(result.sessionsArchived, 0)
  assert.equal(result.packs.length, 0)
})

// ── 100k pressure ───────────────────────────────────────────────────────

test("ArchiveYearlySessions · AC-P2-15: 100k session fixture — 跑完不 OOM + 线性", async () => {
  const N = 100_000
  const archiver = new ArchiveYearlySessions({
    scanSessions: async () => {
      const out: SessionEntry[] = []
      for (let i = 0; i < N; i++) {
        out.push(
          session({
            path: `wiki/agent-sessions/R-${i % 100}/agent/S-${i}.md`,
            roomId: `R-${i % 100}`,
            alias: "agent",
            year: 2026, // 全往年
            digest: `digest ${i}`,
          }),
        )
      }
      return out
    },
    clock: () => new Date("2027-06-01T03:00:00.000Z"),
    writeYearlyPack: async (year) => `packs/${year}.md`,
    archiveSessionFile: async () => {},
  })
  const start = Date.now()
  const result = await archiver.run()
  const elapsedMs = Date.now() - start

  assert.equal(result.sessionsArchived, N)
  assert.equal(result.packs.length, 1, "全 2026 → 1 个 pack")
  assert.equal(result.packs[0].sessionCount, N)
  assert.ok(elapsedMs < 30_000, `100k session 应线性时间完成, 实际 ${elapsedMs}ms`)
})
