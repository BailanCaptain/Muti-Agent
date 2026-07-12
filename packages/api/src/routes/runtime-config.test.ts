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

// ── F027 收尾补丁 AC-W1 · wikiCompile.primaryModel ──────────────────────

test("AC-W1 · PUT wikiCompile.primaryModel 白名单值 → 200 + GET 回读", async () => {
  await withTempConfig(async () => {
    const app = Fastify()
    registerRuntimeConfigRoutes(app)
    const putRes = await app.inject({
      method: "PUT",
      url: "/api/runtime-config",
      payload: {
        config: {
          claude: { model: "claude-opus-4-6" },
          wikiCompile: { primaryModel: "claude-sonnet-4-6" },
        },
      },
    })
    assert.equal(putRes.statusCode, 200)
    const getRes = await app.inject({ method: "GET", url: "/api/runtime-config" })
    await app.close()
    assert.deepEqual(getRes.json(), {
      config: {
        claude: { model: "claude-opus-4-6" },
        wikiCompile: { primaryModel: "claude-sonnet-4-6" },
      },
    })
  })
})

test("收录设置 · primaryModel 自由字符串（小孙：新模型出了白名单不更新怎么办）→ 任意合理 id 200 回读", async () => {
  await withTempConfig(async () => {
    const app = Fastify()
    registerRuntimeConfigRoutes(app)
    // 非 claude 系 id（codex 引擎模型）也合法——白名单降级为前端建议列表
    const putRes = await app.inject({
      method: "PUT",
      url: "/api/runtime-config",
      payload: {
        config: { wikiCompile: { provider: "codex", primaryModel: "gpt-5.4-codex" } },
      },
    })
    assert.equal(putRes.statusCode, 200)
    const getRes = await app.inject({ method: "GET", url: "/api/runtime-config" })
    await app.close()
    assert.deepEqual(getRes.json(), {
      config: { wikiCompile: { provider: "codex", primaryModel: "gpt-5.4-codex" } },
    })
  })
})

test("收录设置 · provider 枚举外 → 400；primaryModel 空白/超长/控制字符 → 400", async () => {
  await withTempConfig(async () => {
    const app = Fastify()
    registerRuntimeConfigRoutes(app)
    const badPayloads = [
      { wikiCompile: { provider: "grok" } },
      { wikiCompile: { primaryModel: "   " } },
      { wikiCompile: { primaryModel: "x".repeat(65) } },
      { wikiCompile: { primaryModel: "bad\u0007id" } },
      // shell 注入面（model 进 spawn shell:true argv）：元字符/空格必须拒
      { wikiCompile: { primaryModel: "x & del-something" } },
      { wikiCompile: { primaryModel: 'a"b' } },
      { wikiCompile: { primaryModel: "a|b" } },
      // CLI flag 注入面：`-` 等开头的"模型 id"跟在 -m 后会被 CLI parser 当 flag
      // （clap/yargs 行为各家不一，不赌）——首字符必须字母数字
      { wikiCompile: { primaryModel: "--yolo" } },
      { wikiCompile: { primaryModel: "-m" } },
      { wikiCompile: { primaryModel: "/etc" } },
      { wikiCompile: { primaryModel: ".hidden" } },
      { wikiCompile: { primaryModel: ":tag" } },
    ]
    for (const config of badPayloads) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/runtime-config",
        payload: { config },
      })
      assert.equal(res.statusCode, 400, `应 400: ${JSON.stringify(config)} → ${res.body}`)
      const body = res.json() as { errors?: string[] }
      assert.ok(
        body.errors?.some((e) => e.includes("wikiCompile")),
        `errors 应指明 wikiCompile 字段: ${JSON.stringify(body)}`,
      )
    }
    await app.close()
  })
})

test("补丁#3 · wikiCompile.effort 按 provider 白名单校验（claude high/xhigh / codex xhigh → 200 回读）", async () => {
  await withTempConfig(async () => {
    const app = Fastify()
    registerRuntimeConfigRoutes(app)
    // claude + high（claude efforts 含 high）
    let put = await app.inject({
      method: "PUT",
      url: "/api/runtime-config",
      payload: { config: { wikiCompile: { provider: "claude", effort: "high" } } },
    })
    assert.equal(put.statusCode, 200)
    // claude + xhigh（实测 CLI 2.1.177 含 xhigh — F036 补 catalog）
    put = await app.inject({
      method: "PUT",
      url: "/api/runtime-config",
      payload: { config: { wikiCompile: { provider: "claude", effort: "xhigh" } } },
    })
    assert.equal(put.statusCode, 200)
    // codex + xhigh（codex efforts 含 xhigh）
    put = await app.inject({
      method: "PUT",
      url: "/api/runtime-config",
      payload: {
        config: { wikiCompile: { provider: "codex", primaryModel: "gpt-5.4", effort: "xhigh" } },
      },
    })
    assert.equal(put.statusCode, 200)
    const getRes = await app.inject({ method: "GET", url: "/api/runtime-config" })
    await app.close()
    assert.deepEqual(getRes.json(), {
      config: { wikiCompile: { provider: "codex", primaryModel: "gpt-5.4", effort: "xhigh" } },
    })
  })
})

test("补丁#3 · wikiCompile.effort 越界 → 400（gemini 无强度 / claude 不含 minimal / 默认 claude 不含 bogus）", async () => {
  await withTempConfig(async () => {
    const app = Fastify()
    registerRuntimeConfigRoutes(app)
    const bad = [
      { wikiCompile: { provider: "gemini", effort: "high" } }, // gemini efforts=[]
      { wikiCompile: { provider: "claude", effort: "minimal" } }, // minimal 是 codex 专属，claude 没有
      { wikiCompile: { effort: "bogus" } }, // 默认 claude，bogus 非法
      { wikiCompile: { effort: 123 } }, // 非字符串
    ]
    for (const config of bad) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/runtime-config",
        payload: { config },
      })
      assert.equal(res.statusCode, 400, `应 400: ${JSON.stringify(config)} → ${res.body}`)
      const body = res.json() as { errors?: string[] }
      assert.ok(
        body.errors?.some((e) => e.includes("effort")),
        `errors 应指明 effort: ${JSON.stringify(body)}`,
      )
    }
    await app.close()
  })
})

test("收录设置 · provider 单独设置（model 留空 = 该引擎 CLI 默认模型）→ 200 回读", async () => {
  await withTempConfig(async () => {
    const app = Fastify()
    registerRuntimeConfigRoutes(app)
    const putRes = await app.inject({
      method: "PUT",
      url: "/api/runtime-config",
      payload: { config: { wikiCompile: { provider: "gemini" } } },
    })
    assert.equal(putRes.statusCode, 200)
    const getRes = await app.inject({ method: "GET", url: "/api/runtime-config" })
    await app.close()
    assert.deepEqual(getRes.json(), {
      config: { wikiCompile: { provider: "gemini" } },
    })
  })
})

test("AC-W1 · PUT wikiCompile 非 object → 400", async () => {
  await withTempConfig(async () => {
    const app = Fastify()
    registerRuntimeConfigRoutes(app)
    const res = await app.inject({
      method: "PUT",
      url: "/api/runtime-config",
      payload: { config: { wikiCompile: "claude-sonnet-4-6" } },
    })
    await app.close()
    assert.equal(res.statusCode, 400)
  })
})

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
    assert.ok(
      body.errors && body.errors.length >= 2,
      `expected ≥2 errors, got ${JSON.stringify(body.errors)}`,
    )
  })
})

// 注：model / effort 仍走 sanitize 静默 drop（plan Task 8 scope 仅含 contextWindow + sealPct）

// ── F037 · dailyDigest 段与 agent 整存 PUT 的共存（德彪 batchB P2 丢写窗修法）──

test("F037 · agent 整存 PUT 不带 dailyDigest → 已存日报段保留；带了则以 payload 为准", async () => {
  await withTempConfig(async () => {
    const app = Fastify()
    registerRuntimeConfigRoutes(app)
    // 先经日报设置面语义存入 dailyDigest（这里直接 PUT 带段模拟已存态）
    const seed = await app.inject({
      method: "PUT",
      url: "/api/runtime-config",
      payload: { config: { dailyDigest: { sendTime: "06:00" } } },
    })
    assert.equal(seed.statusCode, 200)
    // agent 页旧快照整存（无 dailyDigest 字段）→ 段不许被清
    const agentPut = await app.inject({
      method: "PUT",
      url: "/api/runtime-config",
      payload: { config: { claude: { model: "claude-opus-4-8" } } },
    })
    assert.equal(agentPut.statusCode, 200)
    const got = (await app.inject({ method: "GET", url: "/api/runtime-config" })).json() as {
      config: { dailyDigest?: { sendTime?: string }; claude?: { model?: string } }
    }
    await app.close()
    assert.equal(got.config.dailyDigest?.sendTime, "06:00", "日报段被 agent 整存清掉了")
    assert.equal(got.config.claude?.model, "claude-opus-4-8")
  })
})
