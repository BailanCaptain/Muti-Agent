import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { resolveUploadUrl } from "./resolve-upload-url"

// F023 post-AC10 bug: server-generated screenshot blocks stored `/uploads/foo.png`
// relative; frontend resolved it against web host (3101) and 404'd because
// fastifyStatic serves /uploads/ only on the API host (8801).
// The upload endpoint was never affected because the browser-side uploadFile()
// prefixes API_BASE at upload time — but assistant-produced blocks skip that step.
describe("resolveUploadUrl", () => {
  it("prefixes API base when url is a relative /uploads/ path", () => {
    assert.equal(
      resolveUploadUrl("/uploads/screenshot-1.png", "http://localhost:8801"),
      "http://localhost:8801/uploads/screenshot-1.png",
    )
  })

  it("strips trailing slash on API base before joining", () => {
    assert.equal(
      resolveUploadUrl("/uploads/a.png", "http://localhost:8801/"),
      "http://localhost:8801/uploads/a.png",
    )
  })

  it("returns url unchanged when already absolute http", () => {
    const abs = "http://localhost:8801/uploads/x.png"
    assert.equal(resolveUploadUrl(abs, "http://localhost:9999"), abs)
  })

  it("returns url unchanged when already absolute https", () => {
    const abs = "https://cdn.example.com/uploads/x.png"
    assert.equal(resolveUploadUrl(abs, "http://localhost:8801"), abs)
  })

  it("returns url unchanged when apiBase is undefined or empty", () => {
    assert.equal(resolveUploadUrl("/uploads/a.png", undefined), "/uploads/a.png")
    assert.equal(resolveUploadUrl("/uploads/a.png", ""), "/uploads/a.png")
  })

  it("returns url unchanged for non-uploads relative paths", () => {
    assert.equal(
      resolveUploadUrl("/api/something", "http://localhost:8801"),
      "/api/something",
    )
  })
})
