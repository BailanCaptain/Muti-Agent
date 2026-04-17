#!/usr/bin/env npx tsx
/**
 * check-skills.ts — 校验 manifest.yaml 与 SKILL.md 一致性 + symlink 完整性
 *
 * Usage: npx tsx scripts/check-skills.ts
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"
import { scanCliDir, verifyBootstrapCoverage, verifySopNavigationQuality } from "./skill-mount-check.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
const SKILLS_DIR = path.join(REPO_ROOT, "multi-agent-skills")
const MANIFEST_PATH = path.join(SKILLS_DIR, "manifest.yaml")

const CLI_DIRS = [
  path.join(REPO_ROOT, ".claude", "skills"),
  path.join(REPO_ROOT, ".gemini", "skills"),
  path.join(REPO_ROOT, ".agents", "skills"),
]

type LintError = { rule: string; detail: string }
const errors: LintError[] = []
const warnings: LintError[] = []

// ── Load manifest ────────────────────────────────────────────────────

if (!existsSync(MANIFEST_PATH)) {
  errors.push({ rule: "manifest-exists", detail: "manifest.yaml not found" })
  report()
  process.exit(1)
}

const doc = parseYaml(readFileSync(MANIFEST_PATH, "utf-8")) as {
  skills?: Record<string, Record<string, unknown>>
  sop_navigation?: Record<string, { suggested_skill?: string; hard_rules?: string[]; pitfalls?: string[] }>
}

const skills = doc.skills ?? {}
const skillNames = Object.keys(skills)
const sopNavigation = doc.sop_navigation ?? {}

// ── Check each skill in manifest ─────────────────────────────────────

const allSlashNames = new Set<string>()

for (const name of skillNames) {
  const entry = skills[name] as Record<string, unknown>

  // has-skill-md
  const skillMdPath = path.join(SKILLS_DIR, name, "SKILL.md")
  if (!existsSync(skillMdPath)) {
    errors.push({ rule: "has-skill-md", detail: `${name}: SKILL.md not found` })
  } else {
    // Verify frontmatter name matches directory
    const content = readFileSync(skillMdPath, "utf-8")
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
    if (fmMatch) {
      const fm = parseYaml(fmMatch[1]) as { name?: string }
      if (fm.name && fm.name !== name) {
        warnings.push({ rule: "name-mismatch", detail: `${name}: SKILL.md name="${fm.name}" differs from directory name` })
      }
    }
  }

  // has-description
  if (!entry.description || !(entry.description as string).trim()) {
    errors.push({ rule: "has-description", detail: `${name}: description is empty` })
  }

  // has-triggers
  const triggers = entry.triggers as string[] | undefined
  if (!triggers || !triggers.length) {
    errors.push({ rule: "has-triggers", detail: `${name}: triggers is empty` })
  }

  // next-exists
  const next = (entry.next ?? []) as string[]
  for (const n of next) {
    if (!skillNames.includes(n)) {
      warnings.push({ rule: "next-exists", detail: `${name}: next references "${n}" which is not in manifest` })
    }
  }

  // agents-valid
  const agents = (entry.agents ?? []) as string[]
  for (const a of agents) {
    if (!["claude", "codex", "gemini"].includes(a)) {
      errors.push({ rule: "agents-valid", detail: `${name}: invalid agent "${a}"` })
    }
  }

  // slash-unique
  const cmds = (entry.slashCommands ?? []) as Array<{ name: string }>
  for (const cmd of cmds) {
    const lower = cmd.name.toLowerCase()
    if (allSlashNames.has(lower)) {
      errors.push({ rule: "slash-unique", detail: `${name}: duplicate slash command "${cmd.name}"` })
    }
    allSlashNames.add(lower)
  }
}

// ── Check orphan skill directories ───────────────────────────────────

for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  if (!skillNames.includes(entry.name)) {
    warnings.push({ rule: "orphan-dir", detail: `${entry.name}: directory exists but not in manifest` })
  }
}

// ── Check symlinks (drift detection via scanCliDir) ──────────────────

for (const cliDir of CLI_DIRS) {
  const cliLabel = path.basename(path.dirname(cliDir)) // .claude, .gemini, .agents
  if (!existsSync(cliDir)) {
    warnings.push({ rule: "symlink", detail: `${cliLabel}/skills/ directory does not exist` })
    continue
  }
  const issues = scanCliDir(cliDir, cliLabel, skillNames)
  for (const iss of issues) {
    const bucket = iss.severity === "error" ? errors : warnings
    bucket.push({ rule: iss.rule, detail: iss.detail })
  }
}

// ── Check BOOTSTRAP.md coverage (manifest single truth source) ───────

const BOOTSTRAP_PATH = path.join(SKILLS_DIR, "BOOTSTRAP.md")
const bootstrapContent = existsSync(BOOTSTRAP_PATH) ? readFileSync(BOOTSTRAP_PATH, "utf-8") : ""
for (const iss of verifyBootstrapCoverage(bootstrapContent, skillNames)) {
  const bucket = iss.severity === "error" ? errors : warnings
  bucket.push({ rule: iss.rule, detail: iss.detail })
}

// ── Check sop_navigation content quality ─────────────────────────────

for (const iss of verifySopNavigationQuality(sopNavigation)) {
  const bucket = iss.severity === "error" ? errors : warnings
  bucket.push({ rule: iss.rule, detail: iss.detail })
}

// ── Report ───────────────────────────────────────────────────────────

function report() {
  if (warnings.length) {
    console.log("\n⚠️  Warnings:")
    for (const w of warnings) {
      console.log(`  [${w.rule}] ${w.detail}`)
    }
  }

  if (errors.length) {
    console.log("\n❌ Errors:")
    for (const e of errors) {
      console.log(`  [${e.rule}] ${e.detail}`)
    }
    console.log(`\nFAILED: ${errors.length} error(s), ${warnings.length} warning(s)`)
  } else {
    console.log(`\n✅ PASSED: 0 errors, ${warnings.length} warning(s)`)
  }
}

report()
process.exit(errors.length > 0 ? 1 : 0)
