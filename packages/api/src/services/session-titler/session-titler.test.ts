import { describe, it, mock } from "node:test"
import assert from "node:assert/strict"
import { SessionTitler } from "./session-titler"
import type { HaikuRunner, HaikuRunResult } from "../../runtime/haiku-runner"

type LogCall = { level: "info" | "warn" | "error"; obj: Record<string, unknown>; msg: string }

function makeLogger() {
  const calls: LogCall[] = []
  const self: any = {
    info: (obj: Record<string, unknown>, msg: string) => calls.push({ level: "info", obj, msg }),
    warn: (obj: Record<string, unknown>, msg: string) => calls.push({ level: "warn", obj, msg }),
    error: (obj: Record<string, unknown>, msg: string) => calls.push({ level: "error", obj, msg }),
    fatal: (obj: Record<string, unknown>, msg: string) => calls.push({ level: "error", obj, msg }),
    debug: () => {},
    trace: () => {},
    child: () => self,
  }
  return { logger: self, calls, byEvent: (event: string) => calls.filter((c) => c.obj.event === event) }
}

function makeRepo(initial: { id: string; title: string; roomId: string | null }) {
  let current = { ...initial }
  let attempts = 0
  const updateSpy = mock.fn((id: string, title: string) => {
    if (id === current.id) current = { ...current, title }
  })
  const incSpy = mock.fn((_id: string) => {
    attempts += 1
  })
  const resetSpy = mock.fn((_id: string) => {
    attempts = 0
  })
  return {
    repo: {
      getSessionGroupById: (id: string) =>
        id === current.id
          ? {
              id: current.id,
              roomId: current.roomId,
              title: current.title,
              projectTag: null,
              createdAt: "2026-04-20T00:00:00.000Z",
              updatedAt: "2026-04-20T00:00:00.000Z",
            }
          : undefined,
      updateSessionGroupTitle: updateSpy,
      incrementTitleBackfillAttempts: incSpy,
      resetTitleBackfillAttempts: resetSpy,
    },
    updateSpy,
    incSpy,
    resetSpy,
    peekTitle: () => current.title,
    peekAttempts: () => attempts,
  }
}

function makeHaiku(result: Partial<HaikuRunResult> & Pick<HaikuRunResult, "ok">): {
  haiku: HaikuRunner
  runSpy: ReturnType<typeof mock.fn>
} {
  const runSpy = mock.fn(async (_prompt: string): Promise<HaikuRunResult> => ({
    ok: result.ok,
    text: result.text ?? "",
    durationMs: result.durationMs ?? 42,
    error: result.error,
  }))
  return { haiku: { runPrompt: runSpy as any }, runSpy }
}

const SID = "session-group-1"
const ROOM = "R-001"

describe("SessionTitler", () => {
  it("AC-05: debounces multiple schedule() calls into a single haiku call", async () => {
    const { repo } = makeRepo({ id: SID, title: "新会话 2026-04-20", roomId: ROOM })
    const { haiku, runSpy } = makeHaiku({ ok: true, text: "学习 TDD" })
    const { logger } = makeLogger()
    const titler = new SessionTitler({
      repo,
      haiku,
      logger,
      debounceMs: 30,
      buildPrompt: () => "p",
      dateFormatter: () => "2026-04-20",
    })
    titler.schedule(SID)
    titler.schedule(SID)
    titler.schedule(SID)
    await titler.flushPending()
    assert.equal(runSpy.mock.calls.length, 1, "haiku should be called once")
  })

  it("AC-07: writes Haiku prefix-formatted result to session_groups.title on success and logs event=success", async () => {
    const { repo, updateSpy } = makeRepo({ id: SID, title: "新会话 2026-04-20 14:30:00", roomId: ROOM })
    const { haiku } = makeHaiku({ ok: true, text: "D-学习 TDD" })
    const { logger, byEvent } = makeLogger()
    const titler = new SessionTitler({
      repo,
      haiku,
      logger,
      debounceMs: 10,
      buildPrompt: () => "p",
      dateFormatter: () => "2026-04-20",
    })
    titler.schedule(SID)
    await titler.flushPending()
    assert.equal(updateSpy.mock.calls.length, 1)
    assert.deepEqual(updateSpy.mock.calls[0].arguments, [SID, "D-学习 TDD"])
    const ok = byEvent("success")
    assert.equal(ok.length, 1)
    assert.equal(ok[0].obj.sessionGroupId, SID)
    assert.equal(ok[0].obj.roomId, ROOM)
    assert.equal(ok[0].obj.titleGenerated, "D-学习 TDD")
    assert.equal(typeof ok[0].obj.durationMs, "number")
  })

  it("AC-06: truncates description part of Haiku output to 8 chars (prefix preserved)", async () => {
    const { repo, updateSpy } = makeRepo({ id: SID, title: "新会话 2026-04-20", roomId: ROOM })
    const { haiku } = makeHaiku({ ok: true, text: "D-这是会被截断的超长描述" })
    const { logger } = makeLogger()
    const titler = new SessionTitler({
      repo,
      haiku,
      logger,
      debounceMs: 10,
      buildPrompt: () => "p",
      dateFormatter: () => "2026-04-20",
    })
    titler.schedule(SID)
    await titler.flushPending()
    assert.equal(updateSpy.mock.calls.length, 1)
    assert.equal(updateSpy.mock.calls[0].arguments[1], "D-这是会被截断的超")
  })

  it("AC-14d: preserves D/Q bare prefix returned by Haiku", async () => {
    for (const prefix of ["D", "Q"]) {
      const { repo, updateSpy } = makeRepo({ id: SID, title: "新会话 2026-04-20", roomId: ROOM })
      const { haiku } = makeHaiku({ ok: true, text: `${prefix}-测试` })
      const { logger } = makeLogger()
      const titler = new SessionTitler({
        repo,
        haiku,
        logger,
        debounceMs: 10,
        buildPrompt: () => "p",
        dateFormatter: () => "2026-04-20",
      })
      titler.schedule(SID)
      await titler.flushPending()
      assert.equal(updateSpy.mock.calls[0].arguments[1], `${prefix}-测试`, `prefix ${prefix} should be preserved`)
    }
  })

  it("AC-14d: normalizes lowercase D-/Q- to uppercase", async () => {
    const { repo, updateSpy } = makeRepo({ id: SID, title: "新会话 2026-04-20", roomId: ROOM })
    const { haiku } = makeHaiku({ ok: true, text: "d-讨论架构" })
    const { logger } = makeLogger()
    const titler = new SessionTitler({
      repo,
      haiku,
      logger,
      debounceMs: 10,
      buildPrompt: () => "p",
      dateFormatter: () => "2026-04-20",
    })
    titler.schedule(SID)
    await titler.flushPending()
    assert.equal(updateSpy.mock.calls[0].arguments[1], "D-讨论架构")
  })

  it("AC-14e: preserves filed F\\d+- / B\\d+- ids from Haiku output", async () => {
    const cases: Array<[string, string]> = [
      ["F022-侧栏重塑", "F022-侧栏重塑"],
      ["B026-修登录", "B026-修登录"],
      ["F001-a", "F001-a"],
      ["B9-x", "B9-x"],
    ]
    for (const [input, expected] of cases) {
      const { repo, updateSpy } = makeRepo({ id: SID, title: "新会话 2026-04-20", roomId: ROOM })
      const { haiku } = makeHaiku({ ok: true, text: input })
      const { logger } = makeLogger()
      const titler = new SessionTitler({
        repo,
        haiku,
        logger,
        debounceMs: 10,
        buildPrompt: () => "p",
        dateFormatter: () => "2026-04-20",
      })
      titler.schedule(SID)
      await titler.flushPending()
      assert.equal(updateSpy.mock.calls[0].arguments[1], expected, `input=${input}`)
    }
  })

  it("AC-14e: normalizes lowercase filed prefix (f022-/b026-) to uppercase letter", async () => {
    const { repo, updateSpy } = makeRepo({ id: SID, title: "新会话 2026-04-20", roomId: ROOM })
    const { haiku } = makeHaiku({ ok: true, text: "f022-侧栏重塑" })
    const { logger } = makeLogger()
    const titler = new SessionTitler({
      repo,
      haiku,
      logger,
      debounceMs: 10,
      buildPrompt: () => "p",
      dateFormatter: () => "2026-04-20",
    })
    titler.schedule(SID)
    await titler.flushPending()
    assert.equal(updateSpy.mock.calls[0].arguments[1], "F022-侧栏重塑")
  })

  it("AC-14e: demotes bare F-/B- (no id) to D- — unfiled does not earn F/B prefix", async () => {
    const cases: Array<[string, string]> = [
      ["F-登录页", "D-登录页"],
      ["B-bug修复", "D-bug修复"],
      ["f-登录页", "D-登录页"],
      ["b-xxx", "D-xxx"],
    ]
    for (const [input, expected] of cases) {
      const { repo, updateSpy } = makeRepo({ id: SID, title: "新会话 2026-04-20", roomId: ROOM })
      const { haiku } = makeHaiku({ ok: true, text: input })
      const { logger } = makeLogger()
      const titler = new SessionTitler({
        repo,
        haiku,
        logger,
        debounceMs: 10,
        buildPrompt: () => "p",
        dateFormatter: () => "2026-04-20",
      })
      titler.schedule(SID)
      await titler.flushPending()
      assert.equal(updateSpy.mock.calls[0].arguments[1], expected, `input=${input}`)
    }
  })

  it("AC-14e: truncates long filed title description to 8 chars, keeping id intact", async () => {
    const { repo, updateSpy } = makeRepo({ id: SID, title: "新会话 2026-04-20", roomId: ROOM })
    const { haiku } = makeHaiku({ ok: true, text: "F022-这是一个超长的描述文本" })
    const { logger } = makeLogger()
    const titler = new SessionTitler({
      repo,
      haiku,
      logger,
      debounceMs: 10,
      buildPrompt: () => "p",
      dateFormatter: () => "2026-04-20",
    })
    titler.schedule(SID)
    await titler.flushPending()
    assert.equal(updateSpy.mock.calls[0].arguments[1], "F022-这是一个超长的描")
  })

  it("AC-14d: prepends D- when Haiku output has no valid prefix (plain text)", async () => {
    const { repo, updateSpy } = makeRepo({ id: SID, title: "新会话 2026-04-20", roomId: ROOM })
    const { haiku } = makeHaiku({ ok: true, text: "学习 TDD" })
    const { logger } = makeLogger()
    const titler = new SessionTitler({
      repo,
      haiku,
      logger,
      debounceMs: 10,
      buildPrompt: () => "p",
      dateFormatter: () => "2026-04-20",
    })
    titler.schedule(SID)
    await titler.flushPending()
    assert.equal(updateSpy.mock.calls[0].arguments[1], "D-学习 TDD")
  })

  it("AC-14d: prepends D- when Haiku returns an invalid prefix letter (e.g. X-)", async () => {
    const { repo, updateSpy } = makeRepo({ id: SID, title: "新会话 2026-04-20", roomId: ROOM })
    const { haiku } = makeHaiku({ ok: true, text: "X-乱" })
    const { logger } = makeLogger()
    const titler = new SessionTitler({
      repo,
      haiku,
      logger,
      debounceMs: 10,
      buildPrompt: () => "p",
      dateFormatter: () => "2026-04-20",
    })
    titler.schedule(SID)
    await titler.flushPending()
    assert.equal(updateSpy.mock.calls[0].arguments[1], "D-X-乱")
  })

  it("AC-08: falls back to 'D-新会话 YYYY-MM-DD' on Haiku failure and logs event=fallback", async () => {
    const { repo, updateSpy } = makeRepo({ id: SID, title: "新会话 2026-04-20 14:30:00", roomId: ROOM })
    const { haiku, runSpy } = makeHaiku({ ok: false, error: "timeout", durationMs: 5000 })
    const { logger, byEvent } = makeLogger()
    const titler = new SessionTitler({
      repo,
      haiku,
      logger,
      debounceMs: 10,
      buildPrompt: () => "p",
      dateFormatter: () => "2026-04-20",
    })
    titler.schedule(SID)
    await titler.flushPending()
    assert.equal(runSpy.mock.calls.length, 1)
    assert.deepEqual(updateSpy.mock.calls[0].arguments, [SID, "D-新会话 2026-04-20"])
    const fb = byEvent("fallback")
    assert.equal(fb.length, 1)
    assert.equal(fb[0].level, "warn")
    assert.equal(fb[0].obj.error, "timeout")
    assert.equal(fb[0].obj.titleGenerated, "D-新会话 2026-04-20")
  })

  it("AC-10: skips when current title is NOT a default pattern (user-edited)", async () => {
    const { repo, updateSpy } = makeRepo({ id: SID, title: "用户改过的标题", roomId: ROOM })
    const { haiku, runSpy } = makeHaiku({ ok: true, text: "irrelevant" })
    const { logger, byEvent } = makeLogger()
    const titler = new SessionTitler({
      repo,
      haiku,
      logger,
      debounceMs: 10,
      buildPrompt: () => "p",
      dateFormatter: () => "2026-04-20",
    })
    titler.schedule(SID)
    await titler.flushPending()
    assert.equal(runSpy.mock.calls.length, 0, "haiku should NOT be called")
    assert.equal(updateSpy.mock.calls.length, 0, "title should NOT be updated")
    const skip = byEvent("skip.idempotent")
    assert.equal(skip.length, 1)
    assert.equal(skip[0].obj.currentTitle, "用户改过的标题")
  })

  it("AC-10: also skips when session already has a Haiku-generated title", async () => {
    const { repo, updateSpy } = makeRepo({ id: SID, title: "学习 Drizzle", roomId: ROOM })
    const { haiku, runSpy } = makeHaiku({ ok: true, text: "new title" })
    const { logger } = makeLogger()
    const titler = new SessionTitler({
      repo,
      haiku,
      logger,
      debounceMs: 10,
      buildPrompt: () => "p",
      dateFormatter: () => "2026-04-20",
    })
    titler.schedule(SID)
    await titler.flushPending()
    assert.equal(runSpy.mock.calls.length, 0)
    assert.equal(updateSpy.mock.calls.length, 0)
  })

  it("AC-09: schedule() returns synchronously without awaiting haiku", () => {
    const { repo } = makeRepo({ id: SID, title: "新会话 2026-04-20", roomId: ROOM })
    const { haiku } = makeHaiku({ ok: true, text: "ok" })
    const { logger } = makeLogger()
    const titler = new SessionTitler({
      repo,
      haiku,
      logger,
      debounceMs: 9_999_999, // never fires during this synchronous test
      buildPrompt: () => "p",
      dateFormatter: () => "2026-04-20",
    })
    const ret = titler.schedule(SID)
    assert.equal(ret, undefined)
  })

  it("logs event=schedule on every schedule() call (even when debounced)", () => {
    const { repo } = makeRepo({ id: SID, title: "新会话 2026-04-20", roomId: ROOM })
    const { haiku } = makeHaiku({ ok: true, text: "ok" })
    const { logger, byEvent } = makeLogger()
    const titler = new SessionTitler({
      repo,
      haiku,
      logger,
      debounceMs: 9_999_999,
      buildPrompt: () => "p",
      dateFormatter: () => "2026-04-20",
    })
    titler.schedule(SID)
    titler.schedule(SID)
    const events = byEvent("schedule")
    assert.equal(events.length, 2)
    for (const e of events) assert.equal(e.obj.sessionGroupId, SID)
  })

  it("logs event=haiku.call right before invoking runner", async () => {
    const { repo } = makeRepo({ id: SID, title: "新会话 2026-04-20", roomId: ROOM })
    const { haiku } = makeHaiku({ ok: true, text: "x" })
    const { logger, byEvent } = makeLogger()
    const titler = new SessionTitler({
      repo,
      haiku,
      logger,
      debounceMs: 10,
      buildPrompt: () => "p",
      dateFormatter: () => "2026-04-20",
    })
    titler.schedule(SID)
    await titler.flushPending()
    const call = byEvent("haiku.call")
    assert.equal(call.length, 1)
    assert.equal(call[0].obj.sessionGroupId, SID)
    assert.equal(call[0].obj.roomId, ROOM)
  })

  it("is a no-op when sessionGroupId does not exist", async () => {
    const { repo, updateSpy } = makeRepo({ id: SID, title: "新会话 2026-04-20", roomId: ROOM })
    const { haiku, runSpy } = makeHaiku({ ok: true, text: "x" })
    const { logger } = makeLogger()
    const titler = new SessionTitler({
      repo,
      haiku,
      logger,
      debounceMs: 10,
      buildPrompt: () => "p",
      dateFormatter: () => "2026-04-20",
    })
    titler.schedule("no-such-sid")
    await titler.flushPending()
    assert.equal(runSpy.mock.calls.length, 0)
    assert.equal(updateSpy.mock.calls.length, 0)
  })

  // F022 Phase 3.5 (review P1-2)
  it("review P1-2: Haiku 成功时重置 title_backfill_attempts", async () => {
    const { repo, resetSpy, incSpy } = makeRepo({
      id: SID,
      title: "新会话 2026-04-20",
      roomId: ROOM,
    })
    const { haiku } = makeHaiku({ ok: true, text: "D-讨论 TDD" })
    const { logger } = makeLogger()
    const titler = new SessionTitler({
      repo,
      haiku,
      logger,
      debounceMs: 5,
      buildPrompt: () => "p",
      dateFormatter: () => "2026-04-20",
    })
    titler.schedule(SID)
    await titler.flushPending()
    assert.equal(resetSpy.mock.calls.length, 1, "success 分支必须 reset 计数")
    assert.equal(resetSpy.mock.calls[0].arguments[0], SID)
    assert.equal(incSpy.mock.calls.length, 0, "success 分支不应 increment")
  })

  it("review P1-2: Haiku 失败 fallback 时累加 title_backfill_attempts", async () => {
    const { repo, incSpy, resetSpy } = makeRepo({
      id: SID,
      title: "新会话 2026-04-20",
      roomId: ROOM,
    })
    const { haiku } = makeHaiku({ ok: false, error: "timeout" })
    const { logger } = makeLogger()
    const titler = new SessionTitler({
      repo,
      haiku,
      logger,
      debounceMs: 5,
      buildPrompt: () => "p",
      dateFormatter: () => "2026-04-20",
    })
    titler.schedule(SID)
    await titler.flushPending()
    assert.equal(incSpy.mock.calls.length, 1, "fallback 必须 increment — 防 backfill 死循环")
    assert.equal(incSpy.mock.calls[0].arguments[0], SID)
    assert.equal(resetSpy.mock.calls.length, 0, "fallback 分支不应 reset")
  })
})
