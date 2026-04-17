import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

function safeTempDir(prefix: string) {
  const runtimeDir = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(runtimeDir, { recursive: true })
  return fs.mkdtempSync(path.join(runtimeDir, prefix))
}

function safeCleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // Windows WAL locks — best effort
  }
}

async function buildRepo() {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleWorkflowSopRepository, OptimisticLockError } = await import(
    "./workflow-sop-repository"
  )
  const tempDir = safeTempDir("wsop-repo-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleWorkflowSopRepository(db)
  return {
    repo,
    OptimisticLockError,
    cleanup: () => {
      close()
      safeCleanup(tempDir)
    },
  }
}

test("WorkflowSopRepository.upsert inserts new row with version=1", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const result = repo.upsert({
      backlogItemId: "F019",
      featureId: "F019",
      stage: "kickoff",
      updatedBy: "黄仁勋",
    })
    assert.equal(result.version, 1)
    assert.equal(result.stage, "kickoff")
    assert.equal(result.featureId, "F019")
    assert.equal(result.batonHolder, null)
    assert.equal(result.nextSkill, null)
  } finally {
    cleanup()
  }
})

test("WorkflowSopRepository.upsert increments version on update", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    repo.upsert({ backlogItemId: "F019", featureId: "F019", stage: "kickoff", updatedBy: "x" })
    const second = repo.upsert({
      backlogItemId: "F019",
      stage: "impl",
      updatedBy: "y",
    })
    assert.equal(second.version, 2)
    assert.equal(second.stage, "impl")
    assert.equal(second.featureId, "F019", "featureId preserved from first insert")
    assert.equal(second.updatedBy, "y")
  } finally {
    cleanup()
  }
})

test("WorkflowSopRepository.upsert with expectedVersion mismatch throws OptimisticLockError", async () => {
  const { repo, OptimisticLockError, cleanup } = await buildRepo()
  try {
    repo.upsert({ backlogItemId: "F019", featureId: "F019", stage: "kickoff", updatedBy: "x" })
    // current version = 1
    assert.throws(
      () =>
        repo.upsert({
          backlogItemId: "F019",
          stage: "impl",
          updatedBy: "x",
          expectedVersion: 99,
        }),
      (err: unknown) => err instanceof OptimisticLockError,
    )
  } finally {
    cleanup()
  }
})

test("WorkflowSopRepository.upsert with matching expectedVersion succeeds", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const first = repo.upsert({
      backlogItemId: "F019",
      featureId: "F019",
      stage: "kickoff",
      updatedBy: "x",
    })
    const second = repo.upsert({
      backlogItemId: "F019",
      stage: "impl",
      updatedBy: "x",
      expectedVersion: first.version,
    })
    assert.equal(second.version, 2)
  } finally {
    cleanup()
  }
})

test("WorkflowSopRepository.get returns null for unknown backlogItemId", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    assert.equal(repo.get("F999"), null)
  } finally {
    cleanup()
  }
})

test("WorkflowSopRepository.get parses resumeCapsule and checks as objects (not strings)", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    repo.upsert({
      backlogItemId: "F019",
      featureId: "F019",
      stage: "impl",
      updatedBy: "x",
      resumeCapsule: { goal: "ship 告示牌", done: ["P1"], currentFocus: "P2 schema" },
      checks: { remoteMainSynced: "verified" },
    })
    const got = repo.get("F019")
    assert.ok(got)
    assert.deepEqual(got.resumeCapsule, {
      goal: "ship 告示牌",
      done: ["P1"],
      currentFocus: "P2 schema",
    })
    assert.equal(got.checks.remoteMainSynced, "verified")
  } finally {
    cleanup()
  }
})

test("WorkflowSopRepository.upsert merges resumeCapsule and checks (no overwrite)", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    repo.upsert({
      backlogItemId: "F019",
      featureId: "F019",
      stage: "impl",
      updatedBy: "x",
      resumeCapsule: { goal: "G", done: ["a"], currentFocus: "b" },
      checks: { remoteMainSynced: "verified" },
    })
    // Partial update — should merge, not replace wholesale
    repo.upsert({
      backlogItemId: "F019",
      updatedBy: "x",
      resumeCapsule: { currentFocus: "c" },
      checks: { qualityGatePassed: "attested" },
    })
    const got = repo.get("F019")
    assert.ok(got)
    assert.equal(got.resumeCapsule.goal, "G", "original goal preserved")
    assert.deepEqual(got.resumeCapsule.done, ["a"], "original done preserved")
    assert.equal(got.resumeCapsule.currentFocus, "c", "currentFocus updated")
    assert.equal(got.checks.remoteMainSynced, "verified", "original check preserved")
    assert.equal(got.checks.qualityGatePassed, "attested", "new check merged in")
  } finally {
    cleanup()
  }
})

// ── Codex review Finding 2: featureId must be insert-only ───────────────

test("WorkflowSopRepository.upsert rejects featureId change on existing row (throws FeatureIdMismatchError)", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    repo.upsert({
      backlogItemId: "F019",
      featureId: "F019",
      stage: "kickoff",
      updatedBy: "x",
    })
    const { FeatureIdMismatchError } = await import("./workflow-sop-repository")
    assert.throws(
      () =>
        repo.upsert({
          backlogItemId: "F019",
          featureId: "F999", // rename attempt — must be rejected
          stage: "impl",
          updatedBy: "x",
        }),
      (err: unknown) => err instanceof FeatureIdMismatchError,
    )
    // Confirm the row was NOT mutated
    const got = repo.get("F019")
    assert.equal(got?.featureId, "F019", "featureId must not be overwritten")
    assert.equal(got?.stage, "kickoff", "stage must not be updated when the write was rejected")
    assert.equal(got?.version, 1, "version must not be incremented when the write was rejected")
  } finally {
    cleanup()
  }
})

test("WorkflowSopRepository.upsert allows omitting featureId on update (no rename attempt)", async () => {
  // This proves the immutability rule does NOT break the normal partial-update flow.
  const { repo, cleanup } = await buildRepo()
  try {
    repo.upsert({ backlogItemId: "F019", featureId: "F019", stage: "kickoff", updatedBy: "x" })
    const updated = repo.upsert({ backlogItemId: "F019", stage: "impl", updatedBy: "x" })
    assert.equal(updated.featureId, "F019", "featureId preserved from insert")
    assert.equal(updated.stage, "impl")
    assert.equal(updated.version, 2)
  } finally {
    cleanup()
  }
})

test("WorkflowSopRepository.upsert rejects featureId mismatch on FIRST INSERT (Codex follow-up finding)", async () => {
  // thread may be bound to F019, but caller sends featureId=F999 on an empty
  // row. Previous fix only caught rename (existing != null); insert path was
  // still wide open.
  const { repo, cleanup } = await buildRepo()
  try {
    const { FeatureIdMismatchError } = await import("./workflow-sop-repository")
    assert.throws(
      () =>
        repo.upsert({
          backlogItemId: "F019",
          featureId: "F999", // first-write mismatch — must be rejected
          stage: "kickoff",
          updatedBy: "x",
        }),
      (err: unknown) => err instanceof FeatureIdMismatchError,
    )
    // Confirm the row was NOT created
    assert.equal(repo.get("F019"), null, "insert must not persist on mismatch")
  } finally {
    cleanup()
  }
})

test("WorkflowSopRepository.upsert accepts featureId matching backlogItemId on first insert", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const result = repo.upsert({
      backlogItemId: "F019",
      featureId: "F019", // explicit, matches backlogItemId — fine
      stage: "kickoff",
      updatedBy: "x",
    })
    assert.equal(result.featureId, "F019")
    assert.equal(result.version, 1)
  } finally {
    cleanup()
  }
})

test("WorkflowSopRepository.upsert defaults featureId to backlogItemId when omitted on first insert", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const result = repo.upsert({
      backlogItemId: "F019",
      // no featureId
      stage: "kickoff",
      updatedBy: "x",
    })
    assert.equal(result.featureId, "F019", "featureId must default to backlogItemId")
  } finally {
    cleanup()
  }
})

test("WorkflowSopRepository.upsert allows setting featureId equal to stored value (no-op rename)", async () => {
  // Explicitly passing the same featureId is fine — it's not a rename.
  const { repo, cleanup } = await buildRepo()
  try {
    repo.upsert({ backlogItemId: "F019", featureId: "F019", stage: "kickoff", updatedBy: "x" })
    const updated = repo.upsert({
      backlogItemId: "F019",
      featureId: "F019",
      stage: "impl",
      updatedBy: "x",
    })
    assert.equal(updated.featureId, "F019")
    assert.equal(updated.version, 2)
  } finally {
    cleanup()
  }
})

test("WorkflowSopRepository.delete removes row", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    repo.upsert({ backlogItemId: "F019", featureId: "F019", stage: "kickoff", updatedBy: "x" })
    assert.ok(repo.get("F019"))
    repo.delete("F019")
    assert.equal(repo.get("F019"), null)
  } finally {
    cleanup()
  }
})
