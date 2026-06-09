import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { pathToFileURL } from "node:url"
import {
  type ArbitrationJson,
  isInvokedAsMain,
  type JudgeJson,
  type ResultJson,
  runEvidence,
  validateArbitrationJsonSchema,
  validateJudgeJsonSchema,
  validateResultJsonSchema,
} from "./f027-phase4-evidence-runner"

/**
 * F027 P4 AC-P4-5 三层验证 runner 单测
 *
 * 测试覆盖:
 *   schema validator:
 *     (1) result.json 缺 ac_id → 报字段
 *     (2) result.json verdict=BLOCKED 缺 blocked_reason → 报字段
 *     (3) judge json wrong judge_id → 报字段
 *     (4) judge json 缺 reasoning → 报字段
 *     (5) arbitration json 缺 final_verdict → 报字段
 *     (6) 合法 result.json → 空
 *   runEvidence flow:
 *     (7) result.json 不存在 → INCONCLUSIVE
 *     (8) result.json schema 缺字段 → INCONCLUSIVE
 *     (9) judges/judge1 缺 → INCONCLUSIVE
 *    (10) judges 字段缺 → INCONCLUSIVE
 *    (11) j1+j2 一致 PASS → final PASS (合法 logs)
 *    (12) j1+j2 不一致 + 无 arbitration → INCONCLUSIVE
 *    (13) j1+j2 不一致 + arbitration FAIL → final FAIL
 *    (14) j2 BLOCKED (quota 用尽) → final BLOCKED (含 blocked_reason)
 *    (15) j2 BLOCKED 但 result.blocked_reason 缺 → INCONCLUSIVE
 *    (16) AC needsBrowser + screenshots 空 → INCONCLUSIVE
 *    (17) AC needsBackendLogs + logs 空 → INCONCLUSIVE
 */

const PASS_VERDICT = "PASS" as const

function setup(): {
  dir: string
  writeResult: (r: Partial<ResultJson>) => void
  writeJudge: (n: 1 | 2, j: Partial<JudgeJson>) => void
  writeArbitration: (a: Partial<ArbitrationJson>) => void
  writeScreenshot: () => void
  writeLog: () => void
  cleanup: () => void
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-runner-test-AC-P4-1-"))
  // 重命名为 AC-P4-1 子目录让 inferAcIdFromPath 拿对
  const acDir = path.join(dir, "AC-P4-1")
  fs.mkdirSync(path.join(acDir, "judges"), { recursive: true })
  fs.mkdirSync(path.join(acDir, "screenshots"), { recursive: true })
  fs.mkdirSync(path.join(acDir, "logs"), { recursive: true })

  return {
    dir: acDir,
    writeResult: (r) => fs.writeFileSync(path.join(acDir, "result.json"), JSON.stringify(r)),
    writeJudge: (n, j) =>
      fs.writeFileSync(
        path.join(
          acDir,
          "judges",
          n === 1 ? "judge1_claude-opus-4-7.json" : "judge2_codex-gpt-5.4.json",
        ),
        JSON.stringify(j),
      ),
    writeArbitration: (a) =>
      fs.writeFileSync(path.join(acDir, "judges", "arbitration.json"), JSON.stringify(a)),
    writeScreenshot: () =>
      fs.writeFileSync(path.join(acDir, "screenshots", "step-1.png"), "fake-png"),
    writeLog: () => fs.writeFileSync(path.join(acDir, "logs", "api-server.log"), "fake log line"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

const GOOD_RESULT: ResultJson = {
  ac_id: "AC-P4-1",
  title: "PromoteModal",
  phase: "phase4",
  verdict: "PASS",
  double_pass: {
    judge1_verdict: "PASS",
    judge2_verdict: "PASS",
    arbitration_verdict: null,
    consensus: true,
  },
  evidence_paths: {
    screenshots: ["screenshots/step-1.png"],
    logs: ["logs/api-server.log"],
    code_anchors: ["packages/api/src/wiki/promote-audit/promote-wiki-service.ts:108"],
  },
}

function goodJudge(judgeId: JudgeJson["judge_id"], verdict: JudgeJson["verdict"]): JudgeJson {
  return {
    judge_id: judgeId,
    ac_id: "AC-P4-1",
    verdict,
    reasoning: `${judgeId} OK reasoning`,
    cited_evidence: ["screenshots/step-1.png"],
    spec_gate: "PASS",
    mechanism_gate: "PASS",
    feature_gate: "PASS",
    p1_findings: [],
    p2_findings: [],
    p3_findings: [],
  }
}

describe("AC-P4-5 evidence runner · isInvokedAsMain (codex end-r2 P1)", () => {
  // Cross-platform 验: Windows `file:///C:/...` 三斜杠 + argv1 反斜杠
  it("(R1-1) script 同路径调用 → true", () => {
    const scriptPath = "C:\\Users\\foo\\runner.ts"
    const metaUrl = pathToFileURL(scriptPath).href // "file:///C:/Users/foo/runner.ts"
    assert.equal(isInvokedAsMain(metaUrl, scriptPath), true)
  })

  it("(R1-2) script 不同路径调用 → false (其他文件 import 此 module)", () => {
    const scriptPath = "C:\\Users\\foo\\runner.ts"
    const metaUrl = pathToFileURL(scriptPath).href
    assert.equal(isInvokedAsMain(metaUrl, "C:\\Users\\foo\\other.ts"), false)
  })

  it("(R1-3) argv1 undefined → false", () => {
    const metaUrl = pathToFileURL("C:\\Users\\foo\\runner.ts").href
    assert.equal(isInvokedAsMain(metaUrl, undefined), false)
  })

  it("(R1-4) POSIX 路径同样 work (cross-platform)", () => {
    const scriptPath = "/home/foo/runner.ts"
    const metaUrl = pathToFileURL(scriptPath).href // "file:///home/foo/runner.ts"
    assert.equal(isInvokedAsMain(metaUrl, scriptPath), true)
  })
})

describe("AC-P4-5 evidence runner · schema validators", () => {
  it("(1) result.json 缺 ac_id → 报字段", () => {
    const missing = validateResultJsonSchema({} as Partial<ResultJson>)
    assert.ok(missing.includes("ac_id"))
  })

  it("(1a) codex end-r2 P2: double_pass 缺 arbitration_verdict 字段 → 报字段", () => {
    const missing = validateResultJsonSchema({
      ...GOOD_RESULT,
      double_pass: {
        judge1_verdict: "PASS",
        judge2_verdict: "PASS",
        consensus: true,
        // arbitration_verdict 字段缺
      } as ResultJson["double_pass"],
    })
    assert.ok(
      missing.some((s) => s.includes("arbitration_verdict")),
      `expected 'arbitration_verdict' missing-field but got: ${missing.join(", ")}`,
    )
  })

  it("(2) verdict=BLOCKED 缺 blocked_reason → 报字段", () => {
    const missing = validateResultJsonSchema({ ...GOOD_RESULT, verdict: "BLOCKED" })
    assert.ok(missing.some((s) => s.startsWith("blocked_reason")))
  })

  it("(3) judge json 错 judge_id → 报字段", () => {
    const missing = validateJudgeJsonSchema(
      goodJudge("codex-gpt-5.4", PASS_VERDICT),
      "claude-opus-4-7",
    )
    assert.ok(missing.some((s) => s.includes("judge_id")))
  })

  it("(4) judge json 缺 reasoning → 报字段", () => {
    const bad = { ...goodJudge("claude-opus-4-7", PASS_VERDICT), reasoning: "" }
    const missing = validateJudgeJsonSchema(bad, "claude-opus-4-7")
    assert.ok(missing.includes("reasoning"))
  })

  it("(5) arbitration json 缺 final_verdict → 报字段", () => {
    const missing = validateArbitrationJsonSchema({
      ac_id: "AC-P4-1",
      judge1_verdict: "PASS",
      judge2_verdict: "FAIL",
      arbiter: "黄仁勋",
      reasoning: "x",
    } as Partial<ArbitrationJson>)
    assert.ok(missing.includes("final_verdict"))
  })

  it("(6) 合法 result.json → 空", () => {
    const missing = validateResultJsonSchema(GOOD_RESULT)
    assert.deepEqual(missing, [])
  })
})

describe("AC-P4-5 evidence runner · runEvidence flow", () => {
  it("(7) result.json 不存在 → INCONCLUSIVE", () => {
    const t = setup()
    try {
      const out = runEvidence({ evidenceDir: t.dir })
      assert.equal(out.finalVerdict, "INCONCLUSIVE")
      assert.ok(out.diagnostics[0].includes("result.json 不存在"))
    } finally {
      t.cleanup()
    }
  })

  it("(8) result.json schema 缺字段 → INCONCLUSIVE", () => {
    const t = setup()
    try {
      t.writeResult({ ac_id: "AC-P4-1" }) // 缺一堆字段
      const out = runEvidence({ evidenceDir: t.dir })
      assert.equal(out.finalVerdict, "INCONCLUSIVE")
      assert.ok(out.diagnostics[0].includes("schema 缺字段"))
    } finally {
      t.cleanup()
    }
  })

  it("(9) judges/judge1 缺 → INCONCLUSIVE", () => {
    const t = setup()
    try {
      t.writeResult(GOOD_RESULT)
      // 不写 j1
      t.writeJudge(2, goodJudge("codex-gpt-5.4", "PASS"))
      const out = runEvidence({ evidenceDir: t.dir })
      assert.equal(out.finalVerdict, "INCONCLUSIVE")
      assert.ok(out.diagnostics[0].includes("judge1_claude-opus-4-7.json 不存在"))
    } finally {
      t.cleanup()
    }
  })

  it("(10) judges 字段缺 → INCONCLUSIVE", () => {
    const t = setup()
    try {
      t.writeResult(GOOD_RESULT)
      t.writeJudge(1, { judge_id: "claude-opus-4-7" } as JudgeJson) // 缺一堆字段
      t.writeJudge(2, goodJudge("codex-gpt-5.4", "PASS"))
      const out = runEvidence({ evidenceDir: t.dir })
      assert.equal(out.finalVerdict, "INCONCLUSIVE")
      assert.ok(out.diagnostics.join("\n").includes("judges 字段缺"))
    } finally {
      t.cleanup()
    }
  })

  it("(11) j1+j2 一致 PASS + 合法 screenshots+logs → final PASS", () => {
    const t = setup()
    try {
      t.writeResult(GOOD_RESULT)
      t.writeJudge(1, goodJudge("claude-opus-4-7", "PASS"))
      t.writeJudge(2, goodJudge("codex-gpt-5.4", "PASS"))
      t.writeScreenshot()
      t.writeLog()
      const out = runEvidence({
        evidenceDir: t.dir,
        requirements: { needsBrowser: true, needsBackendLogs: true },
      })
      assert.equal(out.finalVerdict, "PASS")
      assert.ok(out.diagnostics.join("\n").includes("j1 + j2 一致"))
    } finally {
      t.cleanup()
    }
  })

  it("(12) j1+j2 不一致 + 无 arbitration → INCONCLUSIVE", () => {
    const t = setup()
    try {
      t.writeResult(GOOD_RESULT)
      t.writeJudge(1, goodJudge("claude-opus-4-7", "PASS"))
      t.writeJudge(2, goodJudge("codex-gpt-5.4", "FAIL"))
      t.writeScreenshot()
      t.writeLog()
      const out = runEvidence({ evidenceDir: t.dir })
      assert.equal(out.finalVerdict, "INCONCLUSIVE")
      assert.ok(out.diagnostics.join("\n").includes("arbitration.json 不存在"))
    } finally {
      t.cleanup()
    }
  })

  it("(13) j1+j2 不一致 + arbitration FAIL → final FAIL", () => {
    const t = setup()
    try {
      t.writeResult(GOOD_RESULT)
      t.writeJudge(1, goodJudge("claude-opus-4-7", "PASS"))
      t.writeJudge(2, goodJudge("codex-gpt-5.4", "FAIL"))
      t.writeArbitration({
        ac_id: "AC-P4-1",
        judge1_verdict: "PASS",
        judge2_verdict: "FAIL",
        arbiter: "黄仁勋",
        final_verdict: "FAIL",
        reasoning: "j2 caught real gap",
      })
      t.writeScreenshot()
      t.writeLog()
      const out = runEvidence({ evidenceDir: t.dir })
      assert.equal(out.finalVerdict, "FAIL")
      assert.ok(out.diagnostics.join("\n").includes("不一致 → 仲裁"))
    } finally {
      t.cleanup()
    }
  })

  it("(14) j2 BLOCKED (quota 用尽) → final BLOCKED (含 blocked_reason)", () => {
    const t = setup()
    try {
      t.writeResult({
        ...GOOD_RESULT,
        verdict: "BLOCKED",
        blocked_reason: "codex-gpt-5.4 OAuth quota 用尽",
      })
      t.writeJudge(1, goodJudge("claude-opus-4-7", "PASS"))
      t.writeJudge(2, goodJudge("codex-gpt-5.4", "BLOCKED"))
      t.writeScreenshot()
      t.writeLog()
      const out = runEvidence({ evidenceDir: t.dir })
      assert.equal(out.finalVerdict, "BLOCKED")
      assert.ok(out.diagnostics.join("\n").includes("BLOCKED → final BLOCKED"))
      assert.ok(out.diagnostics.join("\n").includes("quota 用尽"))
    } finally {
      t.cleanup()
    }
  })

  it("(15) j2 BLOCKED 但 result.blocked_reason 缺 → INCONCLUSIVE", () => {
    const t = setup()
    try {
      // result.verdict 不写 BLOCKED 跳过 schema validation；只用 verdict=PASS + j2 BLOCKED 试探
      t.writeResult(GOOD_RESULT)
      t.writeJudge(1, goodJudge("claude-opus-4-7", "PASS"))
      t.writeJudge(2, goodJudge("codex-gpt-5.4", "BLOCKED"))
      t.writeScreenshot()
      t.writeLog()
      const out = runEvidence({ evidenceDir: t.dir })
      assert.equal(out.finalVerdict, "INCONCLUSIVE")
      assert.ok(out.diagnostics.join("\n").includes("blocked_reason 缺"))
    } finally {
      t.cleanup()
    }
  })

  it("(16) AC needsBrowser=true + screenshots 空 → INCONCLUSIVE", () => {
    const t = setup()
    try {
      t.writeResult(GOOD_RESULT)
      t.writeJudge(1, goodJudge("claude-opus-4-7", "PASS"))
      t.writeJudge(2, goodJudge("codex-gpt-5.4", "PASS"))
      t.writeLog()
      // 不写 screenshot
      const out = runEvidence({
        evidenceDir: t.dir,
        requirements: { needsBrowser: true, needsBackendLogs: false },
      })
      assert.equal(out.finalVerdict, "INCONCLUSIVE")
      assert.ok(out.diagnostics.join("\n").includes("screenshots/ 空"))
    } finally {
      t.cleanup()
    }
  })

  it("(17) AC needsBackendLogs=true + logs 空 → INCONCLUSIVE", () => {
    const t = setup()
    try {
      t.writeResult(GOOD_RESULT)
      t.writeJudge(1, goodJudge("claude-opus-4-7", "PASS"))
      t.writeJudge(2, goodJudge("codex-gpt-5.4", "PASS"))
      // 不写 log
      const out = runEvidence({
        evidenceDir: t.dir,
        requirements: { needsBrowser: false, needsBackendLogs: true },
      })
      assert.equal(out.finalVerdict, "INCONCLUSIVE")
      assert.ok(out.diagnostics.join("\n").includes("logs/ 空"))
    } finally {
      t.cleanup()
    }
  })
})
