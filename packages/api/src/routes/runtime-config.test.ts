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

// F021 Phase 6 — AC-29 边界校验：非法 contextWindow / sealPct → 400 (不静默丢弃)
test("AC-29 PUT /api/runtime-config rejects contextWindow <= 0 with 400 + errors[]", async () => {
  await withTempConfig(async () => {
    const app = Fastify()
    registerRuntimeConfigRoutes(app)
    const res = await app.inject({
      method: "PUT",
      url: "/api/runtime-config",
      payload: { config: { claude: { contextWindow: -1 } } },
    })
    await app.close()
    assert.equal(res.statusCode, 400)
    const body = res.json() as { errors?: string[]; error?: string }
    assert.ok(Array.isArray(body.errors), "expected body.errors to be an array")
    assert.ok(
      body.errors!.some((e) => e.includes("contextWindow") && e.includes("claude")),
      `errors should mention claude/contextWindow: ${JSON.stringify(body.errors)}`,
    )
  })
})

test("AC-29 PUT /api/runtime-config rejects non-integer contextWindow with 400", async () => {
  await withTempConfig(async () => {
    const app = Fastify()
    registerRuntimeConfigRoutes(app)
    const res = await app.inject({
      method: "PUT",
      url: "/api/runtime-config",
      payload: { config: { claude: { contextWindow: "lots" } } },
    })
    await app.close()
    assert.equal(res.statusCode, 400)
  })
})

test("AC-29 PUT /api/runtime-config rejects sealPct out of [0.3, 1.0] with 400", async () => {
  await withTempConfig(async () => {
    const app = Fastify()
    registerRuntimeConfigRoutes(app)
    const res = await app.inject({
      method: "PUT",
      url: "/api/runtime-config",
      payload: { config: { claude: { sealPct: 0.05 } } },
    })
    await app.close()
    assert.equal(res.statusCode, 400)
    const body = res.json() as { errors?: string[] }
    assert.ok(
      body.errors?.some((e) => e.includes("sealPct")),
      `errors should mention sealPct: ${JSON.stringify(body.errors)}`,
    )
  })
})

test("AC-29 PUT /api/runtime-config accepts valid contextWindow + sealPct (round-trip)", async () => {
  await withTempConfig(async () => {
    const app = Fastify()
    registerRuntimeConfigRoutes(app)
    const putRes = await app.inject({
      method: "PUT",
      url: "/api/runtime-config",
      payload: { config: { claude: { contextWindow: 2_000_000, sealPct: 0.5 } } },
    })
    assert.equal(putRes.statusCode, 200)

    const getRes = await app.inject({ method: "GET", url: "/api/runtime-config" })
    await app.close()
    assert.deepEqual(getRes.json(), {
      config: { claude: { contextWindow: 2_000_000, sealPct: 0.5 } },
    })
  })
})

test("AC-29 PUT /api/runtime-config aggregates multiple errors across providers", async () => {
  await withTempConfig(async () => {
    const app = Fastify()
    registerRuntimeConfigRoutes(app)
    const res = await app.inject({
      method: "PUT",
      url: "/api/runtime-config",
      payload: {
        config: {
          claude: { contextWindow: 0 },
          codex: { sealPct: 1.5 },
        },
      },
    })
    await app.close()
    assert.equal(res.statusCode, 400)
    const body = res.json() as { errors?: string[] }
    assert.ok(body.errors && body.errors.length >= 2, `expected ≥2 errors, got ${JSON.stringify(body.errors)}`)
  })
})

// 注：model / effort 仍走 sanitize 静默 drop（plan Task 8 scope 仅含 contextWindow + sealPct）
