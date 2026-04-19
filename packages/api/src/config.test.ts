import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import { buildApiConfig } from "./config"

test("F024 config: uploadsDir honors UPLOADS_DIR env", () => {
  const cfg = buildApiConfig({ UPLOADS_DIR: "C:/tmp/f024/uploads" } as NodeJS.ProcessEnv)
  assert.equal(cfg.uploadsDir, "C:/tmp/f024/uploads")
})

test("F024 config: uploadsDir defaults to .runtime/uploads under cwd", () => {
  const cfg = buildApiConfig({} as NodeJS.ProcessEnv)
  assert.equal(cfg.uploadsDir, path.join(process.cwd(), ".runtime", "uploads"))
})

test("F024 config: runtimeEventsDir honors RUNTIME_EVENTS_DIR env", () => {
  const cfg = buildApiConfig({ RUNTIME_EVENTS_DIR: "C:/tmp/f024/events" } as NodeJS.ProcessEnv)
  assert.equal(cfg.runtimeEventsDir, "C:/tmp/f024/events")
})

test("F024 config: runtimeEventsDir defaults to .runtime/runtime-events under cwd", () => {
  const cfg = buildApiConfig({} as NodeJS.ProcessEnv)
  assert.equal(cfg.runtimeEventsDir, path.join(process.cwd(), ".runtime", "runtime-events"))
})
