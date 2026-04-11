import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { SkillRegistry } from "./registry.js"

function withTempManifest(yaml: string, fn: (manifestPath: string) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), "f003-registry-"))
  const manifestPath = path.join(dir, "manifest.yaml")
  writeFileSync(manifestPath, yaml, "utf-8")
  try {
    fn(manifestPath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const YAML_WITH_NEXT_DISPATCH = `
skills:
  quality-gate:
    description: "自检门禁"
    triggers: ["quality-gate"]
    next: ["requesting-review"]
    next_dispatch:
      target: "reviewer"
      prompt_template: "@%TARGET% 请 review PR #%PR%"
  requesting-review:
    description: "请 review"
    triggers: ["requesting-review"]
  plain-skill:
    description: "no dispatch"
    triggers: ["plain"]
    next: ["quality-gate"]
`

test("getNextDispatch returns parsed dispatch for skill with next_dispatch", () => {
  withTempManifest(YAML_WITH_NEXT_DISPATCH, (manifestPath) => {
    const registry = new SkillRegistry()
    registry.loadManifest(manifestPath)
    const dispatch = registry.getNextDispatch("quality-gate")
    assert.ok(dispatch, "quality-gate should have a nextDispatch")
    assert.equal(dispatch.target, "reviewer")
    assert.equal(dispatch.promptTemplate, "@%TARGET% 请 review PR #%PR%")
  })
})

test("getNextDispatch returns null for skill without next_dispatch", () => {
  withTempManifest(YAML_WITH_NEXT_DISPATCH, (manifestPath) => {
    const registry = new SkillRegistry()
    registry.loadManifest(manifestPath)
    assert.equal(registry.getNextDispatch("plain-skill"), null)
  })
})

test("getNextDispatch returns null for unknown skill", () => {
  withTempManifest(YAML_WITH_NEXT_DISPATCH, (manifestPath) => {
    const registry = new SkillRegistry()
    registry.loadManifest(manifestPath)
    assert.equal(registry.getNextDispatch("nonexistent"), null)
  })
})

test("SkillMeta.nextDispatch is exposed on getSkill result", () => {
  withTempManifest(YAML_WITH_NEXT_DISPATCH, (manifestPath) => {
    const registry = new SkillRegistry()
    registry.loadManifest(manifestPath)
    const skill = registry.getSkill("quality-gate")
    assert.ok(skill)
    assert.ok(skill.nextDispatch)
    assert.equal(skill.nextDispatch.target, "reviewer")
  })
})

test("skill with no next_dispatch has nextDispatch=null on SkillMeta", () => {
  withTempManifest(YAML_WITH_NEXT_DISPATCH, (manifestPath) => {
    const registry = new SkillRegistry()
    registry.loadManifest(manifestPath)
    const skill = registry.getSkill("plain-skill")
    assert.ok(skill)
    assert.equal(skill.nextDispatch, null)
  })
})
