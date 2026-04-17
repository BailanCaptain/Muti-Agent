/**
 * skill-mount-check.ts — Pure drift detector for skill symlink mount dirs.
 *
 * Used by scripts/check-skills.ts. Given a CLI mount dir (.claude/skills /
 * .agents/skills / .gemini/skills) and the list of skill names declared in
 * manifest.yaml, returns structured issues:
 *
 * - dangling-symlink (error): symlink → non-existent target
 * - orphan-symlink   (error): symlink target exists but skill not in manifest
 * - symlink-missing  (warning): manifest skill has no symlink in this dir
 * - symlink-type     (warning): entry exists but is not a symlink
 *
 * Pure function; no process.exit, no console side effects. Test from a
 * tmp dir via fs primitives — no subprocess / cwd magic needed.
 */

import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs"
import path from "node:path"

export type MountIssueRule =
  | "dangling-symlink"
  | "orphan-symlink"
  | "symlink-missing"
  | "symlink-type"
  | "bootstrap-missing-file"
  | "bootstrap-missing-skill"
  | "sop-empty-hard-rules"
  | "sop-empty-pitfalls"
  | "sop-missing-suggested-skill"

export type MountIssueSeverity = "error" | "warning"

export interface MountIssue {
  rule: MountIssueRule
  severity: MountIssueSeverity
  cliLabel: string // e.g. ".claude" | ".agents" | ".gemini"
  skillName: string
  detail: string
}

export function scanCliDir(
  cliDir: string,
  cliLabel: string,
  manifestSkillNames: readonly string[],
): MountIssue[] {
  const issues: MountIssue[] = []
  if (!existsSync(cliDir)) return issues

  // Phase 1: Every manifest skill should have a symlink pointing at its source
  for (const name of manifestSkillNames) {
    const linkPath = path.join(cliDir, name)
    if (!existsSync(linkPath)) {
      issues.push({
        rule: "symlink-missing",
        severity: "warning",
        cliLabel,
        skillName: name,
        detail: `${cliLabel}/skills/${name} missing (run pnpm mount-skills)`,
      })
      continue
    }
    const stat = lstatSync(linkPath)
    if (!stat.isSymbolicLink()) {
      issues.push({
        rule: "symlink-type",
        severity: "warning",
        cliLabel,
        skillName: name,
        detail: `${cliLabel}/skills/${name} is not a symlink`,
      })
    }
  }

  // Phase 2: Every entry in cliDir should trace back to a manifest skill
  for (const entry of readdirSync(cliDir, { withFileTypes: true })) {
    const linkPath = path.join(cliDir, entry.name)
    const stat = lstatSync(linkPath)
    if (!stat.isSymbolicLink()) continue

    const target = readlinkSync(linkPath)
    const resolvedTarget = path.isAbsolute(target)
      ? target
      : path.resolve(path.dirname(linkPath), target)

    if (!existsSync(resolvedTarget)) {
      issues.push({
        rule: "dangling-symlink",
        severity: "error",
        cliLabel,
        skillName: entry.name,
        detail: `${cliLabel}/skills/${entry.name} → ${target} (target missing; run pnpm mount-skills:prune)`,
      })
      continue
    }

    if (!manifestSkillNames.includes(entry.name)) {
      issues.push({
        rule: "orphan-symlink",
        severity: "error",
        cliLabel,
        skillName: entry.name,
        detail: `${cliLabel}/skills/${entry.name}: symlink exists but skill not in manifest`,
      })
    }
  }

  return issues
}

/**
 * Verify that every skill declared in the manifest appears (as a whole word /
 * cell token) inside BOOTSTRAP.md. Enforces the F019 thesis: manifest = single
 * source of truth; BOOTSTRAP.md must stay in sync.
 *
 * Matching rule: the skill name must appear flanked by non-word boundaries on
 * BOTH sides (not as a substring of some longer identifier). E.g. "tdd" inside
 * "feat-lifecycle-tdd-xyz" does NOT count.
 *
 * Word boundary for skill names: chars that are NOT letters, digits, dashes,
 * or underscores (skill names use kebab-case like "cross-role-handoff").
 */
export function verifyBootstrapCoverage(
  bootstrapContent: string,
  manifestSkillNames: readonly string[],
): MountIssue[] {
  const issues: MountIssue[] = []

  if (!bootstrapContent.trim()) {
    issues.push({
      rule: "bootstrap-missing-file",
      severity: "error",
      cliLabel: "bootstrap",
      skillName: "",
      detail: "multi-agent-skills/BOOTSTRAP.md missing or empty",
    })
    return issues
  }

  for (const name of manifestSkillNames) {
    // Escape regex meta chars in skill names (defensive — our names are
    // kebab-case so only "-" matters; "\-" is harmless anywhere in a class).
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    // Match name with non-[\w-] on both sides (so "tdd" is NOT inside "x-tdd-y")
    const pattern = new RegExp(`(^|[^\\w-])${escaped}([^\\w-]|$)`)
    if (!pattern.test(bootstrapContent)) {
      issues.push({
        rule: "bootstrap-missing-skill",
        severity: "error",
        cliLabel: "bootstrap",
        skillName: name,
        detail: `BOOTSTRAP.md does not cover skill "${name}" (add a row to the skills table)`,
      })
    }
  }

  return issues
}

export interface SopNavigationEntry {
  suggested_skill?: string
  hard_rules?: readonly string[]
  pitfalls?: readonly string[]
}

/**
 * Enforce sop_navigation content quality: each stage entry must have a
 * non-empty `suggested_skill` + at least one `hard_rules` item + at least
 * one `pitfalls` item. Empty arrays are silent drift — they skip checks
 * without any signal — so we flag them as error.
 *
 * Consumed by F019 P3 sopStageHint injection (plan: docs/plans/F019-*)
 * to drive the one-line "SOP: Fxxx stage=Y → load skill: Z" plus optional
 * rule/pitfall enrichment.
 */
export function verifySopNavigationQuality(
  navigation: Readonly<Record<string, SopNavigationEntry>>,
): MountIssue[] {
  const issues: MountIssue[] = []
  for (const [stage, entry] of Object.entries(navigation)) {
    if (!entry.suggested_skill || !entry.suggested_skill.trim()) {
      issues.push({
        rule: "sop-missing-suggested-skill",
        severity: "error",
        cliLabel: "sop_navigation",
        skillName: stage,
        detail: `sop_navigation['${stage}']: suggested_skill is empty`,
      })
    }
    if (!entry.hard_rules || entry.hard_rules.length === 0) {
      issues.push({
        rule: "sop-empty-hard-rules",
        severity: "error",
        cliLabel: "sop_navigation",
        skillName: stage,
        detail: `sop_navigation['${stage}']: hard_rules is empty (add at least one rule)`,
      })
    }
    if (!entry.pitfalls || entry.pitfalls.length === 0) {
      issues.push({
        rule: "sop-empty-pitfalls",
        severity: "error",
        cliLabel: "sop_navigation",
        skillName: stage,
        detail: `sop_navigation['${stage}']: pitfalls is empty (add at least one pitfall)`,
      })
    }
  }
  return issues
}
