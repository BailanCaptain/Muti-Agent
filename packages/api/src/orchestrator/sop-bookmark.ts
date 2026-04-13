export type SOPBookmark = {
  skill: string | null
  phase: string | null
  lastCompletedStep: string
  nextExpectedAction: string
  blockingQuestion: string | null
  updatedAt: string
}

const PHASE_PATTERNS: Array<{ pattern: RegExp; phase: string; next: string }> = [
  { pattern: /red\s*phase|写.*失败.*测试|failing test/i, phase: "red", next: "minimal implementation" },
  { pattern: /green\s*phase|测试通过|tests?\s*pass/i, phase: "green", next: "refactor" },
  { pattern: /refactor/i, phase: "refactor", next: "commit" },
  { pattern: /review|审查|code.?review/i, phase: "review", next: "address feedback" },
  { pattern: /merge|合入|squash/i, phase: "merge", next: "verify CI" },
  { pattern: /quality.?gate|自检|门禁/i, phase: "quality-gate", next: "request review" },
  { pattern: /acceptance|验收/i, phase: "acceptance", next: "address findings" },
  { pattern: /handoff|交接/i, phase: "handoff", next: "wait for response" },
]

export function extractSOPBookmark(agentOutput: string, currentSopStage: string | null): SOPBookmark {
  const now = new Date().toISOString()

  if (!currentSopStage) {
    return { skill: null, phase: null, lastCompletedStep: "", nextExpectedAction: "", blockingQuestion: null, updatedAt: now }
  }

  let detectedPhase: string | null = null
  let nextAction = ""
  let lastStep = ""

  for (const { pattern, phase, next } of PHASE_PATTERNS) {
    if (pattern.test(agentOutput)) {
      detectedPhase = phase
      nextAction = next
      const match = pattern.exec(agentOutput)
      if (match) {
        const start = Math.max(0, match.index - 20)
        const end = Math.min(agentOutput.length, match.index + match[0].length + 40)
        lastStep = agentOutput.slice(start, end).replace(/\n/g, " ").trim()
      }
      break
    }
  }

  const blockMatch = /\[分歧点\](.+?)(?:\n|$)/.exec(agentOutput)
  const blocking = blockMatch ? blockMatch[1].trim() : null

  return {
    skill: currentSopStage,
    phase: detectedPhase,
    lastCompletedStep: lastStep,
    nextExpectedAction: nextAction,
    blockingQuestion: blocking,
    updatedAt: now,
  }
}

export function formatBookmarkForInjection(bookmark: SOPBookmark): string {
  if (!bookmark.skill) return ""
  const parts = [
    `skill=${bookmark.skill}`,
    `phase=${bookmark.phase ?? "unknown"}`,
    `last=${bookmark.lastCompletedStep || "none"}`,
    `next=${bookmark.nextExpectedAction || "none"}`,
    `blocking=${bookmark.blockingQuestion ?? "none"}`,
  ]
  return parts.join(" | ")
}
