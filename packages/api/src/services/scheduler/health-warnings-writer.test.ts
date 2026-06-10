/**
 * F027 续 · HealthWarningsWriter 测试 — warnings 文件生产链
 *
 * 背景：KB warnings tab 读 `<wikiRoot>/warnings/*.md` + merge wiki_events
 * action='warning_raised'，但两者在生产里均无 producer → 视图恒空。
 * 本 writer 挂 NightlyHealthCheck.onReport，把治理 findings 落成 warning 文件 + 事件。
 *
 * 覆盖：
 *   1. 0 findings → 不写文件、不发 events（无告警不制造噪声）
 *   2. 有 findings → `<wikiRoot>/warnings/nightly-health-<date>.md` 落盘：
 *      frontmatter(generated_by/severity/created_at) + 各类条目；events PREPARE+COMMIT
 *   3. events 抛错 → 文件仍写成功，不抛（fail-soft）
 *   4. warnings/ 目录不存在 → mkdir recursive 自动建
 *   5. 同日重跑 → 覆盖同名文件（幂等，不堆积）
 */

import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { createDrizzleDb } from "../../db/drizzle-instance"
import { WikiEventsRepository } from "../../db/repositories/wiki-events-repository"
import type { HealthCheckReport } from "./nightly-health-check"
import { createHealthWarningsWriter } from "./health-warnings-writer"

function makeRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "health-warnings-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function emptyReport(overrides: Partial<HealthCheckReport> = {}): HealthCheckReport {
  return {
    scannedAt: "2026-06-10T04:00:00Z",
    totalEntities: 10,
    deadLinks: [],
    orphans: [],
    missingFrontmatter: [],
    canonicalOwnerDrift: [],
    draftExpired: [],
    duplicateCanonical: [],
    deadSupersedes: [],
    ...overrides,
  }
}

function makeEventsStub(opts: { throwOnAppend?: boolean } = {}) {
  const appended: Array<Record<string, unknown>> = []
  const committed: number[] = []
  return {
    appended,
    committed,
    repo: {
      appendPending: (input: Record<string, unknown>) => {
        if (opts.throwOnAppend) throw new Error("events boom")
        appended.push(input)
        return { id: 42 }
      },
      commit: (eventId: number, _input: unknown) => {
        committed.push(eventId)
        return true
      },
    },
  }
}

const CLOCK = () => new Date("2026-06-10T04:05:00Z")

describe("HealthWarningsWriter", () => {
  it("0 findings → 不写文件不发 events", async () => {
    const { root, cleanup } = makeRoot()
    try {
      const events = makeEventsStub()
      const write = createHealthWarningsWriter({
        wikiRoot: root,
        events: events.repo as never,
        clock: CLOCK,
      })
      await write(emptyReport())
      assert.equal(existsSync(path.join(root, "warnings")), false)
      assert.equal(events.appended.length, 0)
    } finally {
      cleanup()
    }
  })

  it("有 findings → 文件落盘 + frontmatter + 条目 + events PREPARE/COMMIT", async () => {
    const { root, cleanup } = makeRoot()
    try {
      const events = makeEventsStub()
      const write = createHealthWarningsWriter({
        wikiRoot: root,
        events: events.repo as never,
        clock: CLOCK,
      })
      await write(
        emptyReport({
          deadLinks: [{ from: "wiki/concepts/a.md", to: "wiki/concepts/gone.md" }],
          missingFrontmatter: [{ path: "wiki/concepts/b.md", missing: ["sources"] }],
          orphans: ["wiki/concepts/lonely.md"],
        }),
      )
      const file = path.join(root, "warnings", "nightly-health-2026-06-10.md")
      assert.ok(existsSync(file), "warning 文件应落盘")
      const content = readFileSync(file, "utf-8")
      assert.ok(content.startsWith("---"), "应有 frontmatter")
      assert.ok(content.includes("generated_by: nightly-health-check"))
      assert.ok(content.includes("wiki/concepts/gone.md"), "deadLink 条目应在 body")
      assert.ok(content.includes("wiki/concepts/b.md"), "missingFrontmatter 条目应在 body")
      assert.ok(content.includes("wiki/concepts/lonely.md"), "orphan 条目应在 body")
      // events：PREPARE 带 warning_raised + 视图同款逻辑 path；立即 COMMIT
      assert.equal(events.appended.length, 1)
      assert.equal(events.appended[0]?.action, "warning_raised")
      assert.equal(events.appended[0]?.path, "wiki/warnings/nightly-health-2026-06-10.md")
      assert.deepEqual(events.committed, [42])
    } finally {
      cleanup()
    }
  })

  it("events 抛错 → 文件仍写成功不抛", async () => {
    const { root, cleanup } = makeRoot()
    try {
      const events = makeEventsStub({ throwOnAppend: true })
      const warns: string[] = []
      const write = createHealthWarningsWriter({
        wikiRoot: root,
        events: events.repo as never,
        clock: CLOCK,
        warn: (m) => warns.push(m),
      })
      await write(emptyReport({ orphans: ["wiki/concepts/x.md"] }))
      assert.ok(existsSync(path.join(root, "warnings", "nightly-health-2026-06-10.md")))
      assert.ok(warns.length > 0, "events 失败应 warn")
    } finally {
      cleanup()
    }
  })

  it("同日重跑 → 覆盖同名文件不堆积", async () => {
    const { root, cleanup } = makeRoot()
    try {
      const write = createHealthWarningsWriter({ wikiRoot: root, clock: CLOCK })
      await write(emptyReport({ orphans: ["wiki/concepts/x.md"] }))
      await write(emptyReport({ orphans: ["wiki/concepts/y.md"] }))
      const files = readdirSync(path.join(root, "warnings"))
      assert.equal(files.length, 1)
      const content = readFileSync(path.join(root, "warnings", files[0] ?? ""), "utf-8")
      assert.ok(content.includes("y.md"), "应是最新一轮内容")
      assert.ok(!content.includes("x.md"), "旧内容应被覆盖")
    } finally {
      cleanup()
    }
  })

  it("writer 自身 IO 失败 → warn 不抛（fail-soft 不挂 NHC 主链）", async () => {
    const warns: string[] = []
    // wikiRoot 指向一个**文件**而非目录 → mkdir warnings/ 必失败
    const { root, cleanup } = makeRoot()
    try {
      const fileAsRoot = path.join(root, "not-a-dir")
      writeFileSync(fileAsRoot, "x")
      const write = createHealthWarningsWriter({
        wikiRoot: fileAsRoot,
        clock: CLOCK,
        warn: (m) => warns.push(m),
      })
      await write(emptyReport({ orphans: ["wiki/concepts/x.md"] }))
      assert.ok(warns.length > 0)
    } finally {
      cleanup()
    }
  })

  it("德彪 batch2 P2-2 · 文件写失败 → warning_raised 事件仍 PREPARE+COMMIT（两路独立 fail-soft）", async () => {
    const { root, cleanup } = makeRoot()
    try {
      const fileAsRoot = path.join(root, "not-a-dir")
      writeFileSync(fileAsRoot, "x")
      const events = makeEventsStub()
      const write = createHealthWarningsWriter({
        wikiRoot: fileAsRoot,
        events: events.repo as never,
        clock: CLOCK,
        warn: () => {},
      })
      await write(emptyReport({ orphans: ["wiki/concepts/x.md"] }))
      assert.equal(events.appended.length, 1, "fs 故障不应连坐取消事件（tab 走 event 兜底）")
      assert.deepEqual(events.committed, [42])
    } finally {
      cleanup()
    }
  })

  it("德彪 batch2 P3 · events.commit 返回 false → warn 不静默", async () => {
    const { root, cleanup } = makeRoot()
    try {
      const warns: string[] = []
      const repo = {
        appendPending: () => ({ id: 7 }),
        commit: () => false,
      }
      const write = createHealthWarningsWriter({
        wikiRoot: root,
        events: repo as never,
        clock: CLOCK,
        warn: (m) => warns.push(m),
      })
      await write(emptyReport({ orphans: ["wiki/concepts/x.md"] }))
      assert.ok(
        warns.some((w) => w.includes("commit returned false")),
        "CAS false 应留 warn",
      )
    } finally {
      cleanup()
    }
  })
})

describe("HealthWarningsWriter · 真 DB + reject_stale_leader trigger（德彪 batch2 P2-3）", () => {
  function makeDb() {
    const dir = mkdtempSync(path.join(tmpdir(), "health-warnings-db-"))
    const { db, close } = createDrizzleDb(path.join(dir, "test.sqlite"))
    return {
      db,
      cleanup: () => {
        close()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  }

  function seedLeader(db: ReturnType<typeof createDrizzleDb>["db"], term: string): void {
    const client = (db as unknown as { $client: { prepare(sql: string): { run(...a: unknown[]): unknown } } })
      .$client
    client
      .prepare(
        `INSERT INTO compiler_leader (id, current_term, leader_alias, acquired_at, renewed_at, lease_expires_at)
         VALUES (1, ?, 'test-leader', '2026-06-10T00:00:00Z', '2026-06-10T00:00:00Z', '2099-01-01T00:00:00Z')`,
      )
      .run(term)
  }

  it("current_term=1000 + 注入真 term → 事件落 committed（'999' 硬编码会被 trigger 拒的场景）", async () => {
    const { root, cleanup: cleanRoot } = makeRoot()
    const { db, cleanup: cleanDb } = makeDb()
    try {
      seedLeader(db, "1000")
      const events = new WikiEventsRepository(db)
      const write = createHealthWarningsWriter({
        wikiRoot: root,
        events,
        // bootstrap 同款注入：真 leader term（这里直接喂 '1000' 模拟 leaseRepo.getCurrent()）
        leaderContext: { currentLeaderTerm: () => "1000", newFencingToken: () => "tok-1" },
        clock: CLOCK,
      })
      await write(emptyReport({ orphans: ["wiki/concepts/x.md"] }))
      const rows = events.getByAction("warning_raised", 10)
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.state, "committed")
    } finally {
      cleanRoot()
      cleanDb()
    }
  })

  it("current_term=1000 + 旧 '999' term → trigger 拒事件，warn 不抛，文件仍落盘", async () => {
    const { root, cleanup: cleanRoot } = makeRoot()
    const { db, cleanup: cleanDb } = makeDb()
    try {
      seedLeader(db, "1000")
      const events = new WikiEventsRepository(db)
      const warns: string[] = []
      const write = createHealthWarningsWriter({
        wikiRoot: root,
        events,
        leaderContext: { currentLeaderTerm: () => "999", newFencingToken: () => "tok-2" },
        clock: CLOCK,
        warn: (m) => warns.push(m),
      })
      await write(emptyReport({ orphans: ["wiki/concepts/x.md"] }))
      assert.equal(events.getByAction("warning_raised", 10).length, 0, "stale term 应被 trigger 拒")
      assert.ok(warns.length > 0, "事件失败应 warn")
      assert.ok(
        existsSync(path.join(root, "warnings", "nightly-health-2026-06-10.md")),
        "文件路不受事件失败影响",
      )
    } finally {
      cleanRoot()
      cleanDb()
    }
  })
})
