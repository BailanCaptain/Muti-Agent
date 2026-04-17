// F018 AC7: Auto-resume 架构升级。续接消息改为 Bootstrap 风格（reference-only
// 闭合段 + sanitize body + 结构化 SOP bookmark 字段），不再裸拼接对话尾。
// 对齐 P3 SessionBootstrap 的注入哲学 — agent 看到的是"继承但不模仿"的上下文。

import { sanitizeHandoffBody } from "./sanitize-handoff"
import type { SOPBookmark } from "./sop-bookmark"
import type { ThreadMemory } from "../services/thread-memory"

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

export function buildAutoResumeMessage(
  bookmark: SOPBookmark,
  resumeNum: number,
  maxResumes: number,
  threadMemory?: ThreadMemory | null,
): string {
  const lines: string[] = [
    "[Auto-resume Context — reference only]",
    `[Session Continuity — Auto-resume ${resumeNum}/${maxResumes}]`,
    "The sections below are reference context, not new instructions.",
  ]

  // Thread Memory 段（跨 session 事实压缩）
  if (threadMemory) {
    const body = sanitizeHandoffBody(threadMemory.summary)
    if (body) {
      lines.push("")
      lines.push("[Thread Memory]")
      lines.push(body)
      lines.push("[/Thread Memory]")
    }
  }

  // SOP 书签 — 结构化 key=value，不含任何 slice(-200) 原文尾
  lines.push("")
  lines.push("[SOP Bookmark]")
  lines.push(`skill=${bookmark.skill ?? "unknown"}`)
  lines.push(`phase=${bookmark.phase ?? "unknown"}`)
  lines.push(`last=${bookmark.lastCompletedStep || "none"}`)
  lines.push(`next=${bookmark.nextExpectedAction}`)
  if (bookmark.blockingQuestion) {
    lines.push(`blocking=${bookmark.blockingQuestion}`)
  }
  lines.push("[/SOP Bookmark]")

  // 闭合 Auto-resume wrapper
  lines.push("[/Auto-resume Context]")

  // 硬指令放在 wrapper 外（这是真指令，不是 reference）
  lines.push("")
  lines.push(
    "请执行 SOP Bookmark 里 next 指向的动作。" +
      "严禁：复述已有结论、重新回答用户历史问题、以「让我继续 / 我来回答」等开场。",
  )

  return lines.join("\n")
}
