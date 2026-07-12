import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { registerDailyDigestRoutes } from "./daily-digest"

function withArchive<T>(fn: (baseDir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ma-digest-routes-"))
  return Promise.resolve(fn(dir)).finally(() => {
    rmSync(dir, { recursive: true, force: true })
  })
}

function seedDay(
  baseDir: string,
  date: string,
  opts: { summary?: boolean; items?: string[] } = {},
) {
  const day = path.join(baseDir, date)
  mkdirSync(day, { recursive: true })
  if (opts.summary !== false) {
    writeFileSync(
      path.join(day, "summary.json"),
      JSON.stringify({
        businessDate: date,
        degraded: false,
        summary: {
          overview: ["要点"],
          sections: [{ category: "ai", picks: [{ itemId: "aaa", summaryZh: "s", tag: "推理" }] }],
          degraded: false,
        },
        sourceHealth: [
          { sourceId: "hn-ai", status: "ok", itemCount: 2, durationMs: 5, error: null },
        ],
        counts: { content: 2, github: 0 },
      }),
    )
  }
  writeFileSync(
    path.join(day, "items.jsonl"),
    (
      opts.items ?? [
        JSON.stringify({
          id: "aaa",
          category: "ai",
          sourceId: "hn-ai",
          title: "t",
          canonicalUrl: "https://a.com/1",
        }),
        "not json — broken line",
        JSON.stringify({
          id: "bbb",
          category: "x",
          sourceId: "x-firsthand",
          title: "@sama: hi",
          canonicalUrl: "https://x.com/1",
          topicTag: "从业者",
        }),
      ]
    ).join("\n"),
  )
}

test("dates：只列日期形目录、按新到旧、忽略垃圾目录", async () => {
  await withArchive(async (baseDir) => {
    seedDay(baseDir, "2026-07-04")
    seedDay(baseDir, "2026-07-05")
    mkdirSync(path.join(baseDir, "mock-outbox"), { recursive: true }) // 非日期目录
    mkdirSync(path.join(baseDir, "2026-07-06")) // 日期形但无归档文件
    const app = Fastify()
    registerDailyDigestRoutes(app, { baseDir })
    const res = await app.inject({ method: "GET", url: "/api/daily-digest/dates" })
    await app.close()
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { dates: ["2026-07-05", "2026-07-04"] })
  })
})

test(":date：summary + items（损坏行跳过）+ labels 中文源名", async () => {
  await withArchive(async (baseDir) => {
    seedDay(baseDir, "2026-07-05")
    const app = Fastify()
    registerDailyDigestRoutes(app, { baseDir })
    const res = await app.inject({ method: "GET", url: "/api/daily-digest/2026-07-05" })
    await app.close()
    assert.equal(res.statusCode, 200)
    const body = res.json() as {
      businessDate: string
      summary: { summary: { sections: Array<{ picks: Array<{ tag?: string }> }> } }
      items: Array<{ id: string }>
      labels: Record<string, string>
    }
    assert.equal(body.businessDate, "2026-07-05")
    assert.equal(body.summary.summary.sections[0].picks[0].tag, "推理")
    assert.equal(body.items.length, 2) // 损坏行被跳过
    assert.equal(body.labels["hn-ai"], "Hacker News")
    assert.equal(body.labels["x-firsthand"], "X 一手动态")
  })
})

test(":date：旧归档无 summary.json → summary null 仍 200（前端降级纯条目视图）", async () => {
  await withArchive(async (baseDir) => {
    seedDay(baseDir, "2026-07-01", { summary: false })
    const app = Fastify()
    registerDailyDigestRoutes(app, { baseDir })
    const res = await app.inject({ method: "GET", url: "/api/daily-digest/2026-07-01" })
    await app.close()
    assert.equal(res.statusCode, 200)
    const body = res.json() as { summary: unknown; items: unknown[] }
    assert.equal(body.summary, null)
    assert.equal(body.items.length, 2)
  })
})

test(":date：非法日期形状 400（路径遍历钉死）；无归档 404", async () => {
  await withArchive(async (baseDir) => {
    seedDay(baseDir, "2026-07-05")
    const app = Fastify()
    registerDailyDigestRoutes(app, { baseDir })
    const bad = await app.inject({ method: "GET", url: "/api/daily-digest/..%2F..%2Fetc" })
    assert.equal(bad.statusCode, 400)
    const missing = await app.inject({ method: "GET", url: "/api/daily-digest/2020-01-01" })
    assert.equal(missing.statusCode, 404)
    await app.close()
  })
})

// ---- F037 §5 设置面 + 立即补发 ----

function withConfigEnv<T>(fn: (configPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ma-digest-settings-"))
  const configPath = path.join(dir, "runtime-config.json")
  const prev = process.env.MULTI_AGENT_RUNTIME_CONFIG_PATH
  process.env.MULTI_AGENT_RUNTIME_CONFIG_PATH = configPath
  return Promise.resolve(fn(configPath)).finally(() => {
    if (prev === undefined) {
      process.env.MULTI_AGENT_RUNTIME_CONFIG_PATH = undefined as unknown as string
      Reflect.deleteProperty(process.env, "MULTI_AGENT_RUNTIME_CONFIG_PATH")
    } else {
      process.env.MULTI_AGENT_RUNTIME_CONFIG_PATH = prev
    }
    rmSync(dir, { recursive: true, force: true })
  })
}

test("settings GET：secrets 只出布尔、种子/生效值/源清单齐全", async () => {
  await withConfigEnv(async () => {
    await withArchive(async (baseDir) => {
      const app = Fastify()
      registerDailyDigestRoutes(app, {
        baseDir,
        enabled: true,
        env: {
          MULTI_AGENT_DIGEST_TO: "a@x.com",
          MULTI_AGENT_DIGEST_SMTP_USER: "u@qq.com",
          MULTI_AGENT_DIGEST_SMTP_PASS: "super-secret",
          MULTI_AGENT_DIGEST_X_HANDLES: "sama",
        } as NodeJS.ProcessEnv,
      })
      const res = await app.inject({ method: "GET", url: "/api/daily-digest/settings" })
      await app.close()
      assert.equal(res.statusCode, 200)
      const body = res.json() as {
        enabled: boolean
        stored: unknown
        effective: { recipients: string[]; xHandles: string[] }
        secrets: Record<string, boolean>
        sources: Array<{ id: string; label: string; category: string }>
      }
      assert.equal(body.enabled, true)
      assert.equal(body.stored, null)
      assert.deepEqual(body.effective.recipients, ["a@x.com"])
      assert.deepEqual(body.effective.xHandles, ["sama"])
      // seedEffective = 纯 .env 基线（前端 diff 基准）
      const seed = (res.json() as { seedEffective: { recipients: string[] } }).seedEffective
      assert.deepEqual(seed.recipients, ["a@x.com"])
      assert.equal(body.secrets.smtp, true)
      assert.equal(body.secrets.githubPat, false)
      // secrets 值绝不下发
      assert.ok(!res.body.includes("super-secret"))
      assert.ok(body.sources.length > 15)
      assert.ok(body.sources.some((s) => s.id === "x-firsthand"))
      assert.ok(body.sources.every((s) => typeof s.label === "string" && s.label.length > 0))
    })
  })
})

test("settings PUT：合法存段（sanitize 归一）；非法 400；null 清空", async () => {
  await withConfigEnv(async () => {
    await withArchive(async (baseDir) => {
      const app = Fastify()
      const env = { MULTI_AGENT_DIGEST_TO: "seed@x.com" } as NodeJS.ProcessEnv
      registerDailyDigestRoutes(app, { baseDir, env })
      const put = await app.inject({
        method: "PUT",
        url: "/api/daily-digest/settings",
        payload: {
          settings: { recipients: ["me@y.com"], xHandles: ["@OpenAI"], sendTime: "06:00" },
        },
      })
      assert.equal(put.statusCode, 200)
      const putBody = put.json() as {
        ok: boolean
        stored: { xHandles: string[] }
        effective: { recipients: string[]; sendTime: string }
      }
      assert.deepEqual(putBody.stored.xHandles, ["OpenAI"]) // @ 剥掉（sanitize 归一）
      assert.deepEqual(putBody.effective.recipients, ["me@y.com"])
      assert.equal(putBody.effective.sendTime, "06:00")

      const bad = await app.inject({
        method: "PUT",
        url: "/api/daily-digest/settings",
        payload: { settings: { sendTime: "25:99", junkField: 1 } },
      })
      assert.equal(bad.statusCode, 400)
      const badBody = bad.json() as { errors: string[] }
      assert.ok(badBody.errors.some((e) => e.includes("sendTime")))
      assert.ok(badBody.errors.some((e) => e.includes("unknown field")))

      const clear = await app.inject({
        method: "PUT",
        url: "/api/daily-digest/settings",
        payload: { settings: null },
      })
      assert.equal(clear.statusCode, 200)
      const clearBody = clear.json() as { stored: unknown; effective: { recipients: string[] } }
      assert.equal(clearBody.stored, null)
      assert.deepEqual(clearBody.effective.recipients, ["seed@x.com"]) // 回落种子
      await app.close()
    })
  })
})

test("send-now：无 runtime → 503；有 → 202 + 状态轮询 + 进行中 409", async () => {
  await withArchive(async (baseDir) => {
    const offApp = Fastify()
    registerDailyDigestRoutes(offApp, { baseDir })
    const off = await offApp.inject({ method: "POST", url: "/api/daily-digest/send-now" })
    assert.equal(off.statusCode, 503)
    await offApp.close()

    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const calls: Array<{ force?: boolean }> = []
    const app = Fastify()
    registerDailyDigestRoutes(app, {
      baseDir,
      enabled: true,
      runtime: {
        reconcile: async (_now, opts) => {
          calls.push(opts ?? {})
          await gate
          return { status: "ok" as const, businessDate: "2026-07-05", degraded: false }
        },
      },
    })
    const started = await app.inject({ method: "POST", url: "/api/daily-digest/send-now" })
    assert.equal(started.statusCode, 202)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].force, true)

    const busy = await app.inject({ method: "POST", url: "/api/daily-digest/send-now" })
    assert.equal(busy.statusCode, 409)

    const mid = await app.inject({ method: "GET", url: "/api/daily-digest/send-now" })
    assert.equal((mid.json() as { running: boolean }).running, true)

    release?.()
    await new Promise((r) => setTimeout(r, 10))
    const done = await app.inject({ method: "GET", url: "/api/daily-digest/send-now" })
    const doneBody = done.json() as {
      running: boolean
      lastOutcome: { status: string; businessDate?: string }
    }
    assert.equal(doneBody.running, false)
    assert.equal(doneBody.lastOutcome.status, "ok")
    await app.close()
  })
})
