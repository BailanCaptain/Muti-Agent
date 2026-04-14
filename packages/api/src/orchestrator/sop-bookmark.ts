export type SOPBookmark = {
  skill: string | null
  phase: string | null
  lastCompletedStep: string
  nextExpectedAction: string
  blockingQuestion: string | null
  updatedAt: string
}

export function extractSOPBookmark(agentOutput: string, currentSopStage: string | null): SOPBookmark {
  const now = new Date().toISOString()

  if (!currentSopStage) {
    return { skill: null, phase: null, lastCompletedStep: "", nextExpectedAction: "", blockingQuestion: null, updatedAt: now }
  }

  if (currentSopStage.startsWith("completed:")) {
    const skill = currentSopStage.slice("completed:".length)
    return {
      skill,
      phase: "completed",
      lastCompletedStep: agentOutput.slice(-200).replace(/\n/g, " ").trim(),
      nextExpectedAction: "",
      blockingQuestion: null,
      updatedAt: now,
    }
  }

  const blockMatch = /\[分歧点\](.+?)(?:\n|$)/.exec(agentOutput)
  const blocking = blockMatch ? blockMatch[1].trim() : null

  return {
    skill: currentSopStage,
    phase: currentSopStage,
    lastCompletedStep: agentOutput.slice(-200).replace(/\n/g, " ").trim(),
    nextExpectedAction: "continue current skill",
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
