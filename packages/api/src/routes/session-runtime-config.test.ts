import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { SessionRepository } from "../db/repositories/session-repository"
import { SqliteStore } from "../db/sqlite"
import { registerSessionRuntimeConfigRoutes } from "./session-runtime-config"

function withTempRepo<T>(fn: (repo: SessionRepository) => Promise<T> | T): Promise<T> {
  const runtimeDir = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(runtimeDir, { recursive: true })
  const tempDir = fs.mkdtempSync(path.join(runtimeDir, "session-runtime-config-route-"))
  const sqlitePath = path.join(tempDir, "multi-agent.sqlite")
  const store = new SqliteStore(sqlitePath)
  const repo = new SessionRepository(store)
  return Promise.resolve(fn(repo)).finally(() => {
    store.db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })
}

test("F021 GET /api/sessions/:id/runtime-config returns empty config+pending for new session", async () => {
  await withTempRepo(async (repo) => {
    const groupId = repo.createSessionGroup("Test Room")
    const app = Fastify()
    registerSessionRuntimeConfigRoutes(app, { sessions: repo })
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${groupId}/runtime-config`,
    })
    await app.close()
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { config: {}, pending: {} })
  })
})

test("F021 GET /api/sessions/:id/runtime-config returns 404 for unknown session", async () => {
  await withTempRepo(async (repo) => {
    const app = Fastify()
    registerSessionRuntimeConfigRoutes(app, { sessions: repo })
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions/does-not-exist/runtime-config",
    })
    await app.close()
    assert.equal(res.statusCode, 404)
  })
})

test("F021 PUT /api/sessions/:id/runtime-config persists and round-trips via GET", async () => {
  await withTempRepo(async (repo) => {
    const groupId = repo.createSessionGroup("Test Room")
    const app = Fastify()
    registerSessionRuntimeConfigRoutes(app, { sessions: repo })
    const putRes = await app.inject({
      method: "PUT",
      url: `/api/sessions/${groupId}/runtime-config`,
      payload: {
        config: {
          claude: { model: "claude-opus-4-7", effort: "high" },
          codex: { model: "gpt-5" },
        },
      },
    })
    assert.equal(putRes.statusCode, 200)
    const putBody = putRes.json() as { ok: boolean; config: unknown }
    assert.equal(putBody.ok, true)

    const getRes = await app.inject({
      method: "GET",
      url: `/api/sessions/${groupId}/runtime-config`,
    })
    await app.close()
    assert.deepEqual(getRes.json(), {
      config: {
        claude: { model: "claude-opus-4-7", effort: "high" },
        codex: { model: "gpt-5" },
      },
      pending: {},
    })
  })
})

test("F021 PUT /api/sessions/:id/runtime-config rejects body without config or pending", async () => {
  await withTempRepo(async (repo) => {
    const groupId = repo.createSessionGroup("Test Room")
    const app = Fastify()
    registerSessionRuntimeConfigRoutes(app, { sessions: repo })
    const res = await app.inject({
      method: "PUT",
      url: `/api/sessions/${groupId}/runtime-config`,
      payload: { wrong: "shape" },
    })
    await app.close()
    assert.equal(res.statusCode, 400)
  })
})

test("F021 PUT /api/sessions/:id/runtime-config accepts { pending } only and preserves active config", async () => {
  await withTempRepo(async (repo) => {
    const groupId = repo.createSessionGroup("Test Room")
    repo.setSessionRuntimeConfig(groupId, { claude: { model: "c-keep" } })
    const app = Fastify()
    registerSessionRuntimeConfigRoutes(app, { sessions: repo })
    const putRes = await app.inject({
      method: "PUT",
      url: `/api/sessions/${groupId}/runtime-config`,
      payload: { pending: { codex: { model: "gpt-5" } } },
    })
    await app.close()
    assert.equal(putRes.statusCode, 200)
    assert.deepEqual(putRes.json(), {
      ok: true,
      config: { claude: { model: "c-keep" } },
      pending: { codex: { model: "gpt-5" } },
    })
  })
})

test("F021 SessionRepository.flushSessionPending merges pending into active and clears pending", async () => {
  await withTempRepo((repo) => {
    const groupId = repo.createSessionGroup("Test")
    repo.setSessionRuntimeConfig(groupId, { claude: { model: "old" } })
    repo.setSessionPendingConfig(groupId, {
      claude: { model: "new" },
      codex: { model: "gpt-5" },
    })
    const merged = repo.flushSessionPending(groupId)
    assert.deepEqual(merged, {
      claude: { model: "new" },
      codex: { model: "gpt-5" },
    })
    assert.deepEqual(repo.getSessionRuntimeConfig(groupId), {
      claude: { model: "new" },
      codex: { model: "gpt-5" },
    })
    assert.deepEqual(repo.getSessionPendingConfig(groupId), {})
  })
})

// F021 P1 (范德彪 二轮 review): flush 在 provider 内必须字段级 merge
// 场景：active={model,effort}，pending 只改 effort；flush 后 model 必须保留
test("F021 P1 SessionRepository.flushSessionPending merges per-field within a provider (partial pending preserves active fields)", async () => {
  await withTempRepo((repo) => {
    const groupId = repo.createSessionGroup("Test")
    repo.setSessionRuntimeConfig(groupId, {
      claude: { model: "claude-opus-4-7", effort: "high" },
    })
    repo.setSessionPendingConfig(groupId, {
      claude: { effort: "low" },
    })
    const merged = repo.flushSessionPending(groupId)
    assert.deepEqual(merged, {
      claude: { model: "claude-opus-4-7", effort: "low" },
    })
    assert.deepEqual(repo.getSessionRuntimeConfig(groupId), {
      claude: { model: "claude-opus-4-7", effort: "low" },
    })
    assert.deepEqual(repo.getSessionPendingConfig(groupId), {})
  })
})

test("F021 SessionRepository legacy flat runtime_config is read as active (backward compat)", async () => {
  await withTempRepo((repo) => {
    const groupId = repo.createSessionGroup("Test")
    // Simulate legacy pre-F021-Phase-3.3 flat shape
    const legacy = JSON.stringify({ claude: { model: "legacy" } })
    ;(
      repo as unknown as { store: { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } } }
    ).store.db
      .prepare("UPDATE session_groups SET runtime_config = ? WHERE id = ?")
      .run(legacy, groupId)
    assert.deepEqual(repo.getSessionRuntimeConfig(groupId), {
      claude: { model: "legacy" },
    })
    assert.deepEqual(repo.getSessionPendingConfig(groupId), {})
  })
})

test("F021 PUT /api/sessions/:id/runtime-config rejects non-object config", async () => {
  await withTempRepo(async (repo) => {
    const groupId = repo.createSessionGroup("Test Room")
    const app = Fastify()
    registerSessionRuntimeConfigRoutes(app, { sessions: repo })
    const res = await app.inject({
      method: "PUT",
      url: `/api/sessions/${groupId}/runtime-config`,
      payload: { config: ["not", "an", "object"] },
    })
    await app.close()
    assert.equal(res.statusCode, 400)
  })
})

test("F021 PUT /api/sessions/:id/runtime-config returns 404 for unknown session", async () => {
  await withTempRepo(async (repo) => {
    const app = Fastify()
    registerSessionRuntimeConfigRoutes(app, { sessions: repo })
    const res = await app.inject({
      method: "PUT",
      url: "/api/sessions/nope/runtime-config",
      payload: { config: { claude: { model: "x" } } },
    })
    await app.close()
    assert.equal(res.statusCode, 404)
  })
})

test("F021 SessionRepository.getSessionRuntimeConfig defaults to {} when column is null", async () => {
  await withTempRepo((repo) => {
    const groupId = repo.createSessionGroup("Test")
    assert.deepEqual(repo.getSessionRuntimeConfig(groupId), {})
  })
})

test("F021 SessionRepository.setSessionRuntimeConfig round-trips JSON", async () => {
  await withTempRepo((repo) => {
    const groupId = repo.createSessionGroup("Test")
    repo.setSessionRuntimeConfig(groupId, { codex: { model: "gpt-5" } })
    assert.deepEqual(repo.getSessionRuntimeConfig(groupId), {
      codex: { model: "gpt-5" },
    })
  })
})

// F021 Phase 6 — AC-29 边界校验：会话覆盖 PUT 也走同一道校验
test("AC-29 PUT /api/sessions/:id/runtime-config rejects invalid sealPct in config with 400", async () => {
  await withTempRepo(async (repo) => {
    const groupId = repo.createSessionGroup("Test Room")
    const app = Fastify()
    registerSessionRuntimeConfigRoutes(app, { sessions: repo })
    const res = await app.inject({
      method: "PUT",
      url: `/api/sessions/${groupId}/runtime-config`,
      payload: { config: { claude: { sealPct: 1.5 } } },
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

test("AC-29 PUT /api/sessions/:id/runtime-config rejects invalid contextWindow in pending with 400", async () => {
  await withTempRepo(async (repo) => {
    const groupId = repo.createSessionGroup("Test Room")
    const app = Fastify()
    registerSessionRuntimeConfigRoutes(app, { sessions: repo })
    const res = await app.inject({
      method: "PUT",
      url: `/api/sessions/${groupId}/runtime-config`,
      payload: { pending: { codex: { contextWindow: 0 } } },
    })
    await app.close()
    assert.equal(res.statusCode, 400)
    const body = res.json() as { errors?: string[] }
    assert.ok(
      body.errors?.some((e) => e.includes("contextWindow")),
      `errors should mention contextWindow: ${JSON.stringify(body.errors)}`,
    )
  })
})

test("AC-29 PUT /api/sessions/:id/runtime-config accepts valid contextWindow + sealPct", async () => {
  await withTempRepo(async (repo) => {
    const groupId = repo.createSessionGroup("Test Room")
    const app = Fastify()
    registerSessionRuntimeConfigRoutes(app, { sessions: repo })
    const res = await app.inject({
      method: "PUT",
      url: `/api/sessions/${groupId}/runtime-config`,
      payload: {
        config: { claude: { contextWindow: 1_500_000, sealPct: 0.6 } },
      },
    })
    await app.close()
    assert.equal(res.statusCode, 200)
  })
})
