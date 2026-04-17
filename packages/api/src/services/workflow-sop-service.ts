/**
 * F019: WorkflowSopService — 告示牌 (bulletin board) 引擎 service layer.
 *
 * Thin domain layer around DrizzleWorkflowSopRepository:
 * - Validates stage vocabulary (SOP_STAGES enum) before writes.
 * - Provides buildHint() — produces the one-line sopStageHint that
 *   agent-prompts.ts injects into every CLI invocation when a thread is
 *   bound to a feature (Task 3.1 / 3.2 consumer).
 *
 * Does NOT:
 * - Own caching — repo is fast enough; decorator can wrap later if needed.
 * - Emit events — caller decides whether to broadcast.
 * - Talk to HTTP/MCP — those layers call into this service.
 */

import type { DrizzleWorkflowSopRepository } from "../db/repositories/workflow-sop-repository"
import {
  SOP_STAGES,
  type CheckStatus,
  type ResumeCapsule,
  type SopChecks,
  type SopStage,
  type UpdateSopInput,
  type WorkflowSop,
} from "./workflow-sop-types"

/**
 * F019 review-P2 (Codex Finding 3): thrown when input validation fails.
 * The HTTP callback + MCP tool layers map this to 400 so callers get
 * actionable rejection messages instead of opaque 500s.
 */
export class WorkflowSopValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkflowSopValidationError"
  }
}

const VALID_CHECK_STATUSES: readonly CheckStatus[] = ["attested", "verified", "unknown"]
const VALID_CHECK_KEYS = new Set([
  "remoteMainSynced",
  "qualityGatePassed",
  "reviewApproved",
  "visionGuardDone",
])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * Validate + normalize an untrusted body into a UpdateSopInput. Trims
 * whitespace around backlogItemId/featureId; rejects malformed shapes.
 * Throws WorkflowSopValidationError with a human-readable reason on failure.
 *
 * Exported for direct use by HTTP/MCP route handlers so validation happens
 * ONCE at the boundary — the repo/DB layer trusts its input.
 */
export function validateUpdateSopBody(raw: unknown): UpdateSopInput {
  if (!isPlainObject(raw)) {
    throw new WorkflowSopValidationError("request body must be an object")
  }

  // backlogItemId: required, trim, non-empty
  const rawBacklog = raw.backlogItemId
  if (typeof rawBacklog !== "string") {
    throw new WorkflowSopValidationError("backlogItemId is required (string)")
  }
  const backlogItemId = rawBacklog.trim()
  if (!backlogItemId) {
    throw new WorkflowSopValidationError(
      "backlogItemId must be a non-empty, non-whitespace string",
    )
  }

  // featureId: optional, trim, non-empty if present
  let featureId: string | undefined
  if (raw.featureId !== undefined) {
    if (typeof raw.featureId !== "string") {
      throw new WorkflowSopValidationError("featureId must be a string when provided")
    }
    const trimmed = raw.featureId.trim()
    if (!trimmed) {
      throw new WorkflowSopValidationError("featureId must not be empty/whitespace when provided")
    }
    featureId = trimmed
  }

  // stage: optional, must be in enum
  let stage: SopStage | undefined
  if (raw.stage !== undefined) {
    if (typeof raw.stage !== "string" || !SOP_STAGES.includes(raw.stage as SopStage)) {
      throw new WorkflowSopValidationError(
        `invalid stage: "${String(raw.stage)}" (allowed: ${SOP_STAGES.join(", ")})`,
      )
    }
    stage = raw.stage as SopStage
  }

  // batonHolder / nextSkill: optional, string | null
  const strNullable = (field: string, value: unknown): string | null | undefined => {
    if (value === undefined) return undefined
    if (value === null) return null
    if (typeof value === "string") return value
    throw new WorkflowSopValidationError(`${field} must be a string or null`)
  }
  const batonHolder = strNullable("batonHolder", raw.batonHolder)
  const nextSkill = strNullable("nextSkill", raw.nextSkill)

  // resumeCapsule: optional, partial { goal: string?, done: string[]?, currentFocus: string? }
  let resumeCapsule: Partial<ResumeCapsule> | undefined
  if (raw.resumeCapsule !== undefined) {
    if (!isPlainObject(raw.resumeCapsule)) {
      throw new WorkflowSopValidationError("resumeCapsule must be an object when provided")
    }
    const cap: Partial<ResumeCapsule> = {}
    const rc = raw.resumeCapsule
    if (rc.goal !== undefined) {
      if (typeof rc.goal !== "string") {
        throw new WorkflowSopValidationError("resumeCapsule.goal must be a string")
      }
      cap.goal = rc.goal
    }
    if (rc.done !== undefined) {
      if (!Array.isArray(rc.done) || !rc.done.every((x) => typeof x === "string")) {
        throw new WorkflowSopValidationError("resumeCapsule.done must be an array of strings")
      }
      cap.done = rc.done as string[]
    }
    if (rc.currentFocus !== undefined) {
      if (typeof rc.currentFocus !== "string") {
        throw new WorkflowSopValidationError("resumeCapsule.currentFocus must be a string")
      }
      cap.currentFocus = rc.currentFocus
    }
    // Reject extraneous keys — defensive against typo ("dome" for "done")
    for (const k of Object.keys(rc)) {
      if (!["goal", "done", "currentFocus"].includes(k)) {
        throw new WorkflowSopValidationError(`resumeCapsule has unknown key "${k}"`)
      }
    }
    resumeCapsule = cap
  }

  // checks: optional, each key in VALID_CHECK_KEYS, each value in VALID_CHECK_STATUSES
  let checks: Partial<SopChecks> | undefined
  if (raw.checks !== undefined) {
    if (!isPlainObject(raw.checks)) {
      throw new WorkflowSopValidationError("checks must be an object when provided")
    }
    const c: Partial<SopChecks> = {}
    for (const [k, v] of Object.entries(raw.checks)) {
      if (!VALID_CHECK_KEYS.has(k)) {
        throw new WorkflowSopValidationError(
          `checks has unknown key "${k}" (allowed: ${[...VALID_CHECK_KEYS].join(", ")})`,
        )
      }
      if (typeof v !== "string" || !VALID_CHECK_STATUSES.includes(v as CheckStatus)) {
        throw new WorkflowSopValidationError(
          `checks.${k} must be one of ${VALID_CHECK_STATUSES.join(", ")}, got ${JSON.stringify(v)}`,
        )
      }
      ;(c as Record<string, CheckStatus>)[k] = v as CheckStatus
    }
    checks = c
  }

  // expectedVersion: optional, non-negative integer
  let expectedVersion: number | undefined
  if (raw.expectedVersion !== undefined) {
    if (
      typeof raw.expectedVersion !== "number" ||
      !Number.isInteger(raw.expectedVersion) ||
      raw.expectedVersion < 0
    ) {
      throw new WorkflowSopValidationError(
        `expectedVersion must be a non-negative integer, got ${JSON.stringify(raw.expectedVersion)}`,
      )
    }
    expectedVersion = raw.expectedVersion
  }

  // updatedBy: required (caller is responsible for supplying this from auth)
  if (typeof raw.updatedBy !== "string" || !raw.updatedBy.trim()) {
    throw new WorkflowSopValidationError("updatedBy is required (non-empty string)")
  }

  return {
    backlogItemId,
    ...(featureId !== undefined ? { featureId } : {}),
    ...(stage !== undefined ? { stage } : {}),
    ...(batonHolder !== undefined ? { batonHolder } : {}),
    ...(nextSkill !== undefined ? { nextSkill } : {}),
    ...(resumeCapsule !== undefined ? { resumeCapsule } : {}),
    ...(checks !== undefined ? { checks } : {}),
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    updatedBy: raw.updatedBy.trim(),
  }
}

export class WorkflowSopService {
  constructor(private readonly repo: DrizzleWorkflowSopRepository) {}

  get(backlogItemId: string): WorkflowSop | null {
    return this.repo.get(backlogItemId)
  }

  upsert(input: UpdateSopInput): WorkflowSop {
    if (input.stage !== undefined && !SOP_STAGES.includes(input.stage)) {
      throw new WorkflowSopValidationError(
        `invalid stage: "${input.stage}" (allowed: ${SOP_STAGES.join(", ")})`,
      )
    }
    return this.repo.upsert(input)
  }

  delete(backlogItemId: string): void {
    this.repo.delete(backlogItemId)
  }

  /**
   * Build the告示牌 one-liner injected into system prompt.
   *
   * Format: `SOP: {featureId} stage={stage} → load skill: {nextSkill}`
   * (suffix omitted when nextSkill is null/empty)
   *
   * Returns null when:
   * - backlogItemId is null/undefined/empty (thread not bound to a feature)
   * - no workflow_sop row exists for this backlogItemId
   */
  buildHint(backlogItemId: string | null | undefined): string | null {
    if (!backlogItemId) return null
    const sop = this.repo.get(backlogItemId)
    if (!sop) return null
    const suffix = sop.nextSkill ? ` → load skill: ${sop.nextSkill}` : ""
    return `SOP: ${sop.featureId} stage=${sop.stage}${suffix}`
  }
}
