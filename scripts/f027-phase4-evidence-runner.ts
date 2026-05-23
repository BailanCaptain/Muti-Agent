/**
 * F027 Phase 4 AC-P4-5 · 三层验证套件 runner
 *
 * 真相源:
 *   - docs/plans/F027-phase4-implementation-plan.md AC-P4-5 (line 220-223)
 *   - docs/plans/F027-phase4-implementation-plan.md §12 artifact schema (line 434-509)
 *   - feedback codex_judge2_finds_real_gaps (BLOCKED ≠ SKIP=PASS)
 *
 * 输入 (evidence pack 目录):
 *   docs/features/F027/evidence/phase4/AC-P4-<N>/
 *     ├── result.json                       (AC 元数据 + final verdict)
 *     ├── judges/
 *     │   ├── judge1_claude-opus-4-7.json   (j1 verdict + reasoning)
 *     │   ├── judge2_codex-gpt-5.4.json     (j2 verdict + reasoning)
 *     │   └── arbitration.json              (j1 vs j2 不一致时黄仲裁)
 *     ├── screenshots/                       (browser 实测截图，AC 需要时必)
 *     └── logs/                              (后端 log 摘录，AC 需要后端验证时必)
 *
 * Runner 行为:
 *   1. 读 result.json + judges/*.json
 *   2. validate §12 schema (字段完整)
 *   3. apply INCONCLUSIVE 规则:
 *      - result.json 缺任一必字段 → INCONCLUSIVE
 *      - judges/judge1.json 或 judge2.json 缺 → INCONCLUSIVE
 *      - judges/arbitration.json 缺 且 j1/j2 verdict 不一致 → INCONCLUSIVE
 *      - screenshots/ 空 + AC 需要 browser 实测 → INCONCLUSIVE
 *      - logs/ 空 + AC 需要后端验证 → INCONCLUSIVE
 *   4. combine verdict:
 *      - j1 + j2 一致 → 用一致结果
 *      - j1 + j2 不一致 → arbitration.final_verdict
 *      - 任一 judge = BLOCKED → final BLOCKED (j2 quota 用尽 不等价 PASS)
 *   5. 输出 finalVerdict + 诊断
 *
 * BLOCKED vs INCONCLUSIVE 语义:
 *   - BLOCKED  = 外部因素阻塞 (j2 OAuth quota 用尽 / dep 未就绪)
 *   - INCONCLUSIVE = evidence 没收齐 (字段缺 / 文件缺)
 *   - 两者都不可合 dev (per plan line 508)
 *
 * 不做 (Day 14-15 范围外，留 Week 4 walkthrough):
 *   - 实际调 LLM judge (Week 4 跑双 judge 时用 codex CLI / Anthropic SDK)
 *   - browser 截图自动化 (留 walkthrough 手测)
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// ─── §12 artifact schema types ────────────────────────────────────────────────

export type Verdict = "PASS" | "CONDITIONAL_PASS" | "FAIL" | "BLOCKED" | "INCONCLUSIVE"

export interface ResultJson {
  ac_id: string
  title: string
  phase: "phase4"
  verdict: Verdict
  double_pass: {
    judge1_verdict: Verdict
    judge2_verdict: Verdict
    arbitration_verdict: Verdict | null
    consensus: boolean
  }
  evidence_paths: {
    screenshots: string[]
    logs: string[]
    code_anchors: string[]
  }
  /** verdict=BLOCKED 时必填 */
  blocked_reason?: string
  /** verdict=INCONCLUSIVE 时必填 */
  inconclusive_reason?: string
}

export interface JudgeJson {
  judge_id: "claude-opus-4-7" | "codex-gpt-5.4"
  ac_id: string
  verdict: Verdict
  reasoning: string
  cited_evidence: string[]
  spec_gate: "PASS" | "FAIL"
  mechanism_gate: "PASS" | "FAIL"
  feature_gate: "PASS" | "FAIL"
  p1_findings: unknown[]
  p2_findings: unknown[]
  p3_findings: unknown[]
}

export interface ArbitrationJson {
  ac_id: string
  judge1_verdict: Verdict
  judge2_verdict: Verdict
  arbiter: string
  final_verdict: Verdict
  reasoning: string
}

// ─── AC requirements (which checks each AC needs) ────────────────────────────

export interface AcRequirements {
  /** AC 需要 browser 实测截图? → screenshots/ 必非空 */
  needsBrowser: boolean
  /** AC 需要后端 log 验证? → logs/ 必非空 */
  needsBackendLogs: boolean
}

/** Default: 一般 backend-only AC */
export const DEFAULT_REQUIREMENTS: AcRequirements = {
  needsBrowser: false,
  needsBackendLogs: true,
}

/** Phase 4 各 AC 的默认 requirements (caller 可覆盖) */
export const PHASE4_AC_REQUIREMENTS: Record<string, AcRequirements> = {
  "AC-P4-1": { needsBrowser: true, needsBackendLogs: true }, // PromoteModal UI + backend
  "AC-P4-2": { needsBrowser: true, needsBackendLogs: true }, // V14 reject UI
  "AC-P4-3": { needsBrowser: true, needsBackendLogs: false }, // 审批操作入口 UI
  "AC-P4-4": { needsBrowser: true, needsBackendLogs: true }, // 批量审批 UI + batch endpoint
  "AC-P4-5": { needsBrowser: false, needsBackendLogs: false }, // runner 本身 (自验证不需 walkthrough)
  "AC-P4-6": { needsBrowser: true, needsBackendLogs: true }, // walkthrough 三场景
  "AC-P4-8": { needsBrowser: false, needsBackendLogs: true }, // AdaptiveRecallCoordinator boot
  "AC-P4-9": { needsBrowser: true, needsBackendLogs: true }, // warnings + KB + Inspector + seed
}

// ─── Runner 主流程 ────────────────────────────────────────────────────────────

export interface RunnerInput {
  /** evidence pack 目录绝对路径 */
  evidenceDir: string
  /** AC requirements (可选；缺省查 PHASE4_AC_REQUIREMENTS) */
  requirements?: AcRequirements
}

export interface RunnerOutput {
  acId: string
  finalVerdict: Verdict
  /** 详细诊断 (verdict 由来 / 缺字段 / consensus 结果) */
  diagnostics: string[]
  /** result.json 解析 (validation 通过时填) */
  result?: ResultJson
  /** j1/j2 解析 */
  judges?: { j1?: JudgeJson; j2?: JudgeJson; arbitration?: ArbitrationJson }
}

export function runEvidence(input: RunnerInput): RunnerOutput {
  const diagnostics: string[] = []
  const evidenceDir = input.evidenceDir
  const acId = inferAcIdFromPath(evidenceDir)

  // ── 1. result.json ──────────────────────────────────────────────
  const resultPath = path.join(evidenceDir, "result.json")
  if (!existsSync(resultPath)) {
    return {
      acId,
      finalVerdict: "INCONCLUSIVE",
      diagnostics: [`result.json 不存在: ${resultPath}`],
    }
  }
  const resultRaw = JSON.parse(readFileSync(resultPath, "utf-8")) as Partial<ResultJson>
  const resultValidation = validateResultJsonSchema(resultRaw)
  if (resultValidation.length > 0) {
    return {
      acId,
      finalVerdict: "INCONCLUSIVE",
      diagnostics: ["result.json schema 缺字段:", ...resultValidation.map((s) => `  - ${s}`)],
    }
  }
  const result = resultRaw as ResultJson

  // ── 2. judges/*.json ───────────────────────────────────────────
  const judgesDir = path.join(evidenceDir, "judges")
  const j1Path = path.join(judgesDir, "judge1_claude-opus-4-7.json")
  const j2Path = path.join(judgesDir, "judge2_codex-gpt-5.4.json")
  const arbPath = path.join(judgesDir, "arbitration.json")

  if (!existsSync(j1Path)) {
    return {
      acId,
      finalVerdict: "INCONCLUSIVE",
      diagnostics: ["judges/judge1_claude-opus-4-7.json 不存在"],
      result,
    }
  }
  if (!existsSync(j2Path)) {
    return {
      acId,
      finalVerdict: "INCONCLUSIVE",
      diagnostics: ["judges/judge2_codex-gpt-5.4.json 不存在"],
      result,
    }
  }

  const j1Raw = JSON.parse(readFileSync(j1Path, "utf-8")) as Partial<JudgeJson>
  const j2Raw = JSON.parse(readFileSync(j2Path, "utf-8")) as Partial<JudgeJson>
  const j1Validation = validateJudgeJsonSchema(j1Raw, "claude-opus-4-7")
  const j2Validation = validateJudgeJsonSchema(j2Raw, "codex-gpt-5.4")
  if (j1Validation.length > 0 || j2Validation.length > 0) {
    return {
      acId,
      finalVerdict: "INCONCLUSIVE",
      diagnostics: [
        "judges 字段缺:",
        ...j1Validation.map((s) => `  judge1: ${s}`),
        ...j2Validation.map((s) => `  judge2: ${s}`),
      ],
      result,
    }
  }
  const j1 = j1Raw as JudgeJson
  const j2 = j2Raw as JudgeJson

  // ── 3. requirements gates: screenshots / logs ──────────────────
  // (放 BLOCKED check 之前，确保即使 BLOCKED 也有 evidence pack 完整性)
  const reqs = input.requirements ?? PHASE4_AC_REQUIREMENTS[acId] ?? DEFAULT_REQUIREMENTS
  if (reqs.needsBrowser) {
    const screenshotsDir = path.join(evidenceDir, "screenshots")
    if (!dirHasAnyFile(screenshotsDir)) {
      return {
        acId,
        finalVerdict: "INCONCLUSIVE",
        diagnostics: ["AC 需要 browser 实测 (needsBrowser=true)，但 screenshots/ 空"],
        result,
        judges: { j1, j2 },
      }
    }
  }
  if (reqs.needsBackendLogs) {
    const logsDir = path.join(evidenceDir, "logs")
    if (!dirHasAnyFile(logsDir)) {
      return {
        acId,
        finalVerdict: "INCONCLUSIVE",
        diagnostics: ["AC 需要 backend 验证 (needsBackendLogs=true)，但 logs/ 空"],
        result,
        judges: { j1, j2 },
      }
    }
  }

  // ── 4. BLOCKED 优先 (在 arbitration 之前 — j2 quota 用尽不算"不一致"需仲裁) ───
  if (j1.verdict === "BLOCKED" || j2.verdict === "BLOCKED") {
    diagnostics.push(
      "任一 judge BLOCKED → final BLOCKED (per feedback codex_judge2_finds_real_gaps)",
    )
    if (!result.blocked_reason) {
      return {
        acId,
        finalVerdict: "INCONCLUSIVE",
        diagnostics: [
          ...diagnostics,
          "verdict=BLOCKED 但 result.json.blocked_reason 缺 (§12 必填)",
        ],
        result,
        judges: { j1, j2 },
      }
    }
    return {
      acId,
      finalVerdict: "BLOCKED",
      diagnostics: [...diagnostics, `blocked_reason=${result.blocked_reason}`],
      result,
      judges: { j1, j2 },
    }
  }

  // ── 5. j1+j2 不一致 时检查 arbitration ─────────────────────────
  let arbitration: ArbitrationJson | undefined
  const verdictsMatch = j1.verdict === j2.verdict
  if (!verdictsMatch) {
    if (!existsSync(arbPath)) {
      return {
        acId,
        finalVerdict: "INCONCLUSIVE",
        diagnostics: [
          `j1 verdict=${j1.verdict} vs j2 verdict=${j2.verdict} 不一致，但 judges/arbitration.json 不存在`,
        ],
        result,
        judges: { j1, j2 },
      }
    }
    const arbRaw = JSON.parse(readFileSync(arbPath, "utf-8")) as Partial<ArbitrationJson>
    const arbValidation = validateArbitrationJsonSchema(arbRaw)
    if (arbValidation.length > 0) {
      return {
        acId,
        finalVerdict: "INCONCLUSIVE",
        diagnostics: ["arbitration.json schema 缺字段:", ...arbValidation.map((s) => `  - ${s}`)],
        result,
        judges: { j1, j2 },
      }
    }
    arbitration = arbRaw as ArbitrationJson
  }

  // ── 6. combine final verdict (BLOCKED 已先处理) ────────────────
  if (verdictsMatch) {
    diagnostics.push(`j1 + j2 一致 (verdict=${j1.verdict})，consensus=true`)
    return {
      acId,
      finalVerdict: j1.verdict,
      diagnostics,
      result,
      judges: { j1, j2 },
    }
  }

  // j1 + j2 不一致 → 用 arbitration final_verdict
  diagnostics.push(
    `j1=${j1.verdict} vs j2=${j2.verdict} 不一致 → 仲裁 ${arbitration?.arbiter} 决议 ${arbitration?.final_verdict}`,
  )
  return {
    acId,
    finalVerdict: arbitration!.final_verdict,
    diagnostics,
    result,
    judges: { j1, j2, arbitration },
  }
}

// ─── Schema validators (return missing-field strings) ────────────────────────

export function validateResultJsonSchema(r: Partial<ResultJson>): string[] {
  const missing: string[] = []
  if (typeof r.ac_id !== "string") missing.push("ac_id")
  if (typeof r.title !== "string") missing.push("title")
  if (r.phase !== "phase4") missing.push("phase (must be 'phase4')")
  if (!isVerdict(r.verdict)) missing.push("verdict")
  if (!r.double_pass) missing.push("double_pass")
  else {
    if (!isVerdict(r.double_pass.judge1_verdict)) missing.push("double_pass.judge1_verdict")
    if (!isVerdict(r.double_pass.judge2_verdict)) missing.push("double_pass.judge2_verdict")
    if (typeof r.double_pass.consensus !== "boolean") missing.push("double_pass.consensus")
    // codex end-r2 P2 修: arbitration_verdict 字段必须 present (允许 null 但不能 undefined)
    if (!("arbitration_verdict" in r.double_pass)) {
      missing.push("double_pass.arbitration_verdict (must be present, can be null)")
    } else if (
      r.double_pass.arbitration_verdict !== null &&
      !isVerdict(r.double_pass.arbitration_verdict)
    ) {
      missing.push("double_pass.arbitration_verdict (must be null or a valid Verdict)")
    }
  }
  if (!r.evidence_paths) missing.push("evidence_paths")
  else {
    if (!Array.isArray(r.evidence_paths.screenshots)) missing.push("evidence_paths.screenshots")
    if (!Array.isArray(r.evidence_paths.logs)) missing.push("evidence_paths.logs")
    if (!Array.isArray(r.evidence_paths.code_anchors)) missing.push("evidence_paths.code_anchors")
  }
  if (r.verdict === "BLOCKED" && (!r.blocked_reason || r.blocked_reason.length === 0)) {
    missing.push("blocked_reason (required when verdict=BLOCKED)")
  }
  if (
    r.verdict === "INCONCLUSIVE" &&
    (!r.inconclusive_reason || r.inconclusive_reason.length === 0)
  ) {
    missing.push("inconclusive_reason (required when verdict=INCONCLUSIVE)")
  }
  return missing
}

export function validateJudgeJsonSchema(
  j: Partial<JudgeJson>,
  expectedJudgeId: JudgeJson["judge_id"],
): string[] {
  const missing: string[] = []
  if (j.judge_id !== expectedJudgeId) missing.push(`judge_id (expected ${expectedJudgeId})`)
  if (typeof j.ac_id !== "string") missing.push("ac_id")
  if (!isVerdict(j.verdict)) missing.push("verdict")
  if (typeof j.reasoning !== "string" || j.reasoning.length === 0) missing.push("reasoning")
  if (!Array.isArray(j.cited_evidence)) missing.push("cited_evidence")
  if (j.spec_gate !== "PASS" && j.spec_gate !== "FAIL") missing.push("spec_gate")
  if (j.mechanism_gate !== "PASS" && j.mechanism_gate !== "FAIL") missing.push("mechanism_gate")
  if (j.feature_gate !== "PASS" && j.feature_gate !== "FAIL") missing.push("feature_gate")
  if (!Array.isArray(j.p1_findings)) missing.push("p1_findings")
  if (!Array.isArray(j.p2_findings)) missing.push("p2_findings")
  if (!Array.isArray(j.p3_findings)) missing.push("p3_findings")
  return missing
}

export function validateArbitrationJsonSchema(a: Partial<ArbitrationJson>): string[] {
  const missing: string[] = []
  if (typeof a.ac_id !== "string") missing.push("ac_id")
  if (!isVerdict(a.judge1_verdict)) missing.push("judge1_verdict")
  if (!isVerdict(a.judge2_verdict)) missing.push("judge2_verdict")
  if (typeof a.arbiter !== "string") missing.push("arbiter")
  if (!isVerdict(a.final_verdict)) missing.push("final_verdict")
  if (typeof a.reasoning !== "string" || a.reasoning.length === 0) missing.push("reasoning")
  return missing
}

function isVerdict(v: unknown): v is Verdict {
  return (
    v === "PASS" ||
    v === "CONDITIONAL_PASS" ||
    v === "FAIL" ||
    v === "BLOCKED" ||
    v === "INCONCLUSIVE"
  )
}

function dirHasAnyFile(dir: string): boolean {
  if (!existsSync(dir)) return false
  try {
    const entries = readdirSync(dir)
    return entries.some((name) => {
      try {
        return statSync(path.join(dir, name)).isFile()
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

function inferAcIdFromPath(p: string): string {
  // e.g. .../evidence/phase4/AC-P4-1 → AC-P4-1
  const base = path.basename(p)
  if (/^AC-P4-\w+$/.test(base)) return base
  return base // 兜底
}

// ─── CLI entry (optional, for manual runner trigger) ─────────────────────────

/**
 * codex end-r2 P1 修: 原本用 `import.meta.url === \`file://${argv1}\`` 在 Windows 下永不匹配
 * (import.meta.url 是 `file:///C:/...` 三斜杠, argv1 是 `C:\\...` 反斜杠), 导致 CLI fail open
 * (script 啥都不做 exit 0)。改用 fileURLToPath + path.resolve cross-platform safe 比较。
 *
 * Exported for test (避免 mock process / direct call CLI 路径)。
 */
export function isInvokedAsMain(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false
  try {
    const scriptPath = fileURLToPath(metaUrl)
    return path.resolve(argv1) === scriptPath
  } catch {
    return false
  }
}

if (isInvokedAsMain(import.meta.url, process.argv[1])) {
  const dir = process.argv[2]
  if (!dir) {
    console.error("Usage: tsx scripts/f027-phase4-evidence-runner.ts <evidence-dir>")
    process.exit(1)
  }
  const out = runEvidence({ evidenceDir: path.resolve(dir) })
  console.log(JSON.stringify(out, null, 2))
  // Exit code 由 verdict 决定 (CI gate 用)
  const ok = out.finalVerdict === "PASS" || out.finalVerdict === "CONDITIONAL_PASS"
  process.exit(ok ? 0 : 1)
}
