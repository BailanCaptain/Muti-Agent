import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { SkillRegistry } from "./registry.js"
import { SopTracker } from "./sop-tracker.js"

const MANIFEST_PATH = path.resolve(__dirname, "../../../../multi-agent-skills/manifest.yaml")

function setup() {
  const registry = new SkillRegistry()
  registry.loadManifest(MANIFEST_PATH)
  const tracker = new SopTracker()
  return { registry, tracker }
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
  const next = tracker.advance("group-1", "requesting-review", registry)
  assert.equal(next, "receiving-review")
  assert.equal(tracker.getStage("group-1"), "receiving-review")
})

test("advance returns null when skill has no next", () => {
  const { registry, tracker } = setup()
  tracker.setStage("group-1", "ask-dont-guess")
  const next = tracker.advance("group-1", "ask-dont-guess", registry)
  assert.equal(next, null)
  assert.equal(tracker.getStage("group-1"), "ask-dont-guess")
})

test("advance chains: requesting-review → receiving-review → merge-gate", () => {
  const { registry, tracker } = setup()

  tracker.setStage("group-1", "requesting-review")
  const step1 = tracker.advance("group-1", "requesting-review", registry)
  assert.equal(step1, "receiving-review")

  const step2 = tracker.advance("group-1", "receiving-review", registry)
  assert.equal(step2, "merge-gate")

  assert.equal(tracker.getStage("group-1"), "merge-gate")
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
