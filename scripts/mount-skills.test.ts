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

  // Guards the batched (per-directory) reparse-point detection: on a re-run
  // where every skill is already mounted, the batched cache must recognize all
  // pre-existing junctions as unchanged — mounting nothing, pruning nothing.
  // (This is the hot path that took ~87s with per-path powershell spawns.)
  it("re-mount with many skills: all recognized as unchanged (batched detection)", () => {
    const names = ["tdd", "debugging", "merge-gate", "worktree", "quality-gate", "feat-lifecycle"]
    for (const n of names) makeSkill(n)

    runMount("--prune") // first run mounts all
    const out = runMount("--prune") // second run: everything already mounted

    assert.match(out, /0 mounted/, `2nd run should mount nothing, got: ${out}`)
    assert.match(out, /0 pruned/, `2nd run should prune nothing, got: ${out}`)
    for (const cliName of [".claude", ".agents", ".gemini"]) {
      const links = listSymlinks(path.join(tmpRoot, cliName, "skills"))
      for (const n of names) {
        assert.ok(
          links.includes(n),
          `expected ${n} still mounted in ${cliName}, got: ${links.join(",")}`,
        )
      }
    }
  })

  // Exact-membership guard (codex review P2-2): a junction whose name contains a
  // space ("alpha beta") must NOT word-substring-match a different skill ("beta").
  // With the old space-packed membership, "beta" matched " alpha beta " and a
  // plain-copy "beta" was wrongly left untouched instead of becoming a junction.
  it("space-named junction does not false-match a substring skill name", () => {
    makeSkill("alpha beta") // source exists; will be a junction in cache
    makeSkill("beta") // source exists

    const cliDir = path.join(tmpRoot, ".claude", "skills")
    mkdirSync(cliDir, { recursive: true })
    // Pre-seed "alpha beta" as a real junction (so the dir cache contains it)…
    symlinkSync(path.join(skillsDir, "alpha beta"), path.join(cliDir, "alpha beta"), "junction")
    // …and "beta" as a PLAIN COPY with SKILL.md (the masquerade the bug missed).
    mkdirSync(path.join(cliDir, "beta"), { recursive: true })
    writeFileSync(path.join(cliDir, "beta", "SKILL.md"), "---\nname: beta\n---\n")

    runMount("")

    // beta must be converted to a junction (plain copy replaced), not kept as-is.
    assert.ok(
      lstatSync(path.join(cliDir, "beta")).isSymbolicLink(),
      "beta should be a junction (plain copy replaced), not left as a directory copy",
    )
  })
})
