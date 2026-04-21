import { describe, it, mock } from "node:test"
import assert from "node:assert/strict"
import { backfillHistoricalTitles } from "./title-backfill"

function makeLogger() {
  const calls: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = []
  const self: any = {
    info: (obj: Record<string, unknown>, msg: string) => calls.push({ level: "info", obj, msg }),
    warn: (obj: Record<string, unknown>, msg: string) => calls.push({ level: "warn", obj, msg }),
    error: (obj: Record<string, unknown>, msg: string) => calls.push({ level: "error", obj, msg }),
    fatal: () => {},
    debug: () => {},
    trace: () => {},
    child: () => self,
  }
  return { logger: self, calls }
}

describe("backfillHistoricalTitles (AC-14b)", () => {
  it("only feeds sessions whose title is null/empty/default-pattern to runNow", async () => {
    const repo = {
      listSessionGroups: () => [
        { id: "a", title: null },
        { id: "b", title: "" },
        { id: "c", title: "新会话 2026-04-20" },
        { id: "d", title: "2026-04-18 · 未命名" },
        { id: "e", title: "学习 TDD" }, // real title — skip
      ],
    }
    const runNowSpy = mock.fn(async (_id: string) => {})
    const titler = { runNow: runNowSpy }
    const { logger } = makeLogger()
    const result = await backfillHistoricalTitles(repo, titler, {
      logger,
      delayMs: 0,
      sleep: async () => {},
    })
    assert.equal(result.scanned, 5)
    assert.equal(result.attempted, 4)
    const calledIds = runNowSpy.mock.calls.map((c) => c.arguments[0])
    assert.deepEqual(calledIds, ["a", "b", "c", "d"])
  })

  it("runs sessions serially with configured delay between each", async () => {
    const order: string[] = []
    const runNowSpy = mock.fn(async (id: string) => {
      order.push(`run:${id}`)
    })
    const sleepSpy = mock.fn(async (ms: number) => {
      order.push(`sleep:${ms}`)
    })
    const repo = {
      listSessionGroups: () => [
        { id: "a", title: null },
        { id: "b", title: null },
        { id: "c", title: null },
      ],
    }
    await backfillHistoricalTitles(repo, { runNow: runNowSpy }, {
      delayMs: 500,
      sleep: sleepSpy,
    })
    assert.deepEqual(order, ["run:a", "sleep:500", "run:b", "sleep:500", "run:c"])
  })

  it("continues past per-row errors and reports them", async () => {
    const { logger, calls } = makeLogger()
    let n = 0
    const runNowSpy = mock.fn(async (_id: string) => {
      n++
      if (n === 2) throw new Error("boom")
    })
    const repo = {
      listSessionGroups: () => [
        { id: "a", title: null },
        { id: "b", title: null },
        { id: "c", title: null },
      ],
    }
    const result = await backfillHistoricalTitles(repo, { runNow: runNowSpy }, {
      logger,
      delayMs: 0,
      sleep: async () => {},
    })
    assert.equal(runNowSpy.mock.calls.length, 3)
    assert.equal(result.attempted, 3)
    const errs = calls.filter((c) => c.obj.event === "backfill.error")
    assert.equal(errs.length, 1)
    assert.equal(errs[0].obj.sessionGroupId, "b")
  })

  it("no-op when there are zero pending sessions", async () => {
    const runNowSpy = mock.fn(async (_id: string) => {})
    const repo = { listSessionGroups: () => [{ id: "a", title: "已命名" }] }
    const result = await backfillHistoricalTitles(repo, { runNow: runNowSpy })
    assert.equal(result.scanned, 1)
    assert.equal(result.attempted, 0)
    assert.equal(runNowSpy.mock.calls.length, 0)
  })
})
