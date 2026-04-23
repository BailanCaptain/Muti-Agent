import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import {
  AGENT_SYSTEM_PROMPTS,
  buildSystemPromptWithHints,
  __resetSharedRulesCacheForTest
} from "./agent-prompts"

test("AGENT_SYSTEM_PROMPTS contains prompts for all providers", () => {
  assert.ok(AGENT_SYSTEM_PROMPTS.claude.length > 0)
  assert.ok(AGENT_SYSTEM_PROMPTS.codex.length > 0)
  assert.ok(AGENT_SYSTEM_PROMPTS.gemini.length > 0)
})

test("AGENT_SYSTEM_PROMPTS.claude contains identity and rules", () => {
  const prompt = AGENT_SYSTEM_PROMPTS.claude
  assert.ok(prompt.includes("黄仁勋"))
  assert.ok(prompt.includes("家规"))
})

const LEGACY_SECTION = ["Call", "back", " API"].join("")
const LEGACY_NODE_E = ["node", " -e"].join("")

test("AGENT_SYSTEM_PROMPTS.codex does not include legacy curl-fetch section (F023 — MCP 挂载统一后废弃)", () => {
  const prompt = AGENT_SYSTEM_PROMPTS.codex
  assert.ok(!prompt.includes(LEGACY_SECTION), "Codex prompt must not embed legacy curl-fetch guide")
  assert.ok(!prompt.includes(LEGACY_NODE_E), "Codex prompt must not teach manual fetch command")
})

test("AGENT_SYSTEM_PROMPTS.gemini does not include legacy curl-fetch section (F023 — MCP 挂载统一后废弃)", () => {
  const prompt = AGENT_SYSTEM_PROMPTS.gemini
  assert.ok(!prompt.includes(LEGACY_SECTION), "Gemini prompt must not embed legacy curl-fetch guide")
  assert.ok(!prompt.includes(LEGACY_NODE_E), "Gemini prompt must not teach manual fetch command")
})

test("buildSystemPromptWithHints returns base prompt unchanged when no context", () => {
  const base = AGENT_SYSTEM_PROMPTS.claude
  assert.equal(buildSystemPromptWithHints("claude", {}), base)
})

test("buildSystemPromptWithHints appends sopStageHint one-liner at the end", () => {
  const prompt = buildSystemPromptWithHints("claude", {
    sopStageHint: { featureId: "F019", stage: "impl", suggestedSkill: "tdd" },
  })
  assert.ok(prompt.startsWith(AGENT_SYSTEM_PROMPTS.claude), "preserves base prompt prefix")
  assert.ok(prompt.endsWith("\n\nSOP: F019 stage=impl → load skill: tdd"))
})

test("buildSystemPromptWithHints omits '→ load skill' suffix when suggestedSkill is null", () => {
  const prompt = buildSystemPromptWithHints("codex", {
    sopStageHint: { featureId: "F019", stage: "completion", suggestedSkill: null },
  })
  assert.ok(prompt.endsWith("\n\nSOP: F019 stage=completion"))
  assert.ok(!prompt.includes("→ load skill"))
})

test("buildSystemPromptWithHints works for all three providers", () => {
  for (const provider of ["claude", "codex", "gemini"] as const) {
    const out = buildSystemPromptWithHints(provider, {
      sopStageHint: { featureId: "F019", stage: "review", suggestedSkill: "code-review" },
    })
    assert.ok(out.startsWith(AGENT_SYSTEM_PROMPTS[provider]), `${provider}: base preserved`)
    assert.ok(out.endsWith("SOP: F019 stage=review → load skill: code-review"), `${provider}: hint appended`)
  }
})

// Hot-reload contract (R-198 P1): AGENT_SYSTEM_PROMPTS must re-read shared-rules.md
// at access time so editing the file + merging takes effect without API restart.
test("AGENT_SYSTEM_PROMPTS reflects runtime shared-rules.md mutation (hot reload, R-198)", () => {
  const marker = `HOT_RELOAD_MARKER_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const originalReadFileSync = fs.readFileSync

  __resetSharedRulesCacheForTest()

  // Monkeypatch fs.readFileSync only for shared-rules.md; leave every other read alone.
  ;(fs as any).readFileSync = (filePath: any, options?: any) => {
    if (typeof filePath === "string" && filePath.endsWith("shared-rules.md")) {
      return `# Stubbed rules\n${marker}\n`
    }
    return originalReadFileSync.call(fs, filePath, options)
  }

  try {
    for (const provider of ["claude", "codex", "gemini"] as const) {
      const prompt = AGENT_SYSTEM_PROMPTS[provider]
      assert.ok(
        prompt.includes(marker),
        `${provider}: AGENT_SYSTEM_PROMPTS must reflect current shared-rules.md content, ` +
          `not a module-load snapshot. Missing marker=${marker}.`
      )
    }
  } finally {
    ;(fs as any).readFileSync = originalReadFileSync
    __resetSharedRulesCacheForTest()
  }
})
