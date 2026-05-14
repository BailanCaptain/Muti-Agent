import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { buildJudgePrompt, extractJudgeJson, parseJudgeArgs } from "./p18-judge"

function makeEvidenceDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "p18-judge-"))
  writeFileSync(path.join(dir, "prompt.txt"), "system prompt")
  writeFileSync(path.join(dir, "agent_response.txt"), "agent response")
  writeFileSync(path.join(dir, "db_dump.sql"), "SELECT 1;")
  writeFileSync(path.join(dir, "config.hash"), "sha256:abc")
  writeFileSync(path.join(dir, "prod_config_diff.txt"), "no diff")
  writeFileSync(path.join(dir, "result.json"), JSON.stringify({ verdict: "PASS" }))
  writeFileSync(path.join(dir, "wiki_state.tar.gz"), "fake tar bytes")
  mkdirSync(path.join(dir, "judges"))
  return dir
}

describe("p18-judge wrapper", () => {
  it("parses required CLI args", () => {
    const args = parseJudgeArgs([
      "--ac",
      "AC-P1-1",
      "--evidence",
      "docs/features/F027/evidence/phase1/AC-P1-1",
      "--out",
      "judge1.json",
    ])
    assert.equal(args.ac, "AC-P1-1")
    assert.equal(args.evidence, "docs/features/F027/evidence/phase1/AC-P1-1")
    assert.equal(args.out, "judge1.json")
    assert.equal(args.judge, "claude-opus-4-7")
  })

  it("builds a prompt with AC text and all seven evidence pack entries", () => {
    const evidenceDir = makeEvidenceDir()
    const prompt = buildJudgePrompt({ ac: "AC-P1-1", evidenceDir })
    assert.match(prompt, /AC-P1-1/)
    assert.match(prompt, /4 tables/)
    for (const name of [
      "prompt.txt",
      "agent_response.txt",
      "db_dump.sql",
      "wiki_state.tar.gz",
      "config.hash",
      "prod_config_diff.txt",
      "result.json",
    ]) {
      assert.match(prompt, new RegExp(name.replace(".", "\\.")))
    }
  })

  it("extracts judge JSON from fenced Claude output", () => {
    const parsed = extractJudgeJson(
      'Here is the verdict:\n```json\n{"verdict":"PASS","reason":"ok","weak_points":[]}\n```',
    )
    assert.deepEqual(parsed, { verdict: "PASS", reason: "ok", weak_points: [] })
  })
})
