import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { SkillRegistry } from "./registry.js"

const MANIFEST_PATH = path.resolve(__dirname, "../../../../multi-agent-skills/manifest.yaml")
const SKILLS_DIR = path.resolve(__dirname, "../../../../multi-agent-skills")

function loadedRegistry(): SkillRegistry {
  const registry = new SkillRegistry()
  registry.loadManifest(MANIFEST_PATH)
  return registry
}

// ── loadManifest ─────────────────────────────────────────────────────

test("loadManifest loads all 8 skills", () => {
  const registry = loadedRegistry()
  assert.equal(registry.allSkills().length, 8)
})

test("loadManifest loads sop_navigation stages", () => {
  const registry = loadedRegistry()
  assert.ok(registry.getSopStage("merge-gate"), "merge-gate stage should exist")
  assert.ok(registry.getSopStage("tdd"), "tdd stage should exist")
})

// ── match — trigger 匹配 ────────────────────────────────────────────

test("match finds hardline-review for '帮我 review 一下这段代码'", () => {
  const registry = loadedRegistry()
  const results = registry.match("帮我 review 一下这段代码")
  const names = results.map((r) => r.skill.name)
  assert.ok(names.includes("hardline-review"), `Expected hardline-review, got: ${names}`)
})

test("match finds requesting-review for '请 review'", () => {
  const registry = loadedRegistry()
  const results = registry.match("请 review 一下我的实现")
  const names = results.map((r) => r.skill.name)
  assert.ok(names.includes("requesting-review"), `Expected requesting-review, got: ${names}`)
})

test("match finds merge-approval-gate for '准备合入'", () => {
  const registry = loadedRegistry()
  const results = registry.match("代码改好了，准备合入")
  const names = results.map((r) => r.skill.name)
  assert.ok(names.includes("merge-approval-gate"), `Expected merge-approval-gate, got: ${names}`)
})

// ── match — not_for 排除 ────────────────────────────────────────────

test("match excludes hardline-review when content contains '请 review'", () => {
  const registry = loadedRegistry()
  const results = registry.match("请 review 一下我的代码")
  const names = results.map((r) => r.skill.name)
  assert.ok(!names.includes("hardline-review"), `hardline-review should be excluded by not_for, got: ${names}`)
})

test("match excludes requesting-review when content contains 'review 意见'", () => {
  const registry = loadedRegistry()
  const results = registry.match("收到了 review 意见，准备修复")
  const names = results.map((r) => r.skill.name)
  assert.ok(!names.includes("requesting-review"), `requesting-review should be excluded, got: ${names}`)
  assert.ok(names.includes("receiving-review"), `receiving-review should match, got: ${names}`)
})

// ── match — per-agent 过滤 ──────────────────────────────────────────

test("match filters by provider", () => {
  const registry = loadedRegistry()
  const results = registry.match("准备合入", "claude")
  assert.ok(results.length > 0, "Should match for claude")
})

test("match returns empty for non-matching content", () => {
  const registry = loadedRegistry()
  const results = registry.match("今天天气真好")
  assert.equal(results.length, 0)
})

// ── matchSlashCommand ────────────────────────────────────────────────

test("matchSlashCommand matches /review", () => {
  const registry = loadedRegistry()
  const skill = registry.matchSlashCommand("/review 这段代码")
  assert.ok(skill, "Should match /review")
  assert.equal(skill.name, "hardline-review")
})

test("matchSlashCommand matches /merge", () => {
  const registry = loadedRegistry()
  const skill = registry.matchSlashCommand("/merge")
  assert.ok(skill, "Should match /merge")
  assert.equal(skill.name, "merge-approval-gate")
})

test("matchSlashCommand matches /feat", () => {
  const registry = loadedRegistry()
  const skill = registry.matchSlashCommand("/feat kickoff")
  assert.ok(skill, "Should match /feat")
  assert.equal(skill.name, "feat-lifecycle")
})

test("matchSlashCommand returns null for unknown command", () => {
  const registry = loadedRegistry()
  const skill = registry.matchSlashCommand("/unknown")
  assert.equal(skill, null)
})

test("matchSlashCommand returns null for non-slash content", () => {
  const registry = loadedRegistry()
  const skill = registry.matchSlashCommand("hello world")
  assert.equal(skill, null)
})

// ── getNext ──────────────────────────────────────────────────────────

test("getNext returns next skills for requesting-review", () => {
  const registry = loadedRegistry()
  const next = registry.getNext("requesting-review")
  assert.deepEqual(next, ["receiving-review"])
})

test("getNext returns empty for ask-dont-guess", () => {
  const registry = loadedRegistry()
  const next = registry.getNext("ask-dont-guess")
  assert.deepEqual(next, [])
})

// ── getSopStage ──────────────────────────────────────────────────────

test("getSopStage returns navigation for request-review", () => {
  const registry = loadedRegistry()
  const stage = registry.getSopStage("request-review")
  assert.ok(stage)
  assert.equal(stage.suggestedSkill, "requesting-review")
  assert.ok(stage.hardRules.length > 0)
})

test("getSopStage returns null for unknown stage", () => {
  const registry = loadedRegistry()
  assert.equal(registry.getSopStage("nonexistent"), null)
})

// ── validate ─────────────────────────────────────────────────────────

test("validate passes for current manifest + skills dir", () => {
  const registry = loadedRegistry()
  const errors = registry.validate(SKILLS_DIR)
  // next references like "writing-plans" don't exist in manifest → expected errors
  const nonNextErrors = errors.filter((e) => e.ruleId !== "next-exists")
  assert.equal(nonNextErrors.length, 0, `Unexpected lint errors: ${JSON.stringify(nonNextErrors)}`)
})

test("validate catches next-exists for unresolved references", () => {
  const registry = loadedRegistry()
  const errors = registry.validate(SKILLS_DIR)
  const nextErrors = errors.filter((e) => e.ruleId === "next-exists")
  assert.ok(nextErrors.length > 0, "Should flag unresolved next references like 'writing-plans'")
})
