import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { execSync } from "node:child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = path.join(__dirname, "mount-skills.sh")

describe("mount-skills.sh — REPO_ROOT override + --prune flag", () => {
  let tmpRoot: string
  let skillsDir: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "mount-skills-"))
    skillsDir = path.join(tmpRoot, "multi-agent-skills")
    mkdirSync(skillsDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  const makeSkill = (name: string) => {
    const dir = path.join(skillsDir, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`)
    return dir
  }

  const runMount = (args: string) => {
    return execSync(`bash "${SCRIPT_PATH}" ${args}`, {
      env: { ...process.env, REPO_ROOT: tmpRoot },
      stdio: "pipe",
    }).toString()
  }

  const listSymlinks = (dir: string): string[] => {
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((name) => {
      try {
        return lstatSync(path.join(dir, name)).isSymbolicLink()
      } catch {
        return false
      }
    })
  }

  it("honors REPO_ROOT env var (mounts into tmp, not real repo)", () => {
    makeSkill("tdd")
    runMount("")
    const mounted = listSymlinks(path.join(tmpRoot, ".claude", "skills"))
    assert.ok(mounted.includes("tdd"), `expected tdd in tmp .claude/skills, got ${mounted.join(",")}`)
  })

  it("without --prune: leaves dangling symlinks alone", () => {
    makeSkill("tdd")
    // Seed a dangling symlink: target is a ghost dir in multi-agent-skills/
    const cliDir = path.join(tmpRoot, ".claude", "skills")
    mkdirSync(cliDir, { recursive: true })
    symlinkSync(path.join(skillsDir, "ghost"), path.join(cliDir, "ghost"), "junction")

    runMount("")

    const links = listSymlinks(cliDir)
    assert.ok(links.includes("ghost"), "expected ghost symlink to remain (no --prune)")
    assert.ok(links.includes("tdd"), "expected tdd symlink to be mounted")
  })

  it("with --prune: removes dangling symlinks in all three CLI dirs", () => {
    makeSkill("tdd")
    // Seed dangling in all three mount points
    for (const cliName of [".claude", ".agents", ".gemini"]) {
      const cliDir = path.join(tmpRoot, cliName, "skills")
      mkdirSync(cliDir, { recursive: true })
      symlinkSync(
        path.join(skillsDir, "ghost"),
        path.join(cliDir, "ghost"),
        "junction",
      )
    }

    runMount("--prune")

    for (const cliName of [".claude", ".agents", ".gemini"]) {
      const cliDir = path.join(tmpRoot, cliName, "skills")
      const links = listSymlinks(cliDir)
      assert.ok(
        !links.includes("ghost"),
        `expected ghost pruned from ${cliName}, got: ${links.join(",")}`,
      )
      assert.ok(
        links.includes("tdd"),
        `expected tdd still mounted in ${cliName}`,
      )
    }
  })

  it("with --prune: reports pruned count in stdout", () => {
    makeSkill("tdd")
    for (const cliName of [".claude", ".agents", ".gemini"]) {
      const cliDir = path.join(tmpRoot, cliName, "skills")
      mkdirSync(cliDir, { recursive: true })
      symlinkSync(
        path.join(skillsDir, "ghost"),
        path.join(cliDir, "ghost"),
        "junction",
      )
    }

    const out = runMount("--prune")
    assert.match(out, /pruned/, `stdout should mention 'pruned', got: ${out}`)
    assert.match(out, /3 pruned/, `expected '3 pruned', got: ${out}`)
  })

  it("with --prune: does NOT remove valid (non-dangling) symlinks", () => {
    makeSkill("tdd")
    makeSkill("debugging")

    runMount("--prune")

    const links = listSymlinks(path.join(tmpRoot, ".claude", "skills"))
    assert.ok(links.includes("tdd"))
    assert.ok(links.includes("debugging"))
  })

  it("prune is idempotent (running twice produces same state)", () => {
    makeSkill("tdd")
    const cliDir = path.join(tmpRoot, ".claude", "skills")
    mkdirSync(cliDir, { recursive: true })
    symlinkSync(path.join(skillsDir, "ghost"), path.join(cliDir, "ghost"), "junction")

    runMount("--prune")
    const first = listSymlinks(cliDir).sort()
    runMount("--prune")
    const second = listSymlinks(cliDir).sort()
    assert.deepEqual(second, first)
  })
})
