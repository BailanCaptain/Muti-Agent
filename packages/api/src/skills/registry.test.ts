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

test("loadManifest loads all 14 skills", () => {
  const registry = loadedRegistry()
  assert.equal(registry.allSkills().length, 14)
})

test("loadManifest loads sop_navigation stages", () => {
  const registry = loadedRegistry()
  assert.ok(registry.getSopStage("merge-gate"), "merge-gate stage should exist")
  assert.ok(registry.getSopStage("tdd"), "tdd stage should exist")
  assert.ok(registry.getSopStage("quality-gate"), "quality-gate stage should exist")
  assert.ok(registry.getSopStage("vision-guardian"), "vision-guardian stage should exist")
  assert.ok(registry.getSopStage("writing-plans"), "writing-plans stage should exist")
  assert.ok(registry.getSopStage("worktree"), "worktree stage should exist")
})

// ── match — trigger 匹配 ────────────────────────────────────────────

test("match finds debugging for '遇到一个 bug'", () => {
  const registry = loadedRegistry()
  const results = registry.match("遇到一个 bug 需要修复")
  const names = results.map((r) => r.skill.name)
  assert.ok(names.includes("debugging"), `Expected debugging, got: ${names}`)
})

test("match finds self-evolution for '又犯了同样的错'", () => {
  const registry = loadedRegistry()
  const results = registry.match("又犯了同样的错误")
  const names = results.map((r) => r.skill.name)
  assert.ok(names.includes("self-evolution"), `Expected self-evolution, got: ${names}`)
})

test("match finds requesting-review for '请 review'", () => {
  const registry = loadedRegistry()
  const results = registry.match("请 review 一下我的实现")
  const names = results.map((r) => r.skill.name)
  assert.ok(names.includes("requesting-review"), `Expected requesting-review, got: ${names}`)
})

test("match finds merge-gate for '准备合入'", () => {
  const registry = loadedRegistry()
  const results = registry.match("代码改好了，准备合入")
  const names = results.map((r) => r.skill.name)
  assert.ok(names.includes("merge-gate"), `Expected merge-gate, got: ${names}`)
})

test("match finds writing-plans for '写计划'", () => {
  const registry = loadedRegistry()
  const results = registry.match("帮我写计划")
  const names = results.map((r) => r.skill.name)
  assert.ok(names.includes("writing-plans"), `Expected writing-plans, got: ${names}`)
})

test("match finds tdd for 'TDD'", () => {
  const registry = loadedRegistry()
  const results = registry.match("用 TDD 方式来做")
  const names = results.map((r) => r.skill.name)
  assert.ok(names.includes("tdd"), `Expected tdd, got: ${names}`)
})

test("match finds quality-gate for '开发完了'", () => {
  const registry = loadedRegistry()
  const results = registry.match("开发完了，准备检查")
  const names = results.map((r) => r.skill.name)
  assert.ok(names.includes("quality-gate"), `Expected quality-gate, got: ${names}`)
})

test("match finds vision-guardian for '愿景守护'", () => {
  const registry = loadedRegistry()
  const results = registry.match("触发愿景守护")
  const names = results.map((r) => r.skill.name)
  assert.ok(names.includes("vision-guardian"), `Expected vision-guardian, got: ${names}`)
})

test("match finds worktree for '新 worktree'", () => {
  const registry = loadedRegistry()
  const results = registry.match("开个新 worktree")
  const names = results.map((r) => r.skill.name)
  assert.ok(names.includes("worktree"), `Expected worktree, got: ${names}`)
})

// ── match — not_for 排除 ────────────────────────────────────────────

test("match excludes debugging when content contains '新功能开发'", () => {
  const registry = loadedRegistry()
  const results = registry.match("新功能开发")
  const names = results.map((r) => r.skill.name)
  assert.ok(!names.includes("debugging"), `debugging should be excluded by not_for, got: ${names}`)
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

test("matchSlashCommand matches /debug", () => {
  const registry = loadedRegistry()
  const skill = registry.matchSlashCommand("/debug 这个错误")
  assert.ok(skill, "Should match /debug")
  assert.equal(skill.name, "debugging")
})

test("matchSlashCommand matches /evolve", () => {
  const registry = loadedRegistry()
  const skill = registry.matchSlashCommand("/evolve")
  assert.ok(skill, "Should match /evolve")
  assert.equal(skill.name, "self-evolution")
})

test("matchSlashCommand matches /merge", () => {
  const registry = loadedRegistry()
  const skill = registry.matchSlashCommand("/merge")
  assert.ok(skill, "Should match /merge")
  assert.equal(skill.name, "merge-gate")
})

test("matchSlashCommand matches /feat", () => {
  const registry = loadedRegistry()
  const skill = registry.matchSlashCommand("/feat kickoff")
  assert.ok(skill, "Should match /feat")
  assert.equal(skill.name, "feat-lifecycle")
})

test("matchSlashCommand matches /plan", () => {
  const registry = loadedRegistry()
  const skill = registry.matchSlashCommand("/plan")
  assert.ok(skill, "Should match /plan")
  assert.equal(skill.name, "writing-plans")
})

test("matchSlashCommand matches /tdd", () => {
  const registry = loadedRegistry()
  const skill = registry.matchSlashCommand("/tdd")
  assert.ok(skill, "Should match /tdd")
  assert.equal(skill.name, "tdd")
})

test("matchSlashCommand matches /gate", () => {
  const registry = loadedRegistry()
  const skill = registry.matchSlashCommand("/gate")
  assert.ok(skill, "Should match /gate")
  assert.equal(skill.name, "quality-gate")
})

test("matchSlashCommand matches /guardian", () => {
  const registry = loadedRegistry()
  const skill = registry.matchSlashCommand("/guardian")
  assert.ok(skill, "Should match /guardian")
  assert.equal(skill.name, "vision-guardian")
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

// ── getNext — workflow chain ────────────────────────────────────────

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

test("complete workflow chain: feat-lifecycle → ... → merge-gate → feat-lifecycle", () => {
  const registry = loadedRegistry()

  // feat-lifecycle → writing-plans
  assert.deepEqual(registry.getNext("feat-lifecycle"), ["writing-plans"])
  // writing-plans → worktree
  assert.deepEqual(registry.getNext("writing-plans"), ["worktree"])
  // worktree → tdd
  assert.deepEqual(registry.getNext("worktree"), ["tdd"])
  // tdd → quality-gate
  assert.deepEqual(registry.getNext("tdd"), ["quality-gate"])
  // quality-gate → vision-guardian
  assert.deepEqual(registry.getNext("quality-gate"), ["vision-guardian"])
  // vision-guardian → requesting-review
  assert.deepEqual(registry.getNext("vision-guardian"), ["requesting-review"])
  // requesting-review → receiving-review
  assert.deepEqual(registry.getNext("requesting-review"), ["receiving-review"])
  // receiving-review → merge-gate
  assert.deepEqual(registry.getNext("receiving-review"), ["merge-gate"])
  // merge-gate → feat-lifecycle (loop back)
  assert.deepEqual(registry.getNext("merge-gate"), ["feat-lifecycle"])
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

test("validate passes with zero errors for current manifest + skills dir", () => {
  const registry = loadedRegistry()
  const errors = registry.validate(SKILLS_DIR)
  assert.equal(errors.length, 0, `Unexpected lint errors: ${JSON.stringify(errors)}`)
})
