import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import os from "node:os"
import { SkillRegistry } from "./registry.js"
import { SopTracker } from "./sop-tracker.js"

const MANIFEST_PATH = path.resolve(__dirname, "../../../../multi-agent-skills/manifest.yaml")

function setup() {
  const registry = new SkillRegistry()
  registry.loadManifest(MANIFEST_PATH)
  const tracker = new SopTracker()
  return { registry, tracker }
}

function setupWithDispatchManifest() {
  const yaml = `
skills:
  quality-gate:
    description: "自检"
    triggers: ["quality-gate"]
    next: ["requesting-review"]
    next_dispatch:
      target: "reviewer"
      prompt_template: "@%TARGET% 请 review"
  requesting-review:
    description: "请 review"
    triggers: ["requesting-review"]
`
  const dir = mkdtempSync(path.join(os.tmpdir(), "f003-sop-"))
  const manifestPath = path.join(dir, "manifest.yaml")
  writeFileSync(manifestPath, yaml, "utf-8")
  const registry = new SkillRegistry()
  registry.loadManifest(manifestPath)
  const tracker = new SopTracker()
  return { registry, tracker, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test("getStage returns null for unknown session", () => {
  const { tracker } = setup()
  assert.equal(tracker.getStage("unknown"), null)
})

test("setStage and getStage round-trip", () => {
  const { tracker } = setup()
  tracker.setStage("group-1", "tdd")
  assert.equal(tracker.getStage("group-1"), "tdd")
})

test("advance moves to next stage based on skill next chain", () => {
  const { registry, tracker } = setup()
  tracker.setStage("group-1", "requesting-review")
  const advancement = tracker.advance("group-1", "requesting-review", registry)
  assert.ok(advancement)
  assert.equal(advancement.nextStage, "receiving-review")
  assert.equal(tracker.getStage("group-1"), "receiving-review")
})

test("advance returns null when skill has no next", () => {
  const { registry, tracker } = setup()
  tracker.setStage("group-1", "self-evolution")
  const advancement = tracker.advance("group-1", "self-evolution", registry)
  assert.equal(advancement, null)
  assert.equal(tracker.getStage("group-1"), "self-evolution")
})

test("advance chains: requesting-review → receiving-review → merge-gate", () => {
  const { registry, tracker } = setup()

  tracker.setStage("group-1", "requesting-review")
  const step1 = tracker.advance("group-1", "requesting-review", registry)
  assert.ok(step1)
  assert.equal(step1.nextStage, "receiving-review")

  const step2 = tracker.advance("group-1", "receiving-review", registry)
  assert.ok(step2)
  assert.equal(step2.nextStage, "merge-gate")

  assert.equal(tracker.getStage("group-1"), "merge-gate")
})

test("advance propagates nextDispatch from the completed skill's manifest entry", () => {
  const { registry, tracker, cleanup } = setupWithDispatchManifest()
  try {
    tracker.setStage("group-1", "quality-gate")
    const advancement = tracker.advance("group-1", "quality-gate", registry)
    assert.ok(advancement)
    assert.equal(advancement.nextStage, "requesting-review")
    assert.ok(advancement.nextDispatch)
    assert.equal(advancement.nextDispatch.target, "reviewer")
    assert.equal(advancement.nextDispatch.promptTemplate, "@%TARGET% 请 review")
  } finally {
    cleanup()
  }
})

test("advance nextDispatch is null when the completed skill has no next_dispatch", () => {
  const { registry, tracker } = setup()
  // merge-gate → feat-lifecycle in the real manifest, and merge-gate itself
  // has no next_dispatch (no cross-agent hand-off needed after merge).
  tracker.setStage("group-1", "merge-gate")
  const advancement = tracker.advance("group-1", "merge-gate", registry)
  assert.ok(advancement)
  assert.equal(advancement.nextDispatch, null)
})

test("clear removes stage", () => {
  const { tracker } = setup()
  tracker.setStage("group-1", "tdd")
  tracker.clear("group-1")
  assert.equal(tracker.getStage("group-1"), null)
})

test("different session groups are independent", () => {
  const { tracker } = setup()
  tracker.setStage("group-1", "tdd")
  tracker.setStage("group-2", "merge-gate")
  assert.equal(tracker.getStage("group-1"), "tdd")
  assert.equal(tracker.getStage("group-2"), "merge-gate")
})
