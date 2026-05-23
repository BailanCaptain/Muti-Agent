import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import {
  DEFAULT_AC_PATTERN,
  DEFAULT_PHASE1_EVIDENCE_FILES,
  buildJudgePrompt,
  extractJudgeJson,
  parseJudgeArgs,
} from "./p18-judge"

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

  // ── F027 P19.16: generic 化 (Phase 2 evidence pack 复用) ──

  it("default ac-pattern stays Phase 1 ^AC-P1-\\d+$ (back-compat)", () => {
    const args = parseJudgeArgs([
      "--ac",
      "AC-P1-7",
      "--evidence",
      "/tmp/evidence",
      "--out",
      "/tmp/judge.json",
    ])
    assert.equal(args.acPattern, DEFAULT_AC_PATTERN)
    assert.equal(args.evidenceFiles.length, DEFAULT_PHASE1_EVIDENCE_FILES.length)
  })

  it("default ac-pattern rejects Phase 2 AC-P2-1 (back-compat)", () => {
    assert.throws(
      () =>
        parseJudgeArgs([
          "--ac",
          "AC-P2-1",
          "--evidence",
          "/tmp/e",
          "--out",
          "/tmp/o.json",
        ]),
      /does not match.*AC-P1/,
    )
  })

  it("--ac-pattern '^AC-P2-\\d+[ab]?$' accepts AC-P2-3a (Phase 2)", () => {
    const args = parseJudgeArgs([
      "--ac",
      "AC-P2-3a",
      "--ac-pattern",
      "^AC-P2-\\d+[ab]?$",
      "--evidence",
      "/tmp/e",
      "--out",
      "/tmp/o.json",
    ])
    assert.equal(args.ac, "AC-P2-3a")
    assert.equal(args.acPattern, "^AC-P2-\\d+[ab]?$")
  })

  it("--evidence-files CSV parses to array (override Phase 1 default)", () => {
    const args = parseJudgeArgs([
      "--ac",
      "AC-P1-1",
      "--evidence",
      "/tmp/e",
      "--out",
      "/tmp/o.json",
      "--evidence-files",
      "result.json,judges/judge1.json,judges/judge2.json",
    ])
    assert.deepEqual(
      [...args.evidenceFiles],
      ["result.json", "judges/judge1.json", "judges/judge2.json"],
    )
  })

  it("--evidence-files empty list throws", () => {
    assert.throws(
      () =>
        parseJudgeArgs([
          "--ac",
          "AC-P1-1",
          "--evidence",
          "/tmp/e",
          "--out",
          "/tmp/o.json",
          "--evidence-files",
          " , , ",
        ]),
      /parsed empty list/,
    )
  })

  it("invalid --ac-pattern regex throws on parse", () => {
    assert.throws(
      () =>
        parseJudgeArgs([
          "--ac",
          "AC-x",
          "--ac-pattern",
          "[unclosed",
          "--evidence",
          "/tmp/e",
          "--out",
          "/tmp/o.json",
        ]),
      /Invalid --ac-pattern/,
    )
  })

  it("--ac-text-file loads JSON map (Phase 2 AC text)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "p18-judge-acText-"))
    const file = path.join(dir, "phase2-ac-text.json")
    writeFileSync(
      file,
      JSON.stringify({
        "AC-P2-1": "Phase 2 scheduler 11 jobs trigger window fixture",
        "AC-P2-3a": "Iron Laws 3 fallback default config",
      }),
    )
    const args = parseJudgeArgs([
      "--ac",
      "AC-P2-1",
      "--ac-pattern",
      "^AC-P2-\\d+[ab]?$",
      "--ac-text-file",
      file,
      "--evidence",
      "/tmp/e",
      "--out",
      "/tmp/o.json",
    ])
    assert.equal(args.acText["AC-P2-1"], "Phase 2 scheduler 11 jobs trigger window fixture")
  })

  it("--ac-text-file invalid JSON throws", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "p18-judge-bad-ac-"))
    const file = path.join(dir, "bad.json")
    writeFileSync(file, "this is not json")
    assert.throws(
      () =>
        parseJudgeArgs([
          "--ac",
          "AC-P1-1",
          "--ac-text-file",
          file,
          "--evidence",
          "/tmp/e",
          "--out",
          "/tmp/o.json",
        ]),
      /invalid JSON/,
    )
  })

  it("--ac-text-file not found throws", () => {
    assert.throws(
      () =>
        parseJudgeArgs([
          "--ac",
          "AC-P1-1",
          "--ac-text-file",
          "/non/existent/path.json",
          "--evidence",
          "/tmp/e",
          "--out",
          "/tmp/o.json",
        ]),
      /not found/,
    )
  })

  it("buildJudgePrompt with custom evidenceFiles only renders those", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "p18-judge-custom-files-"))
    writeFileSync(path.join(dir, "result.json"), JSON.stringify({ verdict: "PASS" }))
    writeFileSync(path.join(dir, "custom.txt"), "custom evidence content")
    const prompt = buildJudgePrompt({
      ac: "AC-P2-1",
      evidenceDir: dir,
      evidenceFiles: ["result.json", "custom.txt"],
      acText: { "AC-P2-1": "Phase 2 test fixture" },
    })
    assert.match(prompt, /Phase 2 test fixture/)
    assert.match(prompt, /custom\.txt/)
    assert.match(prompt, /custom evidence content/)
    assert.match(prompt, /all 2 evidence pack files/, "prompt 应说 'all 2'，不是 'all 7'")
    // 验证不带 7 件套其他文件
    assert.doesNotMatch(prompt, /agent_response\.txt/)
    assert.doesNotMatch(prompt, /db_dump\.sql/)
  })

  it("buildJudgePrompt missing evidence file marked MISSING", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "p18-judge-missing-"))
    // 只写 result.json，缺 custom.txt
    writeFileSync(path.join(dir, "result.json"), JSON.stringify({ verdict: "PASS" }))
    const prompt = buildJudgePrompt({
      ac: "AC-P1-1",
      evidenceDir: dir,
      evidenceFiles: ["result.json", "custom.txt"],
    })
    assert.match(prompt, /## custom\.txt\nMISSING/)
  })
})
