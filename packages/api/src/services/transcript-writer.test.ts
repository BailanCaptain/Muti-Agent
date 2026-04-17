import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { TranscriptWriter } from "./transcript-writer"
import type { ExtractiveDigestV1 } from "./transcript-writer"

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "tw-test-"))
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows file locks — best effort
  }
}

describe("TranscriptWriter", () => {
  it("AC1.1 + AC1.2: flush writes digest.extractive.json with toolNames/filesTouched/errors", async () => {
    const dir = makeTempDir()
    try {
      const writer = new TranscriptWriter({ dataDir: dir })
      for (let i = 0; i < 5; i++) {
        writer.recordEvent({
          sessionId: "s1",
          threadId: "t1",
          event: { type: "tool_call", toolName: "edit", path: `src/f${i}.ts` },
          at: `2026-04-17T10:${String(i).padStart(2, "0")}:00Z`,
          invocationId: "inv1",
        })
      }
      writer.recordEvent({
        sessionId: "s1",
        threadId: "t1",
        event: { type: "error", message: "ENOENT: missing file" },
        at: "2026-04-17T10:10:00Z",
        invocationId: "inv1",
      })
      await writer.flush("s1")

      const path = join(dir, "threads", "t1", "sessions", "s1", "digest.extractive.json")
      assert.ok(existsSync(path), "digest.extractive.json should exist")

      const digest: ExtractiveDigestV1 = JSON.parse(readFileSync(path, "utf8"))
      assert.equal(digest.v, 1)
      assert.equal(digest.sessionId, "s1")
      assert.equal(digest.threadId, "t1")
      assert.equal(digest.invocations.length, 1)
      assert.ok(digest.invocations[0].toolNames?.includes("edit"))
      assert.equal(digest.filesTouched.length, 5)
      assert.equal(digest.errors.length, 1)
      assert.match(digest.errors[0].message, /ENOENT/)
    } finally {
      cleanup(dir)
    }
  })

  it("AC1.2: digest contains NO raw user conversation content", async () => {
    const dir = makeTempDir()
    try {
      const writer = new TranscriptWriter({ dataDir: dir })
      writer.recordEvent({
        sessionId: "s1",
        threadId: "t1",
        event: { type: "user_message", content: "请帮我备份数据库" },
        at: "2026-04-17T10:00:00Z",
      })
      writer.recordEvent({
        sessionId: "s1",
        threadId: "t1",
        event: { type: "assistant_message", content: "好的，备份步骤..." },
        at: "2026-04-17T10:01:00Z",
      })
      await writer.flush("s1")

      const path = join(dir, "threads", "t1", "sessions", "s1", "digest.extractive.json")
      const digest: ExtractiveDigestV1 = JSON.parse(readFileSync(path, "utf8"))
      const serialized = JSON.stringify(digest)
      assert.ok(!serialized.includes("请帮我备份数据库"), "digest must NOT contain raw user text")
      assert.ok(!serialized.includes("好的，备份步骤"), "digest must NOT contain raw assistant text")
    } finally {
      cleanup(dir)
    }
  })

  it("AC1.3: flush is idempotent and clears buffer after success", async () => {
    const dir = makeTempDir()
    try {
      const writer = new TranscriptWriter({ dataDir: dir })
      writer.recordEvent({
        sessionId: "s1",
        threadId: "t1",
        event: { type: "tool_call", toolName: "read" },
        at: "2026-04-17T10:00:00Z",
      })
      await writer.flush("s1")

      // Second flush on same sessionId should be a no-op (buffer cleared)
      await writer.flush("s1")
      const path = join(dir, "threads", "t1", "sessions", "s1", "digest.extractive.json")
      assert.ok(existsSync(path))
    } finally {
      cleanup(dir)
    }
  })

  it("AC1.4: sparse byte-offset index has one offset per 100 events", async () => {
    const dir = makeTempDir()
    try {
      const writer = new TranscriptWriter({ dataDir: dir })
      for (let i = 0; i < 250; i++) {
        writer.recordEvent({
          sessionId: "s1",
          threadId: "t1",
          event: { type: "tool_call", toolName: "x" },
          at: `2026-04-17T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
        })
      }
      await writer.flush("s1")

      const indexPath = join(dir, "threads", "t1", "sessions", "s1", "index.json")
      const index: { offsets: number[] } = JSON.parse(readFileSync(indexPath, "utf8"))
      assert.equal(index.offsets.length, 3, "250 events / 100 = 3 offsets (0, 100, 200)")
      assert.equal(index.offsets[0], 0)
      assert.ok(index.offsets[1] > 0)
      assert.ok(index.offsets[2] > index.offsets[1])
    } finally {
      cleanup(dir)
    }
  })

  it("AC1.5: readDigest returns null when digest not exists", async () => {
    const dir = makeTempDir()
    try {
      const writer = new TranscriptWriter({ dataDir: dir })
      const result = await writer.readDigest("nonexistent", "t1")
      assert.equal(result, null)
    } finally {
      cleanup(dir)
    }
  })

  it("AC1.5: readDigest round-trips flushed digest", async () => {
    const dir = makeTempDir()
    try {
      const writer = new TranscriptWriter({ dataDir: dir })
      writer.recordEvent({
        sessionId: "s1",
        threadId: "t1",
        event: { type: "tool_call", toolName: "bash" },
        at: "2026-04-17T10:00:00Z",
      })
      await writer.flush("s1")
      const digest = await writer.readDigest("s1", "t1")
      assert.ok(digest)
      assert.equal(digest?.sessionId, "s1")
      assert.ok(digest?.invocations[0].toolNames?.includes("bash"))
    } finally {
      cleanup(dir)
    }
  })

  it("flush is no-op when buffer is empty for given session", async () => {
    const dir = makeTempDir()
    try {
      const writer = new TranscriptWriter({ dataDir: dir })
      await writer.flush("never-recorded")
      const path = join(dir, "threads")
      assert.ok(!existsSync(path), "no directory should be created for empty flush")
    } finally {
      cleanup(dir)
    }
  })
})
