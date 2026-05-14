import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseArgs as parseNodeArgs } from "node:util"
import { createOpusRunner } from "../src/runtime/haiku-runner"

const DEFAULT_JUDGE = "claude-opus-4-7"
const JUDGE_TIMEOUT_MS = 60000

const EVIDENCE_FILES = [
  "prompt.txt",
  "agent_response.txt",
  "db_dump.sql",
  "wiki_state.tar.gz",
  "config.hash",
  "prod_config_diff.txt",
  "result.json",
] as const

const TEXT_EVIDENCE_LIMITS: Partial<Record<(typeof EVIDENCE_FILES)[number], number>> = {
  "agent_response.txt": 9000,
  "db_dump.sql": 5000,
  "result.json": 6000,
  "prompt.txt": 3000,
}

const DEFAULT_TEXT_EVIDENCE_LIMIT = 1500

const AC_TEXT: Record<string, string> = {
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
}

export interface BuildJudgePromptInput {
  ac: string
  evidenceDir: string
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
    },
    strict: true,
  })

  const ac = parsed.values.ac
  const evidence = parsed.values.evidence
  const out = parsed.values.out
  const judge = parsed.values.judge ?? DEFAULT_JUDGE
  if (!ac || !evidence || !out) {
    throw new Error("Usage: p18-judge.ts --ac AC-P1-N --evidence <dir> --out <judge1.json>")
  }
  if (!/^AC-P1-\d+$/.test(ac)) {
    throw new Error(`Invalid --ac value: ${ac}`)
  }
  if (judge !== DEFAULT_JUDGE) {
    throw new Error(`Unsupported --judge value: ${judge}; this wrapper is for ${DEFAULT_JUDGE}`)
  }
  return { ac, evidence, out, judge }
}

export function buildJudgePrompt(input: BuildJudgePromptInput): string {
  const sections = EVIDENCE_FILES.map((name) =>
    renderEvidenceFile(path.join(input.evidenceDir, name), name),
  )
  const acText = AC_TEXT[input.ac] ?? "AC text not found in wrapper map; judge should verify against evidence and mark INCONCLUSIVE if ambiguous."

  return [
    "You are the F027-P18 evidence pack judge.",
    "",
    `Spec AC: ${input.ac}`,
    acText,
    "",
    "Judge rules:",
    "- PASS: all 7 evidence pack files are present, result.json verdict=PASS, and observed behavior matches the AC.",
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

function renderEvidenceFile(filePath: string, label: string): string {
  if (!existsSync(filePath)) {
    return `## ${label}\nMISSING`
  }

  const stat = statSync(filePath)
  if (label === "wiki_state.tar.gz") {
    const bytes = readFileSync(filePath)
    return `## ${label}\nexists=true\nsize_bytes=${stat.size}\nsha256=${createHash("sha256").update(bytes).digest("hex")}`
  }

  const content = readFileSync(filePath, "utf8")
  const maxChars = TEXT_EVIDENCE_LIMITS[label as (typeof EVIDENCE_FILES)[number]] ?? DEFAULT_TEXT_EVIDENCE_LIMIT
  return `## ${label}\n${truncate(content, maxChars)}`
}

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`
}

async function main() {
  const args = parseJudgeArgs(process.argv.slice(2))
  const prompt = buildJudgePrompt({ ac: args.ac, evidenceDir: args.evidence })
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
