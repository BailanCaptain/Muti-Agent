/**
 * F026 Phase 2 Task F · ADR-004 content-layer guard
 *
 * Phase 1 landed a diff-size guard (`scripts/ci/check-adr-004-diff.sh`),
 * but diff-size is blind to net-zero swaps (delete one line, add one line
 * carrying forbidden tokens). Phase 2 extends the guard with a content
 * scan over the four agent-prompt files — `Direct message from`,
 * `a2aFrom`, `triggerMessage` — all of which would be A2A protocol
 * leakage into the agent layer (ADR-004 violation).
 *
 * The detector is a pure function so we can TDD it both positively
 * (known-bad fixtures MUST be caught) and negatively (current prompt
 * files MUST be clean).
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"

import { findForbiddenAdr004Tokens } from "../check-adr-004-content"

const REPO_ROOT = resolve(__dirname, "..", "..", "..")

const GUARDED_FILES = [
  "CLAUDE.md",
  "GEMINI.md",
  "AGENTS.md",
  "packages/api/src/runtime/agent-prompts.ts",
]

// ---------- detector: positive cases (MUST catch forbidden tokens) ----------

test("ADR-004 detector · catches literal 'Direct message from'", () => {
  const hits = findForbiddenAdr004Tokens('prompt += "Direct message from ${alias}"')
  assert.deepEqual(hits, ["Direct message from"])
})

test("ADR-004 detector · catches 'a2aFrom' identifier", () => {
  const hits = findForbiddenAdr004Tokens("const a2aFrom = chain.parent.alias")
  assert.deepEqual(hits, ["a2aFrom"])
})

test("ADR-004 detector · catches 'triggerMessage' identifier", () => {
  const hits = findForbiddenAdr004Tokens("const tmid = ctx.triggerMessageId")
  assert.deepEqual(hits, ["triggerMessage"])
})

test("ADR-004 detector · case-insensitive", () => {
  const hits = findForbiddenAdr004Tokens("// DIRECT MESSAGE FROM small sun")
  assert.deepEqual(hits, ["Direct message from"])
})

test("ADR-004 detector · multiple hits returned in order", () => {
  const content = [
    "Direct message from X",
    "uses a2aFrom field",
    "reads triggerMessage id",
  ].join("\n")
  const hits = findForbiddenAdr004Tokens(content)
  assert.deepEqual(hits.sort(), ["Direct message from", "a2aFrom", "triggerMessage"].sort())
})

test("ADR-004 detector · clean content yields empty array", () => {
  const hits = findForbiddenAdr004Tokens("agent should reply naturally, no protocol leakage")
  assert.deepEqual(hits, [])
})

test("ADR-004 detector · unrelated substrings are not false positives", () => {
  const hits = findForbiddenAdr004Tokens(
    "messages: trigger, message, directly, from — none of these compound tokens match",
  )
  // "trigger, message" is NOT "triggerMessage"; words are space-separated
  assert.deepEqual(hits, [])
})

// ---------- guard: runtime contract (all four files MUST be clean) ----------

for (const rel of GUARDED_FILES) {
  test(`ADR-004 content guard · ${rel} contains no forbidden A2A protocol tokens`, () => {
    const abs = resolve(REPO_ROOT, rel)
    let content: string
    try {
      content = readFileSync(abs, "utf8")
    } catch {
      // Optional files (GEMINI.md / AGENTS.md) may not exist yet — treat as clean.
      return
    }
    const hits = findForbiddenAdr004Tokens(content)
    assert.deepEqual(
      hits,
      [],
      `${rel} leaks A2A protocol: ${hits.join(", ")} — see docs/adrs/ADR-004-a2a-transparent-to-agent.md`,
    )
  })
}
