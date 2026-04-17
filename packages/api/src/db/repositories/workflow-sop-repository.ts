/**
 * F019: WorkflowSopRepository — DB layer for the 告示牌 state machine.
 *
 * Responsibilities:
 * - CRUD on `workflow_sop` table
 * - Optimistic lock via `version` column (expectedVersion input)
 * - JSON (de)serialization for resumeCapsule + checks blobs
 * - Partial-update merge semantics (preserve fields not in input)
 *
 * Does NOT:
 * - Validate stage vocabulary (WorkflowSopService does that)
 * - Emit events (that's the service layer's job)
 * - Manage caching (service layer or future decorator)
 */

import { eq } from "drizzle-orm"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type * as schema from "../schema"
import { workflowSop } from "../schema"
import type {
  ResumeCapsule,
  SopChecks,
  SopStage,
  UpdateSopInput,
  WorkflowSop,
} from "../../services/workflow-sop-types"

type DrizzleDb = BetterSQLite3Database<typeof schema>

/** Thrown when upsert's expectedVersion does not match current DB version. */
export class OptimisticLockError extends Error {
  constructor(
    readonly backlogItemId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `OptimisticLockError: ${backlogItemId} expected version=${expectedVersion}, actual=${actualVersion}`,
    )
    this.name = "OptimisticLockError"
  }
}

/**
 * F019 review-P2 (Codex Finding 2): thrown when an upsert attempts to change
 * featureId on an existing row. featureId is insert-only — pairing an existing
 * backlogItemId with a new featureId creates silently-inconsistent rows (e.g.
 * backlog_item_id='F019' / feature_id='F999') that would make buildHint emit
 * the wrong feature in every future system prompt.
 */
export class FeatureIdMismatchError extends Error {
  constructor(
    readonly backlogItemId: string,
    readonly storedFeatureId: string,
    readonly attemptedFeatureId: string,
  ) {
    super(
      `FeatureIdMismatchError: ${backlogItemId} is bound to feature "${storedFeatureId}", cannot rename to "${attemptedFeatureId}"`,
    )
    this.name = "FeatureIdMismatchError"
  }
}

const EMPTY_RESUME: ResumeCapsule = { goal: "", done: [], currentFocus: "" }

export class DrizzleWorkflowSopRepository {
  constructor(private readonly db: DrizzleDb) {}

  get(backlogItemId: string): WorkflowSop | null {
    const row = this.db
      .select()
      .from(workflowSop)
      .where(eq(workflowSop.backlogItemId, backlogItemId))
      .get()
    if (!row) return null
    return this.hydrate(row)
  }

  upsert(input: UpdateSopInput): WorkflowSop {
    const existing = this.get(input.backlogItemId)

    if (input.expectedVersion !== undefined) {
      const actual = existing?.version ?? 0
      if (actual !== input.expectedVersion) {
        throw new OptimisticLockError(input.backlogItemId, input.expectedVersion, actual)
      }
    }

    // F019 review-P2 + follow-up (Codex Findings 2 + follow-up):
    // featureId identity is non-spoofable at BOTH insert and update paths.
    //   - On update: existing row's featureId is authoritative; any explicit
    //     input.featureId must match it.
    //   - On insert: backlogItemId is authoritative (our current model treats
    //     featureId == backlogItemId). Explicit input.featureId must match
    //     backlogItemId, else throw — this closes the first-write spoof path
    //     where a caller bound to backlogItemId=F019 could persist
    //     feature_id=F999 and make buildHint emit the wrong feature later.
    // Omitting input.featureId always defaults to the authoritative value.
    const expectedFeatureId = existing?.featureId ?? input.backlogItemId
    if (input.featureId !== undefined && input.featureId !== expectedFeatureId) {
      throw new FeatureIdMismatchError(
        input.backlogItemId,
        expectedFeatureId,
        input.featureId,
      )
    }

    const now = new Date().toISOString()
    const nextVersion = (existing?.version ?? 0) + 1

    // Merge — preserve fields not in input.
    const featureId = input.featureId ?? existing?.featureId ?? input.backlogItemId
    const stage: SopStage = (input.stage ?? existing?.stage ?? "kickoff") as SopStage
    const batonHolder =
      input.batonHolder !== undefined ? input.batonHolder : (existing?.batonHolder ?? null)
    const nextSkill =
      input.nextSkill !== undefined ? input.nextSkill : (existing?.nextSkill ?? null)

    const mergedResume: ResumeCapsule = {
      ...(existing?.resumeCapsule ?? EMPTY_RESUME),
      ...(input.resumeCapsule ?? {}),
    }
    const mergedChecks: SopChecks = {
      ...(existing?.checks ?? {}),
      ...(input.checks ?? {}),
    }

    const merged: WorkflowSop = {
      backlogItemId: input.backlogItemId,
      featureId,
      stage,
      batonHolder,
      nextSkill,
      resumeCapsule: mergedResume,
      checks: mergedChecks,
      version: nextVersion,
      updatedAt: now,
      updatedBy: input.updatedBy,
    }

    const dbRow = {
      backlogItemId: merged.backlogItemId,
      featureId: merged.featureId,
      stage: merged.stage,
      batonHolder: merged.batonHolder,
      nextSkill: merged.nextSkill,
      resumeCapsule: JSON.stringify(merged.resumeCapsule),
      checks: JSON.stringify(merged.checks),
      version: merged.version,
      updatedAt: merged.updatedAt,
      updatedBy: merged.updatedBy,
    }

    if (existing) {
      this.db
        .update(workflowSop)
        .set(dbRow)
        .where(eq(workflowSop.backlogItemId, input.backlogItemId))
        .run()
    } else {
      this.db.insert(workflowSop).values(dbRow).run()
    }

    return merged
  }

  delete(backlogItemId: string): void {
    this.db.delete(workflowSop).where(eq(workflowSop.backlogItemId, backlogItemId)).run()
  }

  private hydrate(row: typeof workflowSop.$inferSelect): WorkflowSop {
    let resumeCapsule: ResumeCapsule
    try {
      resumeCapsule = { ...EMPTY_RESUME, ...(JSON.parse(row.resumeCapsule) as Partial<ResumeCapsule>) }
    } catch {
      resumeCapsule = EMPTY_RESUME
    }

    let checks: SopChecks
    try {
      checks = (JSON.parse(row.checks) as SopChecks) ?? {}
    } catch {
      checks = {}
    }

    return {
      backlogItemId: row.backlogItemId,
      featureId: row.featureId,
      stage: row.stage as SopStage,
      batonHolder: row.batonHolder,
      nextSkill: row.nextSkill,
      resumeCapsule,
      checks,
      version: row.version,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    }
  }
}
