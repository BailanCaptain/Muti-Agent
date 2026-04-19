import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { releasePorts } from "./worktree-port-registry"

const STAGING_ID_PATTERN = /^[A-Za-z0-9._\-/]+$/

export type StagingFeature = {
  featureId: string
  commitSha: string
}

export type StagingManifest = {
  stagingId: string
  baseRef: string
  visionVersion: string
  features: StagingFeature[]
}

function requireString(
  source: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const value = source[key]
  if (typeof value !== "string" || !value) {
    throw new Error(`${context} missing ${key}`)
  }
  return value
}

export function parseStagingManifest(input: unknown): StagingManifest {
  if (!input || typeof input !== "object") {
    throw new Error("manifest must be an object")
  }
  const m = input as Record<string, unknown>
  const stagingId = requireString(m, "stagingId", "manifest")
  if (!STAGING_ID_PATTERN.test(stagingId)) {
    throw new Error(
      "manifest stagingId must match [A-Za-z0-9._-/]+ (defence in depth against shell metacharacters even though execFileSync is used)",
    )
  }
  const baseRef = requireString(m, "baseRef", "manifest")
  const visionVersion = requireString(m, "visionVersion", "manifest")

  if (!Array.isArray(m.features) || m.features.length === 0) {
    throw new Error("manifest features must be a non-empty array")
  }

  const features: StagingFeature[] = m.features.map((raw, i) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`manifest features[${i}] must be an object`)
    }
    const feat = raw as Record<string, unknown>
    const featureId = requireString(feat, "featureId", `manifest features[${i}]`)
    const commitSha = requireString(feat, "commitSha", `manifest features[${i}]`)
    return { featureId, commitSha }
  })

  return { stagingId, baseRef, visionVersion, features }
}

export function buildStagingBranchName(stagingId: string): string {
  if (!stagingId) {
    throw new Error("stagingId is required")
  }
  if (stagingId.startsWith("staging/")) {
    throw new Error(
      "stagingId already starts with staging/ — pass raw id only; buildStagingBranchName adds the prefix",
    )
  }
  return `staging/${stagingId}`
}

function getMainRepoRoot(cwd: string): string {
  const commonDir = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd },
  )
    .toString()
    .trim()
  return commonDir.replace(/[/\\]\.git$/, "")
}

function getStagingWorktreeDir(mainRoot: string, stagingId: string): string {
  return path.join(path.dirname(mainRoot), `multi-agent-staging-${stagingId}`)
}

function renderReportTemplate(manifest: StagingManifest): string {
  const featureLines = manifest.features
    .map((f) => `  - ${f.featureId} @ ${f.commitSha}`)
    .join("\n")
  return [
    "# Integration Report",
    "",
    `- stagingId: ${manifest.stagingId}`,
    `- baseRef: ${manifest.baseRef}`,
    `- visionVersion: ${manifest.visionVersion}`,
    "- features:",
    featureLines,
    "",
    "## Manifest 三元组校验",
    "- [ ] featureId 列表一致",
    "- [ ] commitSha 列表一致",
    "- [ ] visionVersion 与主仓 `.agents/vision/` 当前版本一致",
    "",
    "## 验收结论",
    "<!-- 补全 PASS / BLOCKED / ESCALATE -->",
    "",
  ].join("\n")
}

export function buildCreateWorktreeArgs(input: {
  worktreeDir: string
  branch: string
  baseRef: string
}): { args: string[] } {
  return {
    args: ["worktree", "add", input.worktreeDir, "-b", input.branch, input.baseRef],
  }
}

export function buildMergeArgs(input: { commitSha: string }): { args: string[] } {
  return { args: ["merge", "--no-ff", "--no-edit", input.commitSha] }
}

export function buildDestroyWorktreeArgs(input: {
  worktreeDir: string
  branch: string
}): { removeArgs: string[]; branchDeleteArgs: string[] } {
  return {
    removeArgs: ["worktree", "remove", "--force", input.worktreeDir],
    branchDeleteArgs: ["branch", "-D", input.branch],
  }
}

function runCreate(manifestPath: string): void {
  const manifest = parseStagingManifest(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")),
  )
  const branch = buildStagingBranchName(manifest.stagingId)
  const mainRoot = getMainRepoRoot(process.cwd())
  const worktreeDir = getStagingWorktreeDir(mainRoot, manifest.stagingId)

  const createArgs = buildCreateWorktreeArgs({
    worktreeDir,
    branch,
    baseRef: manifest.baseRef,
  }).args
  execFileSync("git", createArgs, { cwd: mainRoot, stdio: "inherit" })

  for (const feature of manifest.features) {
    execFileSync("git", buildMergeArgs({ commitSha: feature.commitSha }).args, {
      cwd: worktreeDir,
      stdio: "inherit",
    })
  }

  const reportDir = path.join(
    worktreeDir,
    ".agents",
    "acceptance",
    manifest.stagingId,
    new Date().toISOString().replace(/[:.]/g, "-"),
  )
  fs.mkdirSync(reportDir, { recursive: true })
  fs.writeFileSync(
    path.join(reportDir, "integration-report.md"),
    renderReportTemplate(manifest),
  )

  console.log(
    `worktree ${branch} ready at ${worktreeDir}\n` +
      `  stagingId: ${manifest.stagingId}\n` +
      `  visionVersion: ${manifest.visionVersion}\n` +
      `  features: ${manifest.features.map((f) => `${f.featureId}@${f.commitSha}`).join(", ")}\n` +
      `  report template: ${reportDir}/integration-report.md`,
  )
}

async function runDestroy(manifestPath: string): Promise<void> {
  const manifest = parseStagingManifest(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")),
  )
  const branch = buildStagingBranchName(manifest.stagingId)
  const mainRoot = getMainRepoRoot(process.cwd())
  const worktreeDir = getStagingWorktreeDir(mainRoot, manifest.stagingId)

  const destroyArgs = buildDestroyWorktreeArgs({ worktreeDir, branch })

  try {
    execFileSync("git", destroyArgs.removeArgs, {
      cwd: mainRoot,
      stdio: "inherit",
    })
  } catch {
    // tolerate missing worktree — destroy should be idempotent
  }
  try {
    execFileSync("git", destroyArgs.branchDeleteArgs, {
      cwd: mainRoot,
      stdio: "inherit",
    })
  } catch {
    // tolerate missing branch
  }

  const registryPath = path.join(mainRoot, ".worktree-ports.json")
  if (fs.existsSync(registryPath)) {
    await releasePorts(registryPath, branch)
  }

  console.log(`staging worktree ${branch} destroyed`)
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  const here = fileURLToPath(import.meta.url)
  return path.resolve(entry) === path.resolve(here)
}

async function main(): Promise<void> {
  const [command, manifestPath] = process.argv.slice(2)
  if (!command || !manifestPath) {
    console.error("usage: worktree-staging <create|destroy> <manifest.json>")
    process.exit(2)
  }
  if (command === "create") {
    runCreate(manifestPath)
    return
  }
  if (command === "destroy") {
    await runDestroy(manifestPath)
    return
  }
  console.error(`unknown command: ${command}`)
  process.exit(2)
}

if (isMainModule()) {
  void main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
