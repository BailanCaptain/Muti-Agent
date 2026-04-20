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
  const updateSpy = mock.fn((id: string, title: string) => {
    if (id === current.id) current = { ...current, title }
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
    },
    updateSpy,
    peekTitle: () => current.title,
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

  it("AC-07: writes Haiku result to session_groups.title on success and logs event=success", async () => {
    const { repo, updateSpy } = makeRepo({ id: SID, title: "新会话 2026-04-20 14:30:00", roomId: ROOM })
    const { haiku } = makeHaiku({ ok: true, text: "学习 TDD" })
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
    assert.deepEqual(updateSpy.mock.calls[0].arguments, [SID, "学习 TDD"])
    const ok = byEvent("success")
    assert.equal(ok.length, 1)
    assert.equal(ok[0].obj.sessionGroupId, SID)
    assert.equal(ok[0].obj.roomId, ROOM)
    assert.equal(ok[0].obj.titleGenerated, "学习 TDD")
    assert.equal(typeof ok[0].obj.durationMs, "number")
  })

  it("AC-06: truncates Haiku output to 10 chars", async () => {
    const { repo, updateSpy } = makeRepo({ id: SID, title: "新会话 2026-04-20", roomId: ROOM })
    const { haiku } = makeHaiku({ ok: true, text: "这是一个会被截断的超长标题" })
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
    const written = updateSpy.mock.calls[0].arguments[1] as string
    assert.ok(written.length <= 10, `title should be <=10 chars, got "${written}" (${written.length})`)
    assert.equal(written, "这是一个会被截断的超")
  })

  it("AC-08: falls back to '新会话 YYYY-MM-DD' on Haiku failure and logs event=fallback", async () => {
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
    assert.deepEqual(updateSpy.mock.calls[0].arguments, [SID, "新会话 2026-04-20"])
    const fb = byEvent("fallback")
    assert.equal(fb.length, 1)
    assert.equal(fb[0].level, "warn")
    assert.equal(fb[0].obj.error, "timeout")
    assert.equal(fb[0].obj.titleGenerated, "新会话 2026-04-20")
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
})
