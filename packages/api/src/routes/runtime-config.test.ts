import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { registerRuntimeConfigRoutes } from "./runtime-config"

function withTempConfig<T>(fn: (configPath: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ma-cfg-routes-"))
  const configPath = path.join(dir, "cfg.json")
  const prev = process.env.MULTI_AGENT_RUNTIME_CONFIG_PATH
  process.env.MULTI_AGENT_RUNTIME_CONFIG_PATH = configPath
  return Promise.resolve(fn(configPath)).finally(() => {
    // biome-ignore lint/performance/noDelete: process.env assignment coerces undefined to "undefined" string.
    if (prev === undefined) delete process.env.MULTI_AGENT_RUNTIME_CONFIG_PATH
    else process.env.MULTI_AGENT_RUNTIME_CONFIG_PATH = prev
    rmSync(dir, { recursive: true, force: true })
  })
}

test("GET /api/models returns catalog with all three agents", async () => {
  const app = Fastify()
  registerRuntimeConfigRoutes(app)
  const res = await app.inject({ method: "GET", url: "/api/models" })
  await app.close()
  assert.equal(res.statusCode, 200)
  const body = res.json() as { catalog: Record<string, unknown> }
  assert.ok(body.catalog.claude)
  assert.ok(body.catalog.codex)
  assert.ok(body.catalog.gemini)
})

test("GET /api/runtime-config returns empty when file missing", async () => {
  await withTempConfig(async () => {
    const app = Fastify()
    registerRuntimeConfigRoutes(app)
    const res = await app.inject({ method: "GET", url: "/api/runtime-config" })
    await app.close()
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { config: {} })
  })
})

test("PUT /api/runtime-config persists and round-trips via GET", async () => {
  await withTempConfig(async () => {
    const app = Fastify()
    registerRuntimeConfigRoutes(app)
    const putRes = await app.inject({
      method: "PUT",
      url: "/api/runtime-config",
      payload: {
        config: {
          claude: { model: "claude-opus-4-6", effort: "high" },
          codex: { model: "gpt-5.4", effort: "medium" },
        },
      },
    })
    assert.equal(putRes.statusCode, 200)
    const putBody = putRes.json() as { ok: boolean; config: unknown }
    assert.equal(putBody.ok, true)

    const getRes = await app.inject({ method: "GET", url: "/api/runtime-config" })
    await app.close()
    assert.deepEqual(getRes.json(), {
      config: {
        claude: { model: "claude-opus-4-6", effort: "high" },
        codex: { model: "gpt-5.4", effort: "medium" },
      },
    })
  })
})

test("PUT /api/runtime-config rejects body without config field", async () => {
  await withTempConfig(async () => {
    const app = Fastify()
    registerRuntimeConfigRoutes(app)
    const res = await app.inject({
      method: "PUT",
      url: "/api/runtime-config",
      payload: { wrong: "shape" },
    })
    await app.close()
    assert.equal(res.statusCode, 400)
  })
})
