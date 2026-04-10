import crypto from "node:crypto"
import type { Provider } from "@multi-agent/shared"

export type DecisionOption = { id: string; label: string }

export type DecisionRaiser = {
  threadId: string
  provider: Provider
  alias: string
  raisedAt: string
}

export type DecisionBoardEntry = {
  id: string
  questionHash: string
  question: string
  options: DecisionOption[]
  raisers: DecisionRaiser[]
  sessionGroupId: string
  firstRaisedAt: string
}

export type AddEntryInput = {
  sessionGroupId: string
  raiser: DecisionRaiser
  question: string
  options: DecisionOption[]
}

export type AddEntryResult =
  | { kind: "added"; entry: DecisionBoardEntry }
  | { kind: "merged"; entry: DecisionBoardEntry }

const FILLER_PATTERN = /(是否|还是|要不要|需不需要|吗|呢|嘛|呀|的话|么|一下)/g

export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(FILLER_PATTERN, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
}

export function hashQuestion(normalized: string): string {
  return crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 12)
}

export class DecisionBoard {
  private readonly bySession = new Map<string, Map<string, DecisionBoardEntry>>()

  add(input: AddEntryInput): AddEntryResult {
    const normalized = normalizeQuestion(input.question)
    const questionHash = hashQuestion(normalized)

    let sessionMap = this.bySession.get(input.sessionGroupId)
    if (!sessionMap) {
      sessionMap = new Map()
      this.bySession.set(input.sessionGroupId, sessionMap)
    }

    const existing = sessionMap.get(questionHash)
    if (existing) {
      const alreadyRaised = existing.raisers.some(
        (r) => r.threadId === input.raiser.threadId,
      )
      if (!alreadyRaised) {
        existing.raisers.push(input.raiser)
      }
      return { kind: "merged", entry: existing }
    }

    const entry: DecisionBoardEntry = {
      id: crypto.randomUUID(),
      questionHash,
      question: input.question,
      options: input.options,
      raisers: [input.raiser],
      sessionGroupId: input.sessionGroupId,
      firstRaisedAt: input.raiser.raisedAt,
    }
    sessionMap.set(questionHash, entry)
    return { kind: "added", entry }
  }

  withdraw(
    sessionGroupId: string,
    raiserThreadId: string,
    substring: string,
  ): DecisionBoardEntry | null {
    const sessionMap = this.bySession.get(sessionGroupId)
    if (!sessionMap) return null

    const needle = substring.trim()
    if (!needle) return null

    const candidates = Array.from(sessionMap.values())
      .filter((e) => e.raisers.some((r) => r.threadId === raiserThreadId))
      .filter((e) => e.question.includes(needle))
      .sort((a, b) => b.firstRaisedAt.localeCompare(a.firstRaisedAt))

    const target = candidates[0]
    if (!target) return null

    target.raisers = target.raisers.filter((r) => r.threadId !== raiserThreadId)

    if (target.raisers.length === 0) {
      sessionMap.delete(target.questionHash)
    }

    return target
  }

  getPending(sessionGroupId: string): DecisionBoardEntry[] {
    const sessionMap = this.bySession.get(sessionGroupId)
    if (!sessionMap) return []
    return Array.from(sessionMap.values()).sort((a, b) =>
      a.firstRaisedAt.localeCompare(b.firstRaisedAt),
    )
  }

  drain(sessionGroupId: string): DecisionBoardEntry[] {
    const entries = this.getPending(sessionGroupId)
    this.bySession.delete(sessionGroupId)
    return entries
  }

  hasPending(sessionGroupId: string): boolean {
    return (this.bySession.get(sessionGroupId)?.size ?? 0) > 0
  }

  size(sessionGroupId: string): number {
    return this.bySession.get(sessionGroupId)?.size ?? 0
  }
}
