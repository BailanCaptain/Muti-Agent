import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { scanCliDir, verifyBootstrapCoverage, verifySopNavigationQuality } from "./skill-mount-check.ts"

describe("scanCliDir — pure drift detector", () => {
  let tmpRoot: string
  let skillsDir: string
  let cliDir: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "skill-mount-"))
    skillsDir = path.join(tmpRoot, "multi-agent-skills")
    cliDir = path.join(tmpRoot, ".claude", "skills")
    mkdirSync(skillsDir, { recursive: true })
    mkdirSync(cliDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  // Helper: make a real skill dir with SKILL.md
  const makeSkill = (name: string) => {
    const dir = path.join(skillsDir, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`)
    return dir
  }

  // Helper: make a directory link in cliDir pointing at a target path.
  // Use "junction" on Windows (no admin required); on *nix Node ignores the
  // 3rd argument and creates a regular symlink either way.
  const makeLink = (name: string, target: string) => {
    symlinkSync(target, path.join(cliDir, name), "junction")
  }

  it("reports dangling-symlink as error when target directory does not exist", () => {
    const ghostTarget = path.join(skillsDir, "ghost-skill")
    makeLink("ghost-skill", ghostTarget)

    const issues = scanCliDir(cliDir, ".claude", [])

    const dangling = issues.filter((i) => i.rule === "dangling-symlink")
    assert.equal(dangling.length, 1, "should find exactly 1 dangling")
    assert.equal(dangling[0].severity, "error")
    assert.equal(dangling[0].skillName, "ghost-skill")
    assert.match(dangling[0].detail, /target missing/)
  })

  it("reports orphan-symlink as error when target exists but skill not in manifest", () => {
    const orphanDir = makeSkill("orphan")
    makeLink("orphan", orphanDir)

    const issues = scanCliDir(cliDir, ".agents", [])

    const orphan = issues.filter((i) => i.rule === "orphan-symlink")
    assert.equal(orphan.length, 1)
    assert.equal(orphan[0].severity, "error")
    assert.equal(orphan[0].skillName, "orphan")
  })

  it("reports no issue when symlink target exists and skill is in manifest", () => {
    const skillDir = makeSkill("tdd")
    makeLink("tdd", skillDir)

    const issues = scanCliDir(cliDir, ".claude", ["tdd"])

    assert.equal(issues.length, 0, `expected 0 issues, got: ${JSON.stringify(issues)}`)
  })

  it("reports symlink-missing as warning when manifest skill has no symlink", () => {
    makeSkill("tdd")

    const issues = scanCliDir(cliDir, ".gemini", ["tdd"])

    const missing = issues.filter((i) => i.rule === "symlink-missing")
    assert.equal(missing.length, 1)
    assert.equal(missing[0].severity, "warning")
    assert.equal(missing[0].skillName, "tdd")
  })

  it("returns empty array when cliDir does not exist (not an error)", () => {
    const nonExistent = path.join(tmpRoot, ".nonexistent", "skills")
    const issues = scanCliDir(nonExistent, ".nonexistent", ["tdd"])
    assert.deepEqual(issues, [])
  })

  it("distinguishes dangling vs orphan: real skill linked as itself is fine, linked by wrong name is orphan", () => {
    const realDir = makeSkill("tdd")
    // Symlink named "xyz" points at real "tdd" dir — target exists but name not in manifest
    makeLink("xyz", realDir)

    const issues = scanCliDir(cliDir, ".claude", ["tdd"])

    const dangling = issues.filter((i) => i.rule === "dangling-symlink")
    const orphan = issues.filter((i) => i.rule === "orphan-symlink")
    assert.equal(dangling.length, 0, "should not be dangling (target exists)")
    assert.equal(orphan.length, 1, "should be orphan (name not in manifest)")
    assert.equal(orphan[0].skillName, "xyz")
  })
})

describe("verifyBootstrapCoverage — BOOTSTRAP.md drift detector", () => {
  it("reports bootstrap-missing-skill error when a manifest skill is absent from BOOTSTRAP", () => {
    const bootstrap = "# Bootstrap\n\n| tdd | ... |\n"
    const issues = verifyBootstrapCoverage(bootstrap, ["tdd", "debugging"])
    const missing = issues.filter((i) => i.rule === "bootstrap-missing-skill")
    assert.equal(missing.length, 1)
    assert.equal(missing[0].severity, "error")
    assert.equal(missing[0].skillName, "debugging")
  })

  it("reports no issue when every manifest skill appears in BOOTSTRAP", () => {
    const bootstrap = "# Bootstrap\n\n| tdd | ... |\n| debugging | ... |\n"
    const issues = verifyBootstrapCoverage(bootstrap, ["tdd", "debugging"])
    assert.equal(issues.length, 0)
  })

  it("reports bootstrap-missing-file error when bootstrap content is empty", () => {
    const issues = verifyBootstrapCoverage("", ["tdd"])
    const missing = issues.filter((i) => i.rule === "bootstrap-missing-file")
    assert.equal(missing.length, 1)
    assert.equal(missing[0].severity, "error")
  })

  it("matches skill name as a whole word, not as substring of another skill", () => {
    // 'tdd' embedded in another skill name should not count as coverage
    const bootstrap = "# Bootstrap\n\n| tdd-suffixed-name | ... |\n"
    const issues = verifyBootstrapCoverage(bootstrap, ["tdd"])
    const missing = issues.filter((i) => i.rule === "bootstrap-missing-skill")
    assert.equal(missing.length, 1, "tdd as substring should not count as coverage")
  })
})

describe("verifySopNavigationQuality — manifest sop_navigation content check", () => {
  it("reports sop-empty-hard-rules error when a stage has empty hard_rules array", () => {
    const navigation = {
      tdd: { suggested_skill: "tdd", hard_rules: [], pitfalls: ["x"] },
    }
    const issues = verifySopNavigationQuality(navigation)
    const err = issues.filter((i) => i.rule === "sop-empty-hard-rules")
    assert.equal(err.length, 1)
    assert.equal(err[0].severity, "error")
    assert.equal(err[0].skillName, "tdd")
  })

  it("reports sop-empty-pitfalls error when a stage has empty pitfalls array", () => {
    const navigation = {
      tdd: { suggested_skill: "tdd", hard_rules: ["x"], pitfalls: [] },
    }
    const issues = verifySopNavigationQuality(navigation)
    const err = issues.filter((i) => i.rule === "sop-empty-pitfalls")
    assert.equal(err.length, 1)
    assert.equal(err[0].severity, "error")
  })

  it("reports sop-missing-suggested-skill error when suggested_skill is empty", () => {
    const navigation = {
      tdd: { suggested_skill: "", hard_rules: ["x"], pitfalls: ["y"] },
    }
    const issues = verifySopNavigationQuality(navigation)
    const err = issues.filter((i) => i.rule === "sop-missing-suggested-skill")
    assert.equal(err.length, 1)
  })

  it("reports no issue for a well-formed navigation", () => {
    const navigation = {
      tdd: { suggested_skill: "tdd", hard_rules: ["a", "b"], pitfalls: ["c", "d"] },
    }
    const issues = verifySopNavigationQuality(navigation)
    assert.equal(issues.length, 0)
  })

  it("handles missing fields gracefully (treats undefined as empty)", () => {
    const navigation = {
      tdd: { suggested_skill: "tdd" },  // missing hard_rules + pitfalls
    }
    const issues = verifySopNavigationQuality(navigation as never)
    const rules = issues.filter((i) => i.rule === "sop-empty-hard-rules")
    const pit = issues.filter((i) => i.rule === "sop-empty-pitfalls")
    assert.equal(rules.length, 1)
    assert.equal(pit.length, 1)
  })
})
