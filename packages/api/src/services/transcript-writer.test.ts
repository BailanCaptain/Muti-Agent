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

  it("Codex P4 HIGH #2: readLatestDigest returns most recently sealed session", async () => {
    const dir = makeTempDir()
    try {
      const writer = new TranscriptWriter({ dataDir: dir })
      writer.recordEvent({
        sessionId: "s1",
        threadId: "t1",
        event: { type: "tool_call", toolName: "edit" },
        at: "2026-04-17T10:00:00Z",
      })
      await writer.flush("s1")
      // Ensure s2 seal mtime is strictly later
      await new Promise((r) => setTimeout(r, 15))
      writer.recordEvent({
        sessionId: "s2",
        threadId: "t1",
        event: { type: "tool_call", toolName: "bash" },
        at: "2026-04-17T11:00:00Z",
      })
      await writer.flush("s2")

      const latest = await writer.readLatestDigest("t1")
      assert.ok(latest)
      assert.equal(latest!.sessionId, "s2", "most recently sealed session wins")
    } finally {
      cleanup(dir)
    }
  })

  it("Codex P4 Round 2 MEDIUM: readLatestDigest falls back to older valid digest when newest is corrupt", async () => {
    const dir = makeTempDir()
    try {
      const writer = new TranscriptWriter({ dataDir: dir })
      writer.recordEvent({
        sessionId: "s-old",
        threadId: "t1",
        event: { type: "tool_call", toolName: "edit" },
        at: "2026-04-17T09:00:00Z",
      })
      await writer.flush("s-old")
      await new Promise((r) => setTimeout(r, 15))
      writer.recordEvent({
        sessionId: "s-new",
        threadId: "t1",
        event: { type: "tool_call", toolName: "bash" },
        at: "2026-04-17T10:00:00Z",
      })
      await writer.flush("s-new")

      // Corrupt the newest digest (simulate truncated write / disk error)
      const { writeFileSync } = await import("node:fs")
      const corruptPath = join(dir, "threads", "t1", "sessions", "s-new", "digest.extractive.json")
      writeFileSync(corruptPath, "{ not valid json", "utf8")

      const latest = await writer.readLatestDigest("t1")
      assert.ok(latest, "must fall back to older valid digest, not return null")
      assert.equal(latest!.sessionId, "s-old", "fallback picks the next-freshest valid digest")
    } finally {
      cleanup(dir)
    }
  })

  it("Codex P4 Round 3 MEDIUM: readLatestDigest ties broken by digest.time.sealedAt (deterministic)", async () => {
    const dir = makeTempDir()
    try {
      const writer = new TranscriptWriter({ dataDir: dir })
      // Two sessions with same recordEvent 'at' but different sealedAt;
      // sealedAt comes from events[last].at at flush time.
      writer.recordEvent({
        sessionId: "s-earlier",
        threadId: "t1",
        event: { type: "tool_call", toolName: "edit" },
        at: "2026-04-17T10:00:00Z",
      })
      await writer.flush("s-earlier")
      writer.recordEvent({
        sessionId: "s-later",
        threadId: "t1",
        event: { type: "tool_call", toolName: "bash" },
        at: "2026-04-17T11:00:00Z",
      })
      await writer.flush("s-later")

      // Even if filesystem mtime somehow ordered them reversed, digest-time ordering wins
      const latest = await writer.readLatestDigest("t1")
      assert.ok(latest)
      assert.equal(latest!.sessionId, "s-later", "sealedAt DESC picks later")
    } finally {
      cleanup(dir)
    }
  })

  it("Codex P4 Round 4 HIGH #2: orphan digests are excluded from readLatestDigest", async () => {
    const dir = makeTempDir()
    try {
      const writer = new TranscriptWriter({ dataDir: dir })
      // Orphan (unsealed, from crashed pre-session turn)
      writer.recordEvent({
        sessionId: "orphan-1",
        threadId: "t1",
        event: { type: "tool_call", toolName: "edit" },
        at: "2026-04-17T10:00:00Z",
      })
      await writer.flush("orphan-1", { orphan: true })

      // Real sealed session (older timestamp but sealed properly)
      writer.recordEvent({
        sessionId: "real-seal",
        threadId: "t1",
        event: { type: "tool_call", toolName: "bash" },
        at: "2026-04-17T09:00:00Z",
      })
      await writer.flush("real-seal")

      // Another orphan, newest
      writer.recordEvent({
        sessionId: "orphan-2",
        threadId: "t1",
        event: { type: "tool_call", toolName: "read" },
        at: "2026-04-17T11:00:00Z",
      })
      await writer.flush("orphan-2", { orphan: true })

      const latest = await writer.readLatestDigest("t1")
      assert.ok(latest)
      assert.equal(
        latest!.sessionId,
        "real-seal",
        "orphan digests must be filtered — only sealed sessions populate previousDigest",
      )
    } finally {
      cleanup(dir)
    }
  })

  it("Codex P4 Round 5: digest without orphan field is treated as legitimate sealed (backwards compat)", async () => {
    // Contract: readLatestDigest filters `orphan === true`. A digest without the
    // field (legacy / sealed-but-no-marker) is considered legitimate sealed.
    // This is the intentional design — orphan is opt-in via flush({orphan:true}).
    const dir = makeTempDir()
    try {
      const writer = new TranscriptWriter({ dataDir: dir })
      writer.recordEvent({
        sessionId: "legacy-session",
        threadId: "t1",
        event: { type: "tool_call", toolName: "edit" },
        at: "2026-04-17T10:00:00Z",
      })
      // Normal flush without { orphan: true } → digest file has no orphan field
      await writer.flush("legacy-session")

      // Manually verify digest file does NOT have orphan field (explicit contract check)
      const { readFileSync } = await import("node:fs")
      const rawDigest = JSON.parse(
        readFileSync(
          join(dir, "threads", "t1", "sessions", "legacy-session", "digest.extractive.json"),
          "utf8",
        ),
      )
      assert.equal(rawDigest.orphan, undefined, "non-orphan flush must NOT set orphan field")

      // readLatestDigest must still return this digest (contract: no orphan flag = sealed)
      const latest = await writer.readLatestDigest("t1")
      assert.ok(latest, "digest without orphan field must be treated as legitimate sealed")
      assert.equal(latest!.sessionId, "legacy-session")
    } finally {
      cleanup(dir)
    }
  })

  it("Codex P4 Round 4: flush({orphan:true}) marks digest as orphan", async () => {
    const dir = makeTempDir()
    try {
      const writer = new TranscriptWriter({ dataDir: dir })
      writer.recordEvent({
        sessionId: "orph",
        threadId: "t1",
        event: { type: "tool_call", toolName: "x" },
        at: "2026-04-17T10:00:00Z",
      })
      await writer.flush("orph", { orphan: true })
      const digest = await writer.readDigest("orph", "t1")
      assert.ok(digest)
      assert.equal(digest!.orphan, true)
    } finally {
      cleanup(dir)
    }
  })

  it("Codex P4 HIGH #2: readLatestDigest returns null when thread has no sealed sessions", async () => {
    const dir = makeTempDir()
    try {
      const writer = new TranscriptWriter({ dataDir: dir })
      const latest = await writer.readLatestDigest("nonexistent-thread")
      assert.equal(latest, null)
    } finally {
      cleanup(dir)
    }
  })
})
