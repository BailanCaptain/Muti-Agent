import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

test("F024 event recorder writes into configured RUNTIME_EVENTS_DIR", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "f024-events-"))
  const prevRecord = process.env.RECORD_EVENTS
  const prevDir = process.env.RUNTIME_EVENTS_DIR
  process.env.RECORD_EVENTS = "1"
  process.env.RUNTIME_EVENTS_DIR = tempDir

  try {
    const { createEventRecorder } = await import("./event-recorder")
    const recorder = createEventRecorder("codex")
    recorder.record({ ok: true })

    assert.ok(recorder.filePath, "filePath should be set when RECORD_EVENTS=1")
    assert.ok(
      recorder.filePath!.startsWith(tempDir),
      `filePath ${recorder.filePath} should start with tempDir ${tempDir}`,
    )
    assert.ok(fs.existsSync(recorder.filePath!), "recorder file should exist on disk")
  } finally {
    if (prevRecord === undefined) delete process.env.RECORD_EVENTS
    else process.env.RECORD_EVENTS = prevRecord
    if (prevDir === undefined) delete process.env.RUNTIME_EVENTS_DIR
    else process.env.RUNTIME_EVENTS_DIR = prevDir
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
