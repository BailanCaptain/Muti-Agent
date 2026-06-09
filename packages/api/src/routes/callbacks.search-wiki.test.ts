/**
 * F027 wiring · /api/callbacks/search-wiki 集成测试
 * 真相源：docs/plans/V16.5-final.md chap 12 行 1401-1410（Level 2 search_wiki）
 *
 * 覆盖（search_wiki MCP 的 API 侧读路径）：
 *   - happy path：route → options.searchWiki → 返 hits（+ 透传 query/topK/scope）
 *   - searchWiki 未注入 → graceful empty hits:[]（不 500）
 *   - 缺 query → 400
 *   - identity 鉴权失败 → 401
 *   - topK 越界（>50）截到 50 / 非法 → 默认 5
 */

import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { InvocationRegistry } from "../orchestrator/invocation-registry"
import { registerCallbackRoutes } from "./callbacks"

type SearchWikiParams = { query: string; topK: number; scope?: string }

function buildApp(opts?: {
  searchWiki?: (params: SearchWikiParams) => Promise<{
    hits: Array<{ path: string; score: number; excerpt: string }>
  }>
}) {
  const invocations = new InvocationRegistry<{ cancel: () => void }>()
  const identity = invocations.createInvocation("thread-sw", "agent-sw")
  const app = Fastify()
  registerCallbackRoutes(app, {
    repository: {
      getThreadById: () => ({ id: "thread-sw", sessionGroupId: "group-1", alias: "范德彪" }),
      appendMessage: () => ({ id: "ignored" }),
      listThreadsByGroup: () => [],
      listMessages: () => [],
    } as never,
    sessions: { getActiveGroup: () => ({ id: "group-1", timeline: [] }) } as never,
    broadcaster: { broadcast: () => {} },
    getRunningThreadIds: () => new Set<string>(),
    invocations,
    isSessionGroupCancelled: () => false,
    ...(opts?.searchWiki ? { searchWiki: opts.searchWiki } : {}),
  })
  return { app, identity }
}

test("F027 wiring search-wiki: happy path → 透传 query/topK/scope + 返 hits", async () => {
  const calls: SearchWikiParams[] = []
  const { app, identity } = buildApp({
    searchWiki: async (params) => {
      calls.push(params)
      return {
        hits: [
          { path: "wiki/concepts/F011.md", score: 1, excerpt: "F011 backend hardening" },
          { path: "wiki/concepts/B022.md", score: 0.6, excerpt: "iron laws" },
        ],
      }
    },
  })
  try {
    const r = await app.inject({
      method: "GET",
      url: "/api/callbacks/search-wiki",
      query: {
        invocationId: identity.invocationId,
        callbackToken: identity.callbackToken,
        query: "F011",
        topK: "3",
        scope: "concepts",
      },
    })
    assert.equal(r.statusCode, 200)
    const body = r.json() as { hits: Array<{ path: string }> }
    assert.equal(body.hits.length, 2)
    assert.equal(body.hits[0].path, "wiki/concepts/F011.md")
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], { query: "F011", topK: 3, scope: "concepts" })
  } finally {
    await app.close()
  }
})

test("F027 wiring search-wiki: searchWiki 未注入 → graceful empty hits:[]", async () => {
  const { app, identity } = buildApp() // 不传 searchWiki
  try {
    const r = await app.inject({
      method: "GET",
      url: "/api/callbacks/search-wiki",
      query: {
        invocationId: identity.invocationId,
        callbackToken: identity.callbackToken,
        query: "anything",
      },
    })
    assert.equal(r.statusCode, 200)
    assert.deepEqual(r.json(), { hits: [] })
  } finally {
    await app.close()
  }
})

test("F027 wiring search-wiki: 缺 query → 400", async () => {
  const { app, identity } = buildApp({ searchWiki: async () => ({ hits: [] }) })
  try {
    const r = await app.inject({
      method: "GET",
      url: "/api/callbacks/search-wiki",
      query: {
        invocationId: identity.invocationId,
        callbackToken: identity.callbackToken,
        query: "   ",
      },
    })
    assert.equal(r.statusCode, 400)
  } finally {
    await app.close()
  }
})

test("F027 wiring search-wiki: identity 鉴权失败 → 401", async () => {
  const { app } = buildApp({ searchWiki: async () => ({ hits: [] }) })
  try {
    const r = await app.inject({
      method: "GET",
      url: "/api/callbacks/search-wiki",
      query: {
        invocationId: "bogus",
        callbackToken: "bogus",
        query: "F011",
      },
    })
    assert.equal(r.statusCode, 401)
  } finally {
    await app.close()
  }
})

test("F027 wiring search-wiki: topK 越界截 50 / 非法默认 5", async () => {
  const seen: number[] = []
  const { app, identity } = buildApp({
    searchWiki: async (params) => {
      seen.push(params.topK)
      return { hits: [] }
    },
  })
  try {
    for (const [raw, expected] of [
      ["999", 50],
      ["abc", 5],
      ["0", 5],
    ] as const) {
      await app.inject({
        method: "GET",
        url: "/api/callbacks/search-wiki",
        query: {
          invocationId: identity.invocationId,
          callbackToken: identity.callbackToken,
          query: "F011",
          topK: raw,
        },
      })
    }
    assert.deepEqual(seen, [50, 5, 5])
  } finally {
    await app.close()
  }
})
