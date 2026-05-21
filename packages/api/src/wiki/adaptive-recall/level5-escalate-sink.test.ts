/**
 * F027 P13.4 · Level 5 escalate sinks 单元测试
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { createDrizzleDb } from "../../db/drizzle-instance"
import { WikiEventsRepository } from "../../db/repositories/wiki-events-repository"
import {
  type AuditBroadcaster,
  ConsoleWarnLevel5Sink,
  type LeaderContextProvider,
  NoopLevel5Sink,
  ProductionLevel5Sink,
  RecordingLevel5Sink,
  createSimpleLeaderContext,
} from "./level5-escalate-sink"
import type { EscalateInfo } from "./types"

function info(over: Partial<EscalateInfo> = {}): EscalateInfo {
  return {
    roomId: "R-201",
    alias: "桂芬",
    trigger: "history_keyword",
    query: "F011 drizzle",
    visitedLevels: [1, 2, 3],
    reason: "levels_exhausted_no_satisfaction",
    totalMs: 4200,
    critiqueCalls: 3,
    ...over,
  }
}

describe("F027 P13.4 · NoopLevel5Sink", () => {
  it("escalate resolves without effect", async () => {
    const sink = new NoopLevel5Sink()
    await sink.escalate(info())
    // 无断言，只要不抛
  })
})

describe("F027 P13.4 · ConsoleWarnLevel5Sink", () => {
  it("escalate 调注入的 log 函数 + 含 room/alias/trigger/visited", async () => {
    const logs: Array<{ msg: string; info: EscalateInfo }> = []
    const sink = new ConsoleWarnLevel5Sink((msg, info) => logs.push({ msg, info }))
    await sink.escalate(info())
    assert.equal(logs.length, 1)
    assert.match(logs[0].msg, /R-201/)
    assert.match(logs[0].msg, /桂芬/)
    assert.match(logs[0].msg, /history_keyword/)
    assert.match(logs[0].msg, /\[1,2,3\]/)
    assert.match(logs[0].msg, /levels_exhausted_no_satisfaction/)
  })
})

describe("F027 P13.4 · RecordingLevel5Sink", () => {
  it("记录每次 escalate 完整 info 到 calls[]", async () => {
    const sink = new RecordingLevel5Sink()
    await sink.escalate(info({ roomId: "R-201", reason: "first" }))
    await sink.escalate(info({ roomId: "R-202", reason: "second" }))
    assert.equal(sink.calls.length, 2)
    assert.equal(sink.calls[0].roomId, "R-201")
    assert.equal(sink.calls[0].reason, "first")
    assert.equal(sink.calls[1].roomId, "R-202")
    assert.equal(sink.calls[1].reason, "second")
  })
})

// ─── F027 Phase 3 P20 Day 9 c (AC-P3-9 c) — ProductionLevel5Sink ─────

function safeTempDir(prefix: string): string {
  const base = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(base, { recursive: true })
  return fs.mkdtempSync(path.join(base, prefix))
}

function safeCleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // best effort
  }
}

function makeRepo() {
  const tmp = safeTempDir("F027-Day9c-l5sink-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  const repo = new WikiEventsRepository(db)
  return { db, repo, close, tmp }
}

function makeLeader(): LeaderContextProvider {
  let n = 0
  return {
    currentLeaderTerm: () => "1",
    newFencingToken: () => `fence-test-${++n}`,
  }
}

describe("F027 P20 Day 9 c · ProductionLevel5Sink · wiki_events 写入", () => {
  it("escalate → wiki_events 一行 action=recall_escalate state=committed", async () => {
    const { repo, close, tmp } = makeRepo()
    try {
      const fixed = new Date("2026-05-21T10:00:00.000Z")
      const sink = new ProductionLevel5Sink({
        wikiEventsRepo: repo,
        leaderContext: makeLeader(),
        clock: () => fixed,
      })
      await sink.escalate(
        info({
          roomId: "R-301",
          alias: "桂芬",
          reason: "budget_exceeded_at_l3",
          trigger: "wake_up_history",
          visitedLevels: [1, 2, 3],
          totalMs: 5050,
          critiqueCalls: 2,
        }),
      )
      const rows = repo.getByAlias("桂芬", 10)
      assert.equal(rows.length, 1)
      const row = rows[0]
      assert.equal(row.action, "recall_escalate")
      assert.equal(row.state, "committed")
      assert.equal(row.alias, "桂芬")
      assert.equal(row.path, "audit/recall/R-301/2026-05-21T10:00:00.000Z")
      assert.equal(row.reason, "budget_exceeded_at_l3")
      assert.equal(row.fencingToken, "fence-test-1")
      assert.equal(row.leaderTerm, "1")
      // attemptedHash === contentHash（recall_escalate 不写文件，commit 同 hash）
      assert.equal(row.attemptedHash, row.contentHash)
      assert.ok(row.attemptedHash, "attemptedHash 非空（sha256(reason)）")
      assert.ok(row.diffSummary?.includes("wake_up_history"))
      assert.ok(row.diffSummary?.includes("visited=[1,2,3]"))
      assert.equal(row.result, "ok")
    } finally {
      close()
      safeCleanup(tmp)
    }
  })

  it("escalate + broadcaster → broadcast 一次推 recall.escalated", async () => {
    const { repo, close, tmp } = makeRepo()
    try {
      const events: Array<Parameters<AuditBroadcaster["broadcast"]>[0]> = []
      const broadcaster: AuditBroadcaster = {
        broadcast: (e) => {
          events.push(e)
        },
      }
      const sink = new ProductionLevel5Sink({
        wikiEventsRepo: repo,
        leaderContext: makeLeader(),
        broadcaster,
      })
      await sink.escalate(
        info({
          roomId: "R-302",
          alias: "范德彪",
          trigger: "a2a_call",
          visitedLevels: [1, 2],
          totalMs: 1234,
          critiqueCalls: 1,
          reason: "no_critique_satisfied",
        }),
      )
      assert.equal(events.length, 1)
      const ev = events[0]
      assert.equal(ev.type, "recall.escalated")
      assert.equal(ev.payload.roomId, "R-302")
      assert.equal(ev.payload.alias, "范德彪")
      assert.equal(ev.payload.trigger, "a2a_call")
      assert.deepEqual(ev.payload.visitedLevels, [1, 2])
      assert.equal(ev.payload.reason, "no_critique_satisfied")
      assert.equal(ev.payload.totalMs, 1234)
      assert.equal(ev.payload.critiqueCalls, 1)
      assert.ok(ev.payload.wikiEventId > 0, "broadcaster payload 含 wikiEventId")
      assert.ok(ev.payload.eventPath.startsWith("audit/recall/R-302/"))
      assert.ok(ev.payload.ts)
    } finally {
      close()
      safeCleanup(tmp)
    }
  })

  it("escalate 不传 broadcaster → 仅写 DB 不抛", async () => {
    const { repo, close, tmp } = makeRepo()
    try {
      const sink = new ProductionLevel5Sink({
        wikiEventsRepo: repo,
        leaderContext: makeLeader(),
      })
      await sink.escalate(info())
      const rows = repo.getByAlias("桂芬", 10)
      assert.equal(rows.length, 1)
    } finally {
      close()
      safeCleanup(tmp)
    }
  })

  it("wiki_events 写失败 → log warn 不抛（fail-soft）", async () => {
    const failingRepo = {
      appendPending: () => {
        throw new Error("simulated DB write failure")
      },
      commit: () => true,
    } as unknown as WikiEventsRepository

    const warns: Array<{ obj: unknown; msg?: string }> = []
    const sink = new ProductionLevel5Sink({
      wikiEventsRepo: failingRepo,
      leaderContext: makeLeader(),
      logger: { warn: (obj, msg) => warns.push({ obj, msg }) },
    })
    // 不抛
    await sink.escalate(info())
    assert.equal(warns.length, 1)
    assert.match(String(warns[0].msg), /wiki_events write failed/)
  })

  it("broadcaster 抛 → log warn 不抛（DB 已落 row）", async () => {
    const { repo, close, tmp } = makeRepo()
    try {
      const broadcaster: AuditBroadcaster = {
        broadcast: () => {
          throw new Error("simulated broadcaster failure")
        },
      }
      const warns: Array<{ obj: unknown; msg?: string }> = []
      const sink = new ProductionLevel5Sink({
        wikiEventsRepo: repo,
        leaderContext: makeLeader(),
        broadcaster,
        logger: { warn: (obj, msg) => warns.push({ obj, msg }) },
      })
      await sink.escalate(info())
      // DB 行落了
      const rows = repo.getByAlias("桂芬", 10)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].state, "committed", "broadcaster fail 不影响 commit")
      // broadcaster fail warn 了
      assert.equal(warns.length, 1)
      assert.match(String(warns[0].msg), /broadcaster failed/)
    } finally {
      close()
      safeCleanup(tmp)
    }
  })

  it("createSimpleLeaderContext · 默认 term=1 + fencing token 非空且唯一", () => {
    const ctx = createSimpleLeaderContext()
    assert.equal(ctx.currentLeaderTerm(), "1")
    const a = ctx.newFencingToken()
    const b = ctx.newFencingToken()
    assert.ok(a)
    assert.ok(b)
    assert.notEqual(a, b)
  })

  it("createSimpleLeaderContext · 自定义 leaderTerm + newFencingToken", () => {
    const ctx = createSimpleLeaderContext({
      leaderTerm: "42",
      newFencingToken: () => "fixed-fence",
    })
    assert.equal(ctx.currentLeaderTerm(), "42")
    assert.equal(ctx.newFencingToken(), "fixed-fence")
  })
})
