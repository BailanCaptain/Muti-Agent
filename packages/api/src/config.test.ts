import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import { buildApiConfig, parseCorsOrigin } from "./config"

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

// B018: CORS_ORIGIN 支持 localhost-any / 逗号分隔 / 单 string / 默认值

test("B018 parseCorsOrigin: 'localhost-any' returns RegExp matching any localhost port", () => {
  const result = parseCorsOrigin("localhost-any")
  assert.ok(result instanceof RegExp, "should return a RegExp")
  assert.equal(result.test("http://localhost:3000"), true)
  assert.equal(result.test("http://localhost:3200"), true)
  assert.equal(result.test("http://localhost:65535"), true)
  assert.equal(result.test("https://evil.example"), false)
  assert.equal(result.test("http://localhost.evil.com"), false)
  assert.equal(result.test("http://127.0.0.1:3000"), false)
})

test("B018 parseCorsOrigin: comma-separated values return string array", () => {
  const result = parseCorsOrigin("http://a.com,http://b.com")
  assert.deepEqual(result, ["http://a.com", "http://b.com"])
})

test("B018 parseCorsOrigin: comma-separated values with whitespace are trimmed", () => {
  const result = parseCorsOrigin("  http://a.com , http://b.com  ")
  assert.deepEqual(result, ["http://a.com", "http://b.com"])
})

test("B018 parseCorsOrigin: single string (no comma) returns as-is", () => {
  const result = parseCorsOrigin("http://a.com")
  assert.equal(result, "http://a.com")
})

test("B018 parseCorsOrigin: undefined defaults to localhost-any RegExp", () => {
  const result = parseCorsOrigin(undefined)
  assert.ok(result instanceof RegExp)
  assert.equal(result.test("http://localhost:3200"), true)
})

test("B018 parseCorsOrigin: empty string defaults to localhost-any RegExp", () => {
  const result = parseCorsOrigin("")
  assert.ok(result instanceof RegExp)
  assert.equal(result.test("http://localhost:3200"), true)
})

test("B018 config: corsOrigin defaults to localhost-any RegExp", () => {
  const cfg = buildApiConfig({} as NodeJS.ProcessEnv)
  assert.ok(cfg.corsOrigin instanceof RegExp, "corsOrigin should default to RegExp")
  assert.equal((cfg.corsOrigin as RegExp).test("http://localhost:3200"), true)
})

test("B018 config: CORS_ORIGIN env override honored", () => {
  const cfg = buildApiConfig({ CORS_ORIGIN: "https://multi-agent.prod" } as NodeJS.ProcessEnv)
  assert.equal(cfg.corsOrigin, "https://multi-agent.prod")
})
