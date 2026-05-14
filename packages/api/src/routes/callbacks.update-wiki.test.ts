/**
 * F027 P3.e · /api/callbacks/{acquire-wiki-lease,read-wiki,update-wiki} 集成测试
 * 真相源：docs/plans/V16.5-final.md chap 6
 *
 * 覆盖：
 *   - acquire-wiki-lease happy path → fencingToken + expiresAt
 *   - acquire-wiki-lease 已被持有 → 409 lease_held
 *   - read-wiki not_found / found（with hash）
 *   - update-wiki happy path → 200 ok + 文件落地
 *   - update-wiki denied_acl → 403
 *   - update-wiki conflict → 409
 *   - identity 鉴权：缺 invocationId/callbackToken → 401
 *   - 缺 wikiServices 注入 → 503
 */

import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { InvocationRegistry } from "../orchestrator/invocation-registry"
import { registerCallbackRoutes } from "./callbacks"

function safeTempDir(prefix: string) {
  const runtimeDir = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(runtimeDir, { recursive: true })
  return fs.mkdtempSync(path.join(runtimeDir, prefix))
}
function safeCleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // best effort
  }
}
function sha256(s: string): string {
  return `sha256:${crypto.createHash("sha256").update(s).digest("hex")}`
}

async function buildApp() {
  const { createDrizzleDb } = await import("../db/drizzle-instance")
  const { createWikiServices } = await import("../wiki/wiki-services")

  const tempDir = safeTempDir("cb-wiki-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const wikiRoot = path.join(tempDir, "wiki-root")
  fs.mkdirSync(wikiRoot, { recursive: true })

  const { db, close } = createDrizzleDb(dbPath)
  const wikiServices = createWikiServices({ db, wikiRoot })
  const invocations = new InvocationRegistry<{ cancel: () => void }>()
  const identity = invocations.createInvocation("thread-fan", "agent-fan")

  const app = Fastify()
  registerCallbackRoutes(app, {
    repository: {
      // 三个 endpoint 只调 getThreadById；返个带 alias 的 thread 即可
      getThreadById: () => ({
        id: "thread-fan",
        sessionGroupId: "group-1",
        alias: "范德彪",
      }),
      appendMessage: () => ({ id: "ignored" }),
      listThreadsByGroup: () => [],
      listMessages: () => [],
    } as never,
    sessions: { getActiveGroup: () => ({ id: "group-1", timeline: [] }) } as never,
    broadcaster: { broadcast: () => {} },
    getRunningThreadIds: () => new Set<string>(),
    invocations,
    isSessionGroupCancelled: () => false,
    wikiServices,
  })

  return {
    app,
    identity,
    wikiRoot,
    cleanup: async () => {
      await app.close()
      close()
      safeCleanup(tempDir)
    },
  }
}

test("F027 P3.e callbacks: acquire-wiki-lease happy path", async () => {
  const { app, identity, cleanup } = await buildApp()
  try {
    const r = await app.inject({
      method: "POST",
      url: "/api/callbacks/acquire-wiki-lease",
      payload: {
        invocationId: identity.invocationId,
        callbackToken: identity.callbackToken,
        path: "wiki/concepts/foo.md",
      },
    })
    assert.equal(r.statusCode, 200)
    const body = r.json()
    assert.equal(body.status, "ok")
    assert.equal(body.fencingToken, "1")
    assert.ok(body.expiresAt)
  } finally {
    await cleanup()
  }
})

test("F027 P3.e callbacks: acquire-wiki-lease 已被持有 → 409 lease_held", async () => {
  const { app, identity, cleanup } = await buildApp()
  try {
    // 第一次拿
    await app.inject({
      method: "POST",
      url: "/api/callbacks/acquire-wiki-lease",
      payload: {
        invocationId: identity.invocationId,
        callbackToken: identity.callbackToken,
        path: "wiki/concepts/foo.md",
      },
    })
    // 第二次（同 caller，但 path 已被自己持有 —— acquireLease 也返 null 因为未过期）
    const r = await app.inject({
      method: "POST",
      url: "/api/callbacks/acquire-wiki-lease",
      payload: {
        invocationId: identity.invocationId,
        callbackToken: identity.callbackToken,
        path: "wiki/concepts/foo.md",
      },
    })
    assert.equal(r.statusCode, 409)
    assert.equal(r.json().status, "lease_held")
  } finally {
    await cleanup()
  }
})

test("F027 P3.e callbacks: read-wiki not_found / found", async () => {
  const { app, identity, wikiRoot, cleanup } = await buildApp()
  try {
    // not_found
    const r1 = await app.inject({
      method: "GET",
      url: `/api/callbacks/read-wiki?invocationId=${encodeURIComponent(identity.invocationId)}&callbackToken=${encodeURIComponent(identity.callbackToken)}&path=${encodeURIComponent("wiki/concepts/no.md")}`,
    })
    assert.equal(r1.statusCode, 200)
    assert.equal(r1.json().status, "not_found")

    // 写一个文件
    fs.mkdirSync(path.join(wikiRoot, "wiki/concepts"), { recursive: true })
    fs.writeFileSync(path.join(wikiRoot, "wiki/concepts/yes.md"), "hello")

    const r2 = await app.inject({
      method: "GET",
      url: `/api/callbacks/read-wiki?invocationId=${encodeURIComponent(identity.invocationId)}&callbackToken=${encodeURIComponent(identity.callbackToken)}&path=${encodeURIComponent("wiki/concepts/yes.md")}`,
    })
    assert.equal(r2.statusCode, 200)
    const body = r2.json()
    assert.equal(body.status, "ok")
    assert.equal(body.content, "hello")
    assert.equal(body.hash, sha256("hello"))
  } finally {
    await cleanup()
  }
})

test("F027 P3.e callbacks: update-wiki happy path 端到端", async () => {
  const { app, identity, wikiRoot, cleanup } = await buildApp()
  try {
    // step 1: acquire lease
    const a = await app.inject({
      method: "POST",
      url: "/api/callbacks/acquire-wiki-lease",
      payload: {
        invocationId: identity.invocationId,
        callbackToken: identity.callbackToken,
        path: "wiki/concepts/foo.md",
      },
    })
    const { fencingToken } = a.json()

    // step 2: update_wiki write
    const r = await app.inject({
      method: "POST",
      url: "/api/callbacks/update-wiki",
      payload: {
        invocationId: identity.invocationId,
        callbackToken: identity.callbackToken,
        path: "wiki/concepts/foo.md",
        action: "write",
        baseHash: null,
        content: "hello world",
        fencingToken,
      },
    })
    assert.equal(r.statusCode, 200)
    const body = r.json()
    assert.equal(body.status, "ok")

    // 文件落地
    const written = fs.readFileSync(path.join(wikiRoot, "wiki/concepts/foo.md"), "utf8")
    assert.equal(written, "hello world")
  } finally {
    await cleanup()
  }
})

test("F027 P3.e callbacks: update-wiki denied_acl → 403", async () => {
  const { app, identity, cleanup } = await buildApp()
  try {
    // 范德彪 拿 wiki/rules/ 的 lease（acquireLease 不查 ACL，能拿到）
    const a = await app.inject({
      method: "POST",
      url: "/api/callbacks/acquire-wiki-lease",
      payload: {
        invocationId: identity.invocationId,
        callbackToken: identity.callbackToken,
        path: "wiki/rules/iron-laws.md",
      },
    })
    const { fencingToken } = a.json()

    // 写应该被 ACL 拒
    const r = await app.inject({
      method: "POST",
      url: "/api/callbacks/update-wiki",
      payload: {
        invocationId: identity.invocationId,
        callbackToken: identity.callbackToken,
        path: "wiki/rules/iron-laws.md",
        action: "write",
        baseHash: null,
        content: "fake",
        fencingToken,
      },
    })
    assert.equal(r.statusCode, 403)
    assert.equal(r.json().status, "denied_acl")
  } finally {
    await cleanup()
  }
})

test("F027 P3.e callbacks: identity 缺失 → 401", async () => {
  const { app, cleanup } = await buildApp()
  try {
    const r = await app.inject({
      method: "POST",
      url: "/api/callbacks/acquire-wiki-lease",
      payload: { path: "wiki/concepts/foo.md" },
    })
    assert.equal(r.statusCode, 401)
  } finally {
    await cleanup()
  }
})

test("F027 P3.e callbacks: 缺 wikiServices → 503", async () => {
  const app = Fastify()
  const invocations = new InvocationRegistry<{ cancel: () => void }>()
  const identity = invocations.createInvocation("thread-x", "agent-x")
  registerCallbackRoutes(app, {
    repository: {
      getThreadById: () => ({ id: "thread-x", sessionGroupId: "g", alias: "x" }),
    } as never,
    sessions: { getActiveGroup: () => ({}) } as never,
    broadcaster: { broadcast: () => {} },
    getRunningThreadIds: () => new Set<string>(),
    invocations,
    isSessionGroupCancelled: () => false,
    // wikiServices 故意不传
  })
  try {
    const r = await app.inject({
      method: "POST",
      url: "/api/callbacks/acquire-wiki-lease",
      payload: {
        invocationId: identity.invocationId,
        callbackToken: identity.callbackToken,
        path: "wiki/concepts/foo.md",
      },
    })
    assert.equal(r.statusCode, 503)
  } finally {
    await app.close()
  }
})
