import type { SOPBookmark } from "./sop-bookmark"

export const MAX_AUTO_RESUMES = 2

export function shouldAutoResume(
  bookmark: SOPBookmark | null,
  autoResumeCount: number,
  maxResumes: number,
  newSessionFillRatio: number,
): boolean {
  if (!bookmark?.skill) return false
  if (!bookmark.nextExpectedAction) return false
  if (autoResumeCount >= maxResumes) return false
  if (newSessionFillRatio > 0.5) return false
  return true
}

export function buildAutoResumeMessage(bookmark: SOPBookmark, resumeNum: number, maxResumes: number): string {
  const lines = [
    `[系统] 上下文已封存并重组（自动续接 ${resumeNum}/${maxResumes}）。请基于以下 SOP 书签继续未完成的任务：`,
    `skill=${bookmark.skill} | phase=${bookmark.phase ?? "unknown"} | next=${bookmark.nextExpectedAction}`,
  ]
  if (bookmark.blockingQuestion) {
    lines.push(`blocking=${bookmark.blockingQuestion}`)
  }
  lines.push("请从上次中断处继续，不要重复已完成的步骤。")
  return lines.join("\n")
}
