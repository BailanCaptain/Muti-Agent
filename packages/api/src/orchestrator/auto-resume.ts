import type { SOPBookmark } from "./sop-bookmark"

export const MAX_AUTO_RESUMES = 2

export function shouldAutoResume(
  bookmark: SOPBookmark | null,
  autoResumeCount: number,
  maxResumes: number,
  newSessionFillRatio: number,
  lastStopReason?: string | null,
): boolean {
  if (!bookmark?.skill) return false
  if (bookmark.phase === "completed") return false
  if (!bookmark.nextExpectedAction) return false
  if (autoResumeCount >= maxResumes) return false
  if (newSessionFillRatio > 0.5) return false
  // B015: "complete" 表示 agent 完整说完了（原生 Claude end_turn / stop_sequence 在
  // runtime 层已映射到 "complete"）。正常结束不是被截断 — 续接会导致重答。
  if (lastStopReason === "complete") return false
  return true
}

export function buildAutoResumeMessage(bookmark: SOPBookmark, resumeNum: number, maxResumes: number): string {
  const lines = [
    `[系统] 上下文已封存并重组（自动续接 ${resumeNum}/${maxResumes}）。请基于以下 SOP 书签继续未完成的任务：`,
    `skill=${bookmark.skill} | phase=${bookmark.phase ?? "unknown"} | last=${bookmark.lastCompletedStep || "none"} | next=${bookmark.nextExpectedAction}`,
  ]
  if (bookmark.blockingQuestion) {
    lines.push(`blocking=${bookmark.blockingQuestion}`)
  }
  lines.push("请从上次中断处继续，不要重复已完成的步骤。")
  lines.push(
    "严禁：复述已有结论、重新回答用户历史问题、以「让我继续 / 我来回答」等开场。直接执行 next 指向的动作。",
  )
  return lines.join("\n")
}
