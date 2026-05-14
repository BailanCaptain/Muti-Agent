import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseArgs as parseNodeArgs } from "node:util"
import { createOpusRunner } from "../src/runtime/haiku-runner"

const DEFAULT_JUDGE = "claude-opus-4-7"
const JUDGE_TIMEOUT_MS = 60000

/**
 * F027 P19.16 · generic 化（v2 新增）—— 让 Phase 2/3/N evidence pack 复用本 wrapper。
 *
 * 默认值保 Phase 1 back-compat：未显式传 --ac-pattern / --evidence-files /
 * --ac-text-file 时按 Phase 1 7 件套 + AC-P1-N 模式跑，旧调用不动。
 *
 * 新参数（Phase 2 evidence pack P19.17 用）：
 *   --ac-pattern <regex>      —— override AC 名格式校验（如 ^AC-P2-\d+[ab]?$）
 *   --evidence-files <csv>    —— override 待读 evidence 文件清单
 *   --ac-text-file <json-path> —— override AC 描述映射（JSON: { "AC-P2-1": "text" }）
 */
export const DEFAULT_AC_PATTERN = "^AC-P1-\\d+$"

export const DEFAULT_PHASE1_EVIDENCE_FILES = [
  "prompt.txt",
  "agent_response.txt",
  "db_dump.sql",
  "wiki_state.tar.gz",
  "config.hash",
  "prod_config_diff.txt",
  "result.json",
] as const

export const DEFAULT_PHASE1_TEXT_EVIDENCE_LIMITS: Record<string, number> = {
  "agent_response.txt": 9000,
  "db_dump.sql": 5000,
  "result.json": 6000,
  "prompt.txt": 3000,
}

const DEFAULT_TEXT_EVIDENCE_LIMIT = 1500

export const DEFAULT_PHASE1_AC_TEXT: Record<string, string> = {
  "AC-P1-1": "4 tables schema + EXPLAIN <= 50ms; db_dump.sql should include sqlite_master and indices evidence.",
  "AC-P1-2":
    "update_wiki MCP ACL/CAS/lease/fencing fuzz 100 concurrent attempts; evidence should include race trace and retry log.",
  "AC-P1-3":
    "LLM compile 3-stage end-to-end PASS with RAG paper fixture and 19 frontmatter fields reconciled.",
  "AC-P1-4":
    "sanitize 5-layer defense fixtures all hit; result should include chained_suspect marking where applicable.",
  "AC-P1-5":
    "multi-drop cross-correlation series fixture is distinguished from chained_suspect fixture with similarity evidence.",
  "AC-P1-6": "Handbook 4 H2 slicing and cross-file dedupe lint red/green fixture evidence.",
  "AC-P1-7": 'single injection contract: grep "Iron Laws" = 1 and harness injection count <= 2.',
  "AC-P1-8": "agent-sessions ledger 100k session sharding with active session count < 1k.",
  "AC-P1-9": "6 memory segment types and canonical_owner lint red/green fixture evidence.",
  "AC-P1-10": "viewfinder anti-drift 100-iteration telephone-game drift <= 30% with intervention.",
  "AC-P1-11":
    "memory_preflight north-star recall query hits F011/F021 or equivalent target evidence and renders injected section.",
  "AC-P1-12":
    "Adaptive Recall 5-level fallback fixture triggers levels 1-5 and Level5 escalation with recall_satisfied/escalate_reason evidence.",
  "AC-P1-13":
    "alias-aware capability registry rewrites sender-risk handoff; red fixture hits forbidden strings, green fixture has zero hits and required fields.",
  "AC-P1-14":
    "Phase 1 evidence pack framework itself: all 14 AC evidence packs, two judge JSON files, and arbitration JSON are present.",
}

export interface JudgeArgs {
  ac: string
  evidence: string
  out: string
  judge: string
  /** v2 P19.16: AC 名格式 regex；默认 Phase 1 ^AC-P1-\d+$。 */
  acPattern: string
  /** v2 P19.16: evidence 文件清单；默认 Phase 1 7 件套。 */
  evidenceFiles: readonly string[]
  /** v2 P19.16: AC 描述 map；默认 Phase 1 内置（DEFAULT_PHASE1_AC_TEXT）。 */
  acText: Record<string, string>
}

export interface BuildJudgePromptInput {
  ac: string
  evidenceDir: string
  /** v2 P19.16 optional override；缺省走 DEFAULT_PHASE1_EVIDENCE_FILES。 */
  evidenceFiles?: readonly string[]
  /** v2 P19.16 optional override；缺省走 DEFAULT_PHASE1_TEXT_EVIDENCE_LIMITS。 */
  evidenceLimits?: Record<string, number>
  /** v2 P19.16 optional override；缺省走 DEFAULT_PHASE1_AC_TEXT。 */
  acText?: Record<string, string>
}

export interface JudgeJson {
  verdict: "PASS" | "BLOCKED" | "INCONCLUSIVE" | "FAIL"
  reason: string
  weak_points: string[]
  [key: string]: unknown
}

export function parseJudgeArgs(argv: string[]): JudgeArgs {
  const parsed = parseNodeArgs({
    args: argv,
    options: {
      ac: { type: "string" },
      evidence: { type: "string" },
      out: { type: "string" },
      judge: { type: "string", default: DEFAULT_JUDGE },
      "ac-pattern": { type: "string", default: DEFAULT_AC_PATTERN },
      "evidence-files": { type: "string" },
      "ac-text-file": { type: "string" },
    },
    strict: true,
  })

  const ac = parsed.values.ac
  const evidence = parsed.values.evidence
  const out = parsed.values.out
  const judge = parsed.values.judge ?? DEFAULT_JUDGE
  const acPattern = parsed.values["ac-pattern"] ?? DEFAULT_AC_PATTERN
  const evidenceFilesArg = parsed.values["evidence-files"]
  const acTextFileArg = parsed.values["ac-text-file"]

  if (!ac || !evidence || !out) {
    throw new Error(
      "Usage: p18-judge.ts --ac <AC-id> --evidence <dir> --out <judge1.json> " +
        "[--ac-pattern '<regex>'] [--evidence-files 'a,b,c'] [--ac-text-file <path>]",
    )
  }

  // 校验 ac-pattern regex 自身可编译
  let acRegex: RegExp
  try {
    acRegex = new RegExp(acPattern)
  } catch (err) {
    throw new Error(`Invalid --ac-pattern '${acPattern}': ${(err as Error).message}`)
  }
  if (!acRegex.test(ac)) {
    throw new Error(`Invalid --ac value '${ac}' (does not match --ac-pattern '${acPattern}')`)
  }

  if (judge !== DEFAULT_JUDGE) {
    throw new Error(`Unsupported --judge value: ${judge}; this wrapper is for ${DEFAULT_JUDGE}`)
  }

  // evidenceFiles：CSV → string[]；缺省 Phase 1 默认
  const evidenceFiles: readonly string[] = evidenceFilesArg
    ? evidenceFilesArg
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : DEFAULT_PHASE1_EVIDENCE_FILES
  if (evidenceFiles.length === 0) {
    throw new Error("--evidence-files: parsed empty list")
  }

  // acText：JSON 文件加载；缺省 Phase 1 默认
  let acText: Record<string, string> = DEFAULT_PHASE1_AC_TEXT
  if (acTextFileArg) {
    if (!existsSync(acTextFileArg)) {
      throw new Error(`--ac-text-file not found: ${acTextFileArg}`)
    }
    const raw = readFileSync(acTextFileArg, "utf8")
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch (err) {
      throw new Error(`--ac-text-file invalid JSON at ${acTextFileArg}: ${(err as Error).message}`)
    }
    if (typeof parsedJson !== "object" || parsedJson === null || Array.isArray(parsedJson)) {
      throw new Error(`--ac-text-file must be JSON object { "AC-id": "text" } at ${acTextFileArg}`)
    }
    acText = parsedJson as Record<string, string>
  }

  return { ac, evidence, out, judge, acPattern, evidenceFiles, acText }
}

export function buildJudgePrompt(input: BuildJudgePromptInput): string {
  const evidenceFiles = input.evidenceFiles ?? DEFAULT_PHASE1_EVIDENCE_FILES
  const evidenceLimits = input.evidenceLimits ?? DEFAULT_PHASE1_TEXT_EVIDENCE_LIMITS
  const acTextMap = input.acText ?? DEFAULT_PHASE1_AC_TEXT

  const sections = evidenceFiles.map((name) =>
    renderEvidenceFile(path.join(input.evidenceDir, name), name, evidenceLimits),
  )
  const acText =
    acTextMap[input.ac] ??
    "AC text not found in wrapper map; judge should verify against evidence and mark INCONCLUSIVE if ambiguous."

  return [
    "You are the F027 evidence pack judge.",
    "",
    `Spec AC: ${input.ac}`,
    acText,
    "",
    "Judge rules:",
    `- PASS: all ${evidenceFiles.length} evidence pack files are present, result.json verdict=PASS, and observed behavior matches the AC.`,
    "- BLOCKED: evidence is incomplete or dependency/quota/environment prevented verification.",
    "- INCONCLUSIVE: commands ran but the assertion is ambiguous or evidence is insufficient to prove the AC.",
    "- FAIL: executed evidence contradicts the AC or result.json reports failure.",
    "",
    'Return JSON only: {"verdict":"PASS|BLOCKED|INCONCLUSIVE|FAIL","reason":"<=200 chars","weak_points":["..."]}',
    "",
    "Evidence pack:",
    sections.join("\n\n"),
  ].join("\n")
}

export function extractJudgeJson(text: string): JudgeJson {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidate = fenced?.[1] ?? trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)
  if (!candidate || candidate === trimmed.slice(0, 0)) {
    throw new Error("Claude output did not contain a JSON object")
  }
  const parsed = JSON.parse(candidate) as Partial<JudgeJson>
  if (
    parsed.verdict !== "PASS" &&
    parsed.verdict !== "BLOCKED" &&
    parsed.verdict !== "INCONCLUSIVE" &&
    parsed.verdict !== "FAIL"
  ) {
    throw new Error(`Invalid judge verdict: ${String(parsed.verdict)}`)
  }
  if (typeof parsed.reason !== "string" || !Array.isArray(parsed.weak_points)) {
    throw new Error("Judge JSON must include reason:string and weak_points:array")
  }
  return parsed as JudgeJson
}

function renderEvidenceFile(
  filePath: string,
  label: string,
  limits: Record<string, number> = DEFAULT_PHASE1_TEXT_EVIDENCE_LIMITS,
): string {
  if (!existsSync(filePath)) {
    return `## ${label}\nMISSING`
  }

  const stat = statSync(filePath)
  // 二进制 / 压缩文件按 hash 报；通过文件名后缀判别（generic 化兼容 .tar.gz / .zip / .gz）
  if (/\.(tar\.gz|tgz|zip|gz)$/i.test(label)) {
    const bytes = readFileSync(filePath)
    return `## ${label}\nexists=true\nsize_bytes=${stat.size}\nsha256=${createHash("sha256").update(bytes).digest("hex")}`
  }

  const content = readFileSync(filePath, "utf8")
  const maxChars = limits[label] ?? DEFAULT_TEXT_EVIDENCE_LIMIT
  return `## ${label}\n${truncate(content, maxChars)}`
}

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`
}

async function main() {
  const args = parseJudgeArgs(process.argv.slice(2))
  const prompt = buildJudgePrompt({
    ac: args.ac,
    evidenceDir: args.evidence,
    evidenceFiles: args.evidenceFiles,
    acText: args.acText,
  })
  const runner = createOpusRunner()
  const result = await runner.runPrompt(prompt, { timeoutMs: JUDGE_TIMEOUT_MS })

  mkdirSync(path.dirname(args.out), { recursive: true })
  if (!result.ok) {
    const blocked: JudgeJson = {
      verdict: "BLOCKED",
      reason: `judge runner failed: ${result.error ?? "unknown"}`,
      weak_points: ["Claude Opus 4.7 runner did not return usable JSON."],
    }
    writeFileSync(args.out, `${JSON.stringify(blocked, null, 2)}\n`)
    process.exit(2)
  }

  const judgeJson = extractJudgeJson(result.text)
  writeFileSync(args.out, `${JSON.stringify(judgeJson, null, 2)}\n`)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
