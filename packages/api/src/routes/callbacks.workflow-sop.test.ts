import assert from "node:assert/strict"
import test from "node:test"
import Fastify, { type FastifyInstance } from "fastify"
import { InvocationRegistry } from "../orchestrator/invocation-registry"
import { registerCallbackRoutes } from "./callbacks"
import type { UpdateSopInput, WorkflowSop } from "../services/workflow-sop-types"
import { FeatureIdMismatchError, OptimisticLockError } from "../db/repositories/workflow-sop-repository"

interface TestHarness {
  app: FastifyInstance
  invocationId: string
  callbackToken: string
  upsertCalls: UpdateSopInput[]
  stored: WorkflowSop | null
  close: () => Promise<void>
}

function buildHarness(opts?: {
  throwOnUpsert?: "optimistic-lock" | "generic" | "feature-id-mismatch"
  storedSop?: WorkflowSop | null
  /** thread.backlogItemId — default "F019" so existing tests work; null = unbound */
  threadBacklogItemId?: string | null
  /** isSessionGroupCancelled return value; default false */
  sessionCancelled?: boolean
}): TestHarness {
  const app = Fastify()
  const invocations = new InvocationRegistry<{ cancel: () => void }>()
  const identity = invocations.createInvocation("thread-1", "黄仁勋")

  const upsertCalls: UpdateSopInput[] = []
  let stored: WorkflowSop | null = opts?.storedSop ?? null
  const threadBacklogItemId =
    opts?.threadBacklogItemId === undefined ? "F019" : opts.threadBacklogItemId

  const workflowSopService = {
    get: (id: string) => (stored && stored.backlogItemId === id ? stored : null),
    upsert: (input: UpdateSopInput): WorkflowSop => {
      if (opts?.throwOnUpsert === "optimistic-lock") {
        throw new OptimisticLockError(input.backlogItemId, input.expectedVersion ?? -1, 99)
      }
      if (opts?.throwOnUpsert === "feature-id-mismatch") {
        throw new FeatureIdMismatchError(input.backlogItemId, "F019", input.featureId ?? "?")
      }
      if (opts?.throwOnUpsert === "generic") {
        throw new Error("db offline")
      }
      upsertCalls.push(input)
      const merged: WorkflowSop = {
        backlogItemId: input.backlogItemId,
        featureId: input.featureId ?? stored?.featureId ?? input.backlogItemId,
        stage: input.stage ?? stored?.stage ?? "kickoff",
        batonHolder: input.batonHolder ?? stored?.batonHolder ?? null,
        nextSkill: input.nextSkill ?? stored?.nextSkill ?? null,
        resumeCapsule: stored?.resumeCapsule ?? { goal: "", done: [], currentFocus: "" },
        checks: stored?.checks ?? {},
        version: (stored?.version ?? 0) + 1,
        updatedAt: "2026-04-17T00:00:00Z",
        updatedBy: input.updatedBy,
      }
      stored = merged
      return merged
    },
    delete: () => {
      stored = null
    },
    buildHint: () => null,
  }

  registerCallbackRoutes(app, {
    repository: {
      getThreadById: () => ({
        id: "thread-1",
        sessionGroupId: "group-1",
        backlogItemId: threadBacklogItemId,
      }),
    } as never,
    sessions: {} as never,
    broadcaster: { broadcast: () => {} },
    getRunningThreadIds: () => new Set<string>(),
    invocations,
    isSessionGroupCancelled: () => Boolean(opts?.sessionCancelled),
    workflowSopService: workflowSopService as never,
  })

  return {
    app,
    invocationId: identity.invocationId,
    callbackToken: identity.callbackToken,
    upsertCalls,
    get stored() {
      return stored
    },
    close: async () => {
      await app.close()
    },
  } as TestHarness
}

test("update-workflow-sop: 200 with sop in body on successful insert", async () => {
  const h = buildHarness()
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/callbacks/update-workflow-sop",
      payload: {
        invocationId: h.invocationId,
        callbackToken: h.callbackToken,
        backlogItemId: "F019",
        featureId: "F019",
        stage: "impl",
      },
    })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.sop.version, 1)
    assert.equal(body.sop.stage, "impl")
    assert.equal(h.upsertCalls.length, 1)
    assert.equal(h.upsertCalls[0].updatedBy, "黄仁勋")
  } finally {
    await h.close()
  }
})

test("update-workflow-sop: 401 when invocation/token invalid", async () => {
  const h = buildHarness()
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/callbacks/update-workflow-sop",
      payload: {
        invocationId: "wrong",
        callbackToken: "wrong",
        backlogItemId: "F019",
        featureId: "F019",
        stage: "impl",
      },
    })
    assert.equal(res.statusCode, 401)
    assert.equal(h.upsertCalls.length, 0)
  } finally {
    await h.close()
  }
})

test("update-workflow-sop: 400 on invalid stage value", async () => {
  const h = buildHarness()
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/callbacks/update-workflow-sop",
      payload: {
        invocationId: h.invocationId,
        callbackToken: h.callbackToken,
        backlogItemId: "F019",
        featureId: "F019",
        stage: "invalid_stage",
      },
    })
    assert.equal(res.statusCode, 400)
    assert.equal(h.upsertCalls.length, 0)
  } finally {
    await h.close()
  }
})

test("update-workflow-sop: 400 when backlogItemId missing", async () => {
  const h = buildHarness()
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/callbacks/update-workflow-sop",
      payload: {
        invocationId: h.invocationId,
        callbackToken: h.callbackToken,
        featureId: "F019",
        stage: "impl",
      },
    })
    assert.equal(res.statusCode, 400)
  } finally {
    await h.close()
  }
})

test("update-workflow-sop: 409 on optimistic lock mismatch", async () => {
  const h = buildHarness({ throwOnUpsert: "optimistic-lock" })
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/callbacks/update-workflow-sop",
      payload: {
        invocationId: h.invocationId,
        callbackToken: h.callbackToken,
        backlogItemId: "F019",
        featureId: "F019",
        stage: "impl",
        expectedVersion: 0,
      },
    })
    assert.equal(res.statusCode, 409)
    const body = JSON.parse(res.body)
    assert.match(body.error, /OptimisticLockError/)
  } finally {
    await h.close()
  }
})

test("update-workflow-sop: 409 on FIRST-INSERT featureId mismatch (Codex follow-up)", async () => {
  // Thread is bound to F019 (so Finding-1 thread-scope passes because
  // body.backlogItemId = F019). But caller sends featureId = F999 on an
  // empty workflow_sop — the spoof path Codex flagged in follow-up review.
  // Harness' fake service throws FeatureIdMismatchError when featureId != backlogItemId
  // to mirror the real repo's insert-path check.
  const h = buildHarness({ throwOnUpsert: "feature-id-mismatch" })
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/callbacks/update-workflow-sop",
      payload: {
        invocationId: h.invocationId,
        callbackToken: h.callbackToken,
        backlogItemId: "F019",
        featureId: "F999", // mismatch on first insert — must be rejected with 409
        stage: "kickoff",
      },
    })
    assert.equal(res.statusCode, 409)
    const body = JSON.parse(res.body)
    assert.match(body.error, /FeatureIdMismatchError|cannot rename/i)
  } finally {
    await h.close()
  }
})

test("update-workflow-sop: 409 on FeatureIdMismatchError (Codex review Finding 2)", async () => {
  const h = buildHarness({ throwOnUpsert: "feature-id-mismatch" })
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/callbacks/update-workflow-sop",
      payload: {
        invocationId: h.invocationId,
        callbackToken: h.callbackToken,
        backlogItemId: "F019",
        featureId: "F999", // attempt rename — service must throw
        stage: "impl",
      },
    })
    assert.equal(res.statusCode, 409)
    const body = JSON.parse(res.body)
    assert.match(body.error, /FeatureIdMismatchError|cannot rename/i)
  } finally {
    await h.close()
  }
})

test("update-workflow-sop: 500 on generic service error", async () => {
  const h = buildHarness({ throwOnUpsert: "generic" })
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/callbacks/update-workflow-sop",
      payload: {
        invocationId: h.invocationId,
        callbackToken: h.callbackToken,
        backlogItemId: "F019",
        featureId: "F019",
        stage: "impl",
      },
    })
    assert.equal(res.statusCode, 500)
  } finally {
    await h.close()
  }
})

// ── Security/authorization tests (Codex review Finding 1) ───────────────

test("update-workflow-sop: 403 when invocation's thread is not bound to any feature", async () => {
  const h = buildHarness({ threadBacklogItemId: null })
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/callbacks/update-workflow-sop",
      payload: {
        invocationId: h.invocationId,
        callbackToken: h.callbackToken,
        backlogItemId: "F019",
        featureId: "F019",
        stage: "impl",
      },
    })
    assert.equal(res.statusCode, 403)
    const body = JSON.parse(res.body)
    assert.match(body.error, /not bound/i)
    assert.equal(h.upsertCalls.length, 0, "no write should happen")
  } finally {
    await h.close()
  }
})

test("update-workflow-sop: 403 when body.backlogItemId does not match thread's bound feature", async () => {
  // Thread bound to F019, but caller tries to write F999
  const h = buildHarness({ threadBacklogItemId: "F019" })
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/callbacks/update-workflow-sop",
      payload: {
        invocationId: h.invocationId,
        callbackToken: h.callbackToken,
        backlogItemId: "F999", // mismatch — foreign feature
        featureId: "F999",
        stage: "impl",
      },
    })
    assert.equal(res.statusCode, 403)
    const body = JSON.parse(res.body)
    assert.match(body.error, /does not match|bound to/i)
    assert.equal(h.upsertCalls.length, 0, "no write should happen")
  } finally {
    await h.close()
  }
})

// ── Input validation tests (Codex review Finding 3) ────────────────────

test("update-workflow-sop: whitespace-padded backlogItemId is trimmed then compared", async () => {
  // Thread is bound to "F019"; caller sends "  F019  " — should normalize and accept
  const h = buildHarness({ threadBacklogItemId: "F019" })
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/callbacks/update-workflow-sop",
      payload: {
        invocationId: h.invocationId,
        callbackToken: h.callbackToken,
        backlogItemId: "  F019  ",
        featureId: "F019",
        stage: "impl",
      },
    })
    assert.equal(res.statusCode, 200, "trimmed backlogItemId must match thread binding")
    assert.equal(h.upsertCalls[0]?.backlogItemId, "F019", "persisted value must be trimmed")
  } finally {
    await h.close()
  }
})

test("update-workflow-sop: all-whitespace backlogItemId returns 400", async () => {
  const h = buildHarness()
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/callbacks/update-workflow-sop",
      payload: {
        invocationId: h.invocationId,
        callbackToken: h.callbackToken,
        backlogItemId: "   ",
        featureId: "F019",
        stage: "impl",
      },
    })
    assert.equal(res.statusCode, 400)
    assert.equal(h.upsertCalls.length, 0)
  } finally {
    await h.close()
  }
})

test("update-workflow-sop: invalid checks enum value returns 400", async () => {
  const h = buildHarness()
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/callbacks/update-workflow-sop",
      payload: {
        invocationId: h.invocationId,
        callbackToken: h.callbackToken,
        backlogItemId: "F019",
        featureId: "F019",
        stage: "impl",
        checks: { reviewApproved: "approved" }, // not in enum
      },
    })
    assert.equal(res.statusCode, 400)
    const body = JSON.parse(res.body)
    assert.match(body.error, /checks/i)
    assert.equal(h.upsertCalls.length, 0)
  } finally {
    await h.close()
  }
})

test("update-workflow-sop: invalid checks key returns 400", async () => {
  const h = buildHarness()
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/callbacks/update-workflow-sop",
      payload: {
        invocationId: h.invocationId,
        callbackToken: h.callbackToken,
        backlogItemId: "F019",
        featureId: "F019",
        stage: "impl",
        checks: { randomKey: "verified" }, // unknown key
      },
    })
    assert.equal(res.statusCode, 400)
    assert.equal(h.upsertCalls.length, 0)
  } finally {
    await h.close()
  }
})

test("update-workflow-sop: invalid resumeCapsule (done not an array) returns 400", async () => {
  const h = buildHarness()
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/callbacks/update-workflow-sop",
      payload: {
        invocationId: h.invocationId,
        callbackToken: h.callbackToken,
        backlogItemId: "F019",
        featureId: "F019",
        stage: "impl",
        resumeCapsule: { done: "oops" }, // must be string[]
      },
    })
    assert.equal(res.statusCode, 400)
    const body = JSON.parse(res.body)
    assert.match(body.error, /resumeCapsule|done/i)
    assert.equal(h.upsertCalls.length, 0)
  } finally {
    await h.close()
  }
})

test("update-workflow-sop: negative expectedVersion returns 400", async () => {
  const h = buildHarness()
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/callbacks/update-workflow-sop",
      payload: {
        invocationId: h.invocationId,
        callbackToken: h.callbackToken,
        backlogItemId: "F019",
        featureId: "F019",
        stage: "impl",
        expectedVersion: -1,
      },
    })
    assert.equal(res.statusCode, 400)
    assert.equal(h.upsertCalls.length, 0)
  } finally {
    await h.close()
  }
})

test("update-workflow-sop: non-integer expectedVersion returns 400", async () => {
  const h = buildHarness()
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/callbacks/update-workflow-sop",
      payload: {
        invocationId: h.invocationId,
        callbackToken: h.callbackToken,
        backlogItemId: "F019",
        featureId: "F019",
        stage: "impl",
        expectedVersion: 1.5,
      },
    })
    assert.equal(res.statusCode, 400)
    assert.equal(h.upsertCalls.length, 0)
  } finally {
    await h.close()
  }
})

test("update-workflow-sop: 403 when session is cancelled", async () => {
  const h = buildHarness({ sessionCancelled: true })
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/callbacks/update-workflow-sop",
      payload: {
        invocationId: h.invocationId,
        callbackToken: h.callbackToken,
        backlogItemId: "F019",
        featureId: "F019",
        stage: "impl",
      },
    })
    assert.equal(res.statusCode, 403)
    const body = JSON.parse(res.body)
    assert.match(body.error, /cancelled/i)
    assert.equal(h.upsertCalls.length, 0, "no write should happen")
  } finally {
    await h.close()
  }
})

test("update-workflow-sop: partial update merges fields (featureId not required on update)", async () => {
  const existing: WorkflowSop = {
    backlogItemId: "F019",
    featureId: "F019",
    stage: "kickoff",
    batonHolder: null,
    nextSkill: null,
    resumeCapsule: { goal: "", done: [], currentFocus: "" },
    checks: {},
    version: 1,
    updatedAt: "2026-04-17T00:00:00Z",
    updatedBy: "x",
  }
  const h = buildHarness({ storedSop: existing })
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/callbacks/update-workflow-sop",
      payload: {
        invocationId: h.invocationId,
        callbackToken: h.callbackToken,
        backlogItemId: "F019",
        // no featureId, no stage — just moving baton
        batonHolder: "桂芬",
      },
    })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.sop.batonHolder, "桂芬")
    assert.equal(body.sop.stage, "kickoff", "stage preserved")
    assert.equal(body.sop.version, 2)
  } finally {
    await h.close()
  }
})
