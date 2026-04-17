// F018 AC1: TranscriptWriter 冷存储
// 参照 clowder-ai reference-code/clowder-ai/.../TranscriptWriter.ts
//
// Seal 时异步 flush：
//   - events.jsonl    — NDJSON 包封的事件流
//   - index.json      — 稀疏 byte-offset 索引（每 100 条一个 offset），支持分页 seek
//   - digest.extractive.json — 规则化摘要（toolNames / filesTouched / errors）
//
// Digest schema 刻意不含用户/assistant 对话原文 — 对齐 clowder-ai 设计哲学：
// 下一 session 看到的是"做了什么"的事实，不是对话复读。
//
// 铁律合规：
//   - 数据神圣：只写新文件，不动 SQLite messages 表
//   - 进程自保：失败由调用方 .catch(() => {}) 吞掉；本类不抛出外部

import { promises as fs } from "node:fs"
import { join } from "node:path"

export type EventRecord = {
  sessionId: string
  threadId: string
  event: Record<string, unknown>
  at: string
  invocationId?: string
}

export type ExtractiveDigestV1 = {
  v: 1
  sessionId: string
  threadId: string
  time: { createdAt: string; sealedAt: string }
  invocations: Array<{ invocationId?: string; toolNames?: string[] }>
  filesTouched: Array<{ path: string; ops: string[] }>
  errors: Array<{ at: string; invocationId?: string; message: string }>
}

export class TranscriptWriter {
  private buffer = new Map<string, EventRecord[]>()

  constructor(private config: { dataDir: string }) {}

  recordEvent(record: EventRecord): void {
    const key = record.sessionId
    if (!this.buffer.has(key)) this.buffer.set(key, [])
    this.buffer.get(key)?.push(record)
  }

  async flush(sessionId: string): Promise<void> {
    const events = this.buffer.get(sessionId)
    if (!events || events.length === 0) return

    const threadId = events[0].threadId
    const baseDir = join(this.config.dataDir, "threads", threadId, "sessions", sessionId)
    await fs.mkdir(baseDir, { recursive: true })

    const jsonlLines: string[] = []
    const offsets: number[] = []
    let pos = 0
    for (let i = 0; i < events.length; i++) {
      const line = JSON.stringify({ v: 1, t: events[i].at, eventNo: i, ...events[i] })
      if (i % 100 === 0) offsets.push(pos)
      jsonlLines.push(line)
      pos += Buffer.byteLength(line) + 1 // +1 for newline separator
    }

    await fs.writeFile(join(baseDir, "events.jsonl"), jsonlLines.join("\n"), "utf8")
    await fs.writeFile(join(baseDir, "index.json"), JSON.stringify({ offsets }), "utf8")

    const digest: ExtractiveDigestV1 = {
      v: 1,
      sessionId,
      threadId,
      time: { createdAt: events[0].at, sealedAt: events[events.length - 1].at },
      invocations: this.extractInvocations(events),
      filesTouched: this.extractFilesTouched(events),
      errors: this.extractErrors(events),
    }
    await fs.writeFile(
      join(baseDir, "digest.extractive.json"),
      JSON.stringify(digest, null, 2),
      "utf8",
    )

    this.buffer.delete(sessionId)
  }

  async readDigest(sessionId: string, threadId: string): Promise<ExtractiveDigestV1 | null> {
    const path = join(
      this.config.dataDir,
      "threads",
      threadId,
      "sessions",
      sessionId,
      "digest.extractive.json",
    )
    try {
      const content = await fs.readFile(path, "utf8")
      return JSON.parse(content) as ExtractiveDigestV1
    } catch {
      return null
    }
  }

  private extractInvocations(events: EventRecord[]): ExtractiveDigestV1["invocations"] {
    const byInv = new Map<string | undefined, Set<string>>()
    for (const e of events) {
      const toolName = e.event.toolName
      if (typeof toolName !== "string") continue
      const key = e.invocationId
      if (!byInv.has(key)) byInv.set(key, new Set())
      byInv.get(key)?.add(toolName)
    }
    return [...byInv.entries()].map(([invocationId, names]) => ({
      invocationId,
      toolNames: [...names],
    }))
  }

  private extractFilesTouched(events: EventRecord[]): ExtractiveDigestV1["filesTouched"] {
    const byPath = new Map<string, Set<string>>()
    for (const e of events) {
      const path = e.event.path
      const toolName = e.event.toolName
      if (typeof path !== "string" || typeof toolName !== "string") continue
      if (!byPath.has(path)) byPath.set(path, new Set())
      byPath.get(path)?.add(toolName)
    }
    return [...byPath.entries()].map(([path, ops]) => ({ path, ops: [...ops] }))
  }

  private extractErrors(events: EventRecord[]): ExtractiveDigestV1["errors"] {
    return events
      .filter((e) => e.event.type === "error" && typeof e.event.message === "string")
      .map((e) => ({
        at: e.at,
        invocationId: e.invocationId,
        message: e.event.message as string,
      }))
  }
}
