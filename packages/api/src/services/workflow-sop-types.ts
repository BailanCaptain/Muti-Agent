/**
 * F019: WorkflowSop state machine types — 告示牌引擎
 *
 * Single source for types shared between WorkflowSopRepository (DB layer)
 * and WorkflowSopService (domain layer) + MCP tool + HTTP callback schema.
 *
 * Storage: SQLite table `workflow_sop` (see db/schema.ts:workflowSop).
 * Stage vocabulary is TEXT (not DB-constrained) so evolution doesn't need
 * migrations; service layer enforces valid values at write time.
 */

/**
 * Canonical feature lifecycle phases. Matches clowder-ai F073 P4.
 * Kept as a string union — DB stores TEXT; services validate.
 */
export type SopStage =
  | "kickoff"
  | "impl"
  | "quality_gate"
  | "review"
  | "merge"
  | "completion"

export const SOP_STAGES: readonly SopStage[] = [
  "kickoff",
  "impl",
  "quality_gate",
  "review",
  "merge",
  "completion",
]

/**
 * Check status for the four SOP gate checks. `attested` = agent claims
 * it passed without running proof; `verified` = actually re-ran/validated.
 */
export type CheckStatus = "attested" | "verified" | "unknown"

/** Resume capsule — minimal context for an agent picking up the feature. */
export interface ResumeCapsule {
  goal: string
  done: readonly string[]
  currentFocus: string
}

/** Four gate checks tracked on a WorkflowSop. */
export interface SopChecks {
  remoteMainSynced?: CheckStatus
  qualityGatePassed?: CheckStatus
  reviewApproved?: CheckStatus
  visionGuardDone?: CheckStatus
}

/** Full WorkflowSop domain object (what get/upsert return). */
export interface WorkflowSop {
  readonly backlogItemId: string
  readonly featureId: string
  readonly stage: SopStage
  readonly batonHolder: string | null
  readonly nextSkill: string | null
  readonly resumeCapsule: ResumeCapsule
  readonly checks: SopChecks
  readonly version: number
  readonly updatedAt: string
  readonly updatedBy: string
}

/**
 * Upsert input. On first call for a backlogItemId, `featureId` is required
 * (cannot be inferred). On subsequent calls, any field is optional — merges
 * into existing row. `expectedVersion` enables optimistic locking for
 * concurrent writers (MCP tool + HTTP callback racing on the same feature).
 */
export interface UpdateSopInput {
  backlogItemId: string
  featureId?: string
  stage?: SopStage
  batonHolder?: string | null
  nextSkill?: string | null
  resumeCapsule?: Partial<ResumeCapsule>
  checks?: Partial<SopChecks>
  /** If provided and doesn't match current DB version, throws OptimisticLockError. */
  expectedVersion?: number
  updatedBy: string
}
