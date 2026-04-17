import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { SkillRegistry } from "./registry"
import { applySlashCommandHint, resolveSlashSkillHint } from "./slash-route"

const MANIFEST_PATH = path.resolve(__dirname, "../../../../multi-agent-skills/manifest.yaml")

function loadedRegistry(): SkillRegistry {
  const r = new SkillRegistry()
  r.loadManifest(MANIFEST_PATH)
  return r
}

// ── resolveSlashSkillHint (pure) ────────────────────────────────────────

test("resolveSlashSkillHint returns null when registry is null", () => {
  assert.equal(resolveSlashSkillHint("/guardian please review", null), null)
})

test("resolveSlashSkillHint returns null when content is plain text (no slash)", () => {
  assert.equal(resolveSlashSkillHint("让我讨论一下", loadedRegistry()), null)
})

test("resolveSlashSkillHint returns null for unknown slash command", () => {
  assert.equal(resolveSlashSkillHint("/unknowncommand foo", loadedRegistry()), null)
})

test("resolveSlashSkillHint returns hint for /guardian → acceptance-guardian", () => {
  const hint = resolveSlashSkillHint("/guardian please audit the delivery", loadedRegistry())
  assert.ok(hint, "should resolve to a hint string")
  assert.match(hint, /^⚡ 加载 skill: acceptance-guardian/)
})

test("resolveSlashSkillHint returns hint for /think → collaborative-thinking", () => {
  const hint = resolveSlashSkillHint("/think 我们讨论一下这个架构", loadedRegistry())
  assert.ok(hint)
  assert.match(hint, /^⚡ 加载 skill: collaborative-thinking/)
})

test("resolveSlashSkillHint returns hint for /review → code-review", () => {
  const hint = resolveSlashSkillHint("/review packages/api/src/foo.ts", loadedRegistry())
  assert.ok(hint)
  assert.match(hint, /^⚡ 加载 skill: code-review/)
})

test("resolveSlashSkillHint returns hint for /debug → debugging", () => {
  const hint = resolveSlashSkillHint("/debug why did the test fail", loadedRegistry())
  assert.ok(hint)
  assert.match(hint, /^⚡ 加载 skill: debugging/)
})

test("resolveSlashSkillHint matches slash at start of trimmed content", () => {
  // Leading whitespace should not prevent routing
  const hint = resolveSlashSkillHint("  /think foo", loadedRegistry())
  // matchSlashCommand uses .trim().startsWith("/"), so this should work
  assert.ok(hint, "leading whitespace should still match")
})

// ── applySlashCommandHint (prepends hint to content) ──────────────────

test("applySlashCommandHint prepends hint + blank line + original content", () => {
  const original = "/guardian please audit"
  const result = applySlashCommandHint(original, loadedRegistry())
  assert.ok(
    result.startsWith("⚡ 加载 skill: acceptance-guardian"),
    `expected hint prefix, got: ${result.slice(0, 50)}`,
  )
  assert.ok(result.includes(original), "original content must be preserved")
  // Format: "hint\n\noriginal"
  assert.ok(result.includes("\n\n/guardian please audit"))
})

test("applySlashCommandHint returns content unchanged when no slash match", () => {
  const original = "我们讨论一下这个"
  const result = applySlashCommandHint(original, loadedRegistry())
  assert.equal(result, original, "plain text must not be modified")
})

test("applySlashCommandHint returns content unchanged when registry is null", () => {
  const original = "/guardian still needs hint but no registry"
  assert.equal(applySlashCommandHint(original, null), original)
})

// ── Critical regression: do NOT degrade slash command to keyword scan ──

test("resolveSlashSkillHint does NOT fire for mid-flow messages that mention skill names as keywords", () => {
  // This is the regression F019 P4 was protecting against: keyword-scan
  // based hint injection. Slash routing should be purely explicit.
  const contents = [
    "这个 bugfix 我先 TDD 一下",
    "刚才我在 collaborative-thinking 里记了",
    "要不要把 guardian 模式打开",
  ]
  const r = loadedRegistry()
  for (const c of contents) {
    assert.equal(
      resolveSlashSkillHint(c, r),
      null,
      `must not fire on non-slash content: ${c}`,
    )
  }
})
