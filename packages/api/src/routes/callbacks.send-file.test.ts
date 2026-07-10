import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { InvocationRegistry } from "../orchestrator/invocation-registry"
import { registerCallbackRoutes } from "./callbacks"

/**
 * F040 T7 修11（德彪 r7 P2）：send-file 路由级契约。核心=Fastify 默认 bodyLimit 1MiB
 * 会在 JSON 解析层抢跑 413（600KB 换行转义后 1.2MB 请求体根本进不了 handler），
 * 路由声明的「content ≤1MB」必须真实可达：精确 1MiB 过 / 1MiB+1 由路由字节检查拒
 * （文案是我们的，不是 FST_ERR_CTP_BODY_TOO_LARGE）/ 转义密集低于契约上限的过。
 */

function makeApp(opts?: { sendFile?: boolean }) {
  const app = Fastify()
  const invocations = new InvocationRegistry<{ cancel: () => void }>()
  const identity = invocations.createInvocation("thread-1", "agent-1")
  const calls: Array<{ filename?: string; contentBytes: number }> = []
  registerCallbackRoutes(app, {
    repository: {
      getThreadById: () => ({ id: "thread-1", sessionGroupId: "group-1" }),
    } as never,
    sessions: {} as never,
    broadcaster: { broadcast() {} },
    getRunningThreadIds: () => new Set<string>(),
    invocations,
    isSessionGroupCancelled: () => false,
    ...(opts?.sendFile === false
      ? {}
      : {
          sendFile: async (p: {
            threadId: string
            sessionGroupId: string
            filename?: string
            content: string
          }) => {
            calls.push({
              filename: p.filename,
              contentBytes: Buffer.byteLength(p.content, "utf8"),
            })
            return {
              ok: true as const,
              fileUrl: "http://api/uploads/agent-1.txt",
              name: p.filename ?? "attachment.txt",
            }
          },
        }),
  })
  return { app, identity, calls }
}

test("send-file: 无效 invocation 身份 → 401", async () => {
  const { app, identity, calls } = makeApp()
  const res = await app.inject({
    method: "POST",
    url: "/api/callbacks/send-file",
    payload: {
      invocationId: identity.invocationId,
      callbackToken: "wrong-token",
      filename: "a.txt",
      content: "hi",
    },
  })
  assert.equal(res.statusCode, 401)
  assert.equal(calls.length, 0)
  await app.close()
})

test("send-file: content 缺失/空 → 400；filename 超 255 字符 → 400（信封上限的前提）", async () => {
  const { app, identity, calls } = makeApp()
  const base = { invocationId: identity.invocationId, callbackToken: identity.callbackToken }
  const noContent = await app.inject({
    method: "POST",
    url: "/api/callbacks/send-file",
    payload: { ...base, filename: "a.txt" },
  })
  assert.equal(noContent.statusCode, 400)
  const emptyContent = await app.inject({
    method: "POST",
    url: "/api/callbacks/send-file",
    payload: { ...base, filename: "a.txt", content: "" },
  })
  assert.equal(emptyContent.statusCode, 400)
  const longName = await app.inject({
    method: "POST",
    url: "/api/callbacks/send-file",
    payload: { ...base, filename: "x".repeat(256), content: "hi" },
  })
  assert.equal(longName.statusCode, 400)
  assert.equal(calls.length, 0)
  await app.close()
})

test("send-file: 精确 1MiB content 可达 handler（路由 bodyLimit 抬高，解析层不再抢跑 413）", async () => {
  const { app, identity, calls } = makeApp()
  const res = await app.inject({
    method: "POST",
    url: "/api/callbacks/send-file",
    payload: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      filename: "big.txt",
      content: "a".repeat(1_048_576),
    },
  })
  assert.equal(res.statusCode, 200, `body: ${res.body.slice(0, 200)}`)
  assert.deepEqual(calls, [{ filename: "big.txt", contentBytes: 1_048_576 }])
  await app.close()
})

test("send-file: 1MiB+1 → 413 且是路由字节检查的文案（非解析层错误）", async () => {
  const { app, identity, calls } = makeApp()
  const res = await app.inject({
    method: "POST",
    url: "/api/callbacks/send-file",
    payload: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      filename: "big.txt",
      content: "a".repeat(1_048_577),
    },
  })
  assert.equal(res.statusCode, 413)
  assert.match(res.body, /1MB text limit/)
  assert.equal(calls.length, 0)
  await app.close()
})

test("send-file: 转义密集（600KB 换行 <1MB content，JSON 体 ~1.2MB）→ 200", async () => {
  const { app, identity, calls } = makeApp()
  const res = await app.inject({
    method: "POST",
    url: "/api/callbacks/send-file",
    payload: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      filename: "log.txt",
      content: "\n".repeat(600_000),
    },
  })
  assert.equal(res.statusCode, 200, `body: ${res.body.slice(0, 200)}`)
  assert.equal(calls[0]?.contentBytes, 600_000)
  await app.close()
})

test("send-file: 能力未装配 → 501", async () => {
  const { app, identity } = makeApp({ sendFile: false })
  const res = await app.inject({
    method: "POST",
    url: "/api/callbacks/send-file",
    payload: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      filename: "a.txt",
      content: "hi",
    },
  })
  assert.equal(res.statusCode, 501)
  await app.close()
})
