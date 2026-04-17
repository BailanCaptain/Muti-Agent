import assert from "node:assert/strict"
import test from "node:test"
import type { WorkflowSop, UpdateSopInput } from "./workflow-sop-types"

/**
 * Minimal fake repo — lets us exercise service behavior without touching SQLite.
 * The real repo has its own 8-test suite; here we only care about delegation
 * and the service-specific logic (buildHint, stage validation).
 */
class FakeWorkflowSopRepository {
  public upsertCalls: UpdateSopInput[] = []
  public getCalls: string[] = []
  public deleteCalls: string[] = []
  private stored: WorkflowSop | null

  constructor(initial: WorkflowSop | null = null) {
    this.stored = initial
  }

  get(backlogItemId: string): WorkflowSop | null {
    this.getCalls.push(backlogItemId)
    return this.stored && this.stored.backlogItemId === backlogItemId ? this.stored : null
  }

  upsert(input: UpdateSopInput): WorkflowSop {
    this.upsertCalls.push(input)
    const merged: WorkflowSop = {
      backlogItemId: input.backlogItemId,
      featureId: input.featureId ?? this.stored?.featureId ?? input.backlogItemId,
      stage: input.stage ?? this.stored?.stage ?? "kickoff",
      batonHolder: input.batonHolder ?? this.stored?.batonHolder ?? null,
      nextSkill: input.nextSkill ?? this.stored?.nextSkill ?? null,
      resumeCapsule: this.stored?.resumeCapsule ?? { goal: "", done: [], currentFocus: "" },
      checks: this.stored?.checks ?? {},
      version: (this.stored?.version ?? 0) + 1,
      updatedAt: "2026-04-17T00:00:00Z",
      updatedBy: input.updatedBy,
    }
    this.stored = merged
    return merged
  }

  delete(backlogItemId: string): void {
    this.deleteCalls.push(backlogItemId)
    if (this.stored?.backlogItemId === backlogItemId) this.stored = null
  }
}

test("WorkflowSopService.get delegates to repository", async () => {
  const { WorkflowSopService } = await import("./workflow-sop-service")
  const stored: WorkflowSop = {
    backlogItemId: "F019",
    featureId: "F019",
    stage: "impl",
    batonHolder: null,
    nextSkill: "tdd",
    resumeCapsule: { goal: "", done: [], currentFocus: "" },
    checks: {},
    version: 1,
    updatedAt: "2026-04-17T00:00:00Z",
    updatedBy: "黄仁勋",
  }
  const repo = new FakeWorkflowSopRepository(stored)
  // biome-ignore lint: test-only cast through any
  const svc = new WorkflowSopService(repo as unknown as never)
  const result = svc.get("F019")
  assert.equal(result?.stage, "impl")
  assert.equal(repo.getCalls.length, 1)
  assert.equal(repo.getCalls[0], "F019")
})

test("WorkflowSopService.upsert delegates to repository", async () => {
  const { WorkflowSopService } = await import("./workflow-sop-service")
  const repo = new FakeWorkflowSopRepository()
  const svc = new WorkflowSopService(repo as unknown as never)
  svc.upsert({
    backlogItemId: "F019",
    featureId: "F019",
    stage: "impl",
    updatedBy: "黄仁勋",
  })
  assert.equal(repo.upsertCalls.length, 1)
  assert.equal(repo.upsertCalls[0].stage, "impl")
})

test("WorkflowSopService.upsert rejects invalid stage values", async () => {
  const { WorkflowSopService } = await import("./workflow-sop-service")
  const repo = new FakeWorkflowSopRepository()
  const svc = new WorkflowSopService(repo as unknown as never)
  assert.throws(
    () =>
      svc.upsert({
        backlogItemId: "F019",
        featureId: "F019",
        stage: "not_a_real_stage" as never,
        updatedBy: "x",
      }),
    /invalid stage/i,
  )
  assert.equal(repo.upsertCalls.length, 0, "should not delegate when validation fails")
})

test("WorkflowSopService.delete delegates to repository", async () => {
  const { WorkflowSopService } = await import("./workflow-sop-service")
  const stored: WorkflowSop = {
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
  const repo = new FakeWorkflowSopRepository(stored)
  const svc = new WorkflowSopService(repo as unknown as never)
  svc.delete("F019")
  assert.deepEqual(repo.deleteCalls, ["F019"])
})

test("WorkflowSopService.buildHint returns null for null/empty backlogItemId", async () => {
  const { WorkflowSopService } = await import("./workflow-sop-service")
  const repo = new FakeWorkflowSopRepository()
  const svc = new WorkflowSopService(repo as unknown as never)
  assert.equal(svc.buildHint(null), null)
  assert.equal(svc.buildHint(undefined), null)
  assert.equal(svc.buildHint(""), null)
  assert.equal(repo.getCalls.length, 0, "should not query DB when input is empty")
})

test("WorkflowSopService.buildHint returns null when feature not found", async () => {
  const { WorkflowSopService } = await import("./workflow-sop-service")
  const repo = new FakeWorkflowSopRepository()
  const svc = new WorkflowSopService(repo as unknown as never)
  assert.equal(svc.buildHint("F999"), null)
})

test("WorkflowSopService.buildHint returns formatted string when sop found with nextSkill", async () => {
  const { WorkflowSopService } = await import("./workflow-sop-service")
  const stored: WorkflowSop = {
    backlogItemId: "F019",
    featureId: "F019",
    stage: "impl",
    batonHolder: null,
    nextSkill: "tdd",
    resumeCapsule: { goal: "", done: [], currentFocus: "" },
    checks: {},
    version: 1,
    updatedAt: "2026-04-17T00:00:00Z",
    updatedBy: "x",
  }
  const repo = new FakeWorkflowSopRepository(stored)
  const svc = new WorkflowSopService(repo as unknown as never)
  assert.equal(svc.buildHint("F019"), "SOP: F019 stage=impl → load skill: tdd")
})

test("WorkflowSopService.buildHint omits '→ load skill' suffix when nextSkill is null", async () => {
  const { WorkflowSopService } = await import("./workflow-sop-service")
  const stored: WorkflowSop = {
    backlogItemId: "F019",
    featureId: "F019",
    stage: "completion",
    batonHolder: null,
    nextSkill: null,
    resumeCapsule: { goal: "", done: [], currentFocus: "" },
    checks: {},
    version: 1,
    updatedAt: "2026-04-17T00:00:00Z",
    updatedBy: "x",
  }
  const repo = new FakeWorkflowSopRepository(stored)
  const svc = new WorkflowSopService(repo as unknown as never)
  assert.equal(svc.buildHint("F019"), "SOP: F019 stage=completion")
})
