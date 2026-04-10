import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { SkillRegistry } from "../skills/registry.js"
import { LINEAR_FLOW_SKILLS } from "./message-service.js"

const MANIFEST_PATH = path.resolve(__dirname, "../../../../multi-agent-skills/manifest.yaml")

function loadedRegistry(): SkillRegistry {
  const r = new SkillRegistry()
  r.loadManifest(MANIFEST_PATH)
  return r
}

// Mirrors MessageService.matchOrthogonalSkills() so these tests pin the
// contract that the hint layer exposes to agents.
function orthogonalHintNames(registry: SkillRegistry, content: string): string[] {
  return registry
    .match(content)
    .map((m) => m.skill.name)
    .filter((name) => !LINEAR_FLOW_SKILLS.has(name))
}

// ── B003 regression: mid-flow messages must not re-inject linear-flow skills ──

test("B003: mid-flow bugfix status does NOT inject feat-lifecycle or tdd hint", () => {
  const names = orthogonalHintNames(loadedRegistry(), "这个 bugfix 我先 TDD 一下")
  assert.ok(
    !names.includes("feat-lifecycle"),
    `feat-lifecycle must not re-trigger mid-flow, got: ${names.join(",")}`,
  )
  assert.ok(
    !names.includes("tdd"),
    `tdd must not re-trigger mid-flow, got: ${names.join(",")}`,
  )
})

test("B003: plain refactor command does NOT inject feat-lifecycle hint", () => {
  const names = orthogonalHintNames(loadedRegistry(), "重构这段代码")
  assert.ok(!names.includes("feat-lifecycle"), `got: ${names.join(",")}`)
})

test("B003: casual 'feat' token does NOT inject feat-lifecycle hint", () => {
  const names = orthogonalHintNames(loadedRegistry(), "这个 feat 快做好了")
  assert.ok(!names.includes("feat-lifecycle"), `got: ${names.join(",")}`)
})

test("B003: '开始开发' does NOT inject worktree hint mid-flow", () => {
  const names = orthogonalHintNames(loadedRegistry(), "我现在开始开发这个模块")
  assert.ok(!names.includes("worktree"), `got: ${names.join(",")}`)
})

test("B003: '准备合入' does NOT inject merge-gate hint via keyword match", () => {
  // merge-gate must be reached via /merge or SOP advance, not via user chatter.
  const names = orthogonalHintNames(loadedRegistry(), "改完了准备合入主干")
  assert.ok(!names.includes("merge-gate"), `got: ${names.join(",")}`)
})

// ── Orthogonal skills must still fire via keyword match ──

test("B003: explicit bug report still routes to debugging (orthogonal)", () => {
  const names = orthogonalHintNames(loadedRegistry(), "遇到一个 bug 需要修复")
  assert.ok(names.includes("debugging"), `got: ${names.join(",")}`)
})

test("B003: '又犯了' still routes to self-evolution (orthogonal)", () => {
  const names = orthogonalHintNames(loadedRegistry(), "我又犯了同样的错误")
  assert.ok(names.includes("self-evolution"), `got: ${names.join(",")}`)
})

test("B003: '讨论' still routes to collaborative-thinking (orthogonal)", () => {
  const names = orthogonalHintNames(loadedRegistry(), "我们一起讨论一下架构")
  assert.ok(names.includes("collaborative-thinking"), `got: ${names.join(",")}`)
})

test("B003: '交接' still routes to cross-role-handoff (orthogonal)", () => {
  const names = orthogonalHintNames(loadedRegistry(), "帮我做一次交接")
  assert.ok(names.includes("cross-role-handoff"), `got: ${names.join(",")}`)
})

// ── Registry-level match() must still see linear-flow skills (SOP tracking) ──

test("B003: registry.match() STILL finds linear-flow skills (advanceSopIfNeeded needs this)", () => {
  // advanceSopIfNeeded reads assistant output with registry.match() to detect
  // which skill just ran. The filter only applies at the user-facing hint
  // layer, never at the registry itself.
  const registry = loadedRegistry()
  const names = registry.match("用 TDD 方式来做").map((m) => m.skill.name)
  assert.ok(names.includes("tdd"), `registry-level must still find tdd, got: ${names.join(",")}`)
})

// ── LINEAR_FLOW_SKILLS coverage check ──

test("B003: LINEAR_FLOW_SKILLS covers the full development chain", () => {
  const expected = [
    "feat-lifecycle",
    "writing-plans",
    "worktree",
    "tdd",
    "quality-gate",
    "vision-guardian",
    "requesting-review",
    "receiving-review",
    "merge-gate",
  ]
  for (const name of expected) {
    assert.ok(LINEAR_FLOW_SKILLS.has(name), `${name} must be in LINEAR_FLOW_SKILLS`)
  }
  // Orthogonal skills must NOT be in the set.
  for (const name of ["debugging", "self-evolution", "collaborative-thinking", "cross-role-handoff"]) {
    assert.ok(!LINEAR_FLOW_SKILLS.has(name), `${name} must NOT be in LINEAR_FLOW_SKILLS`)
  }
})
