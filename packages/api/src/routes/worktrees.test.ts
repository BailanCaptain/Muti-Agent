import assert from "node:assert/strict"
import { test } from "node:test"

import Fastify from "fastify"

import { registerWorktreeRoutes, type WorktreeRoutesOpts } from "./worktrees"

/** F028 Task 7 · worktrees 路由（plan v5 用例 1-9，全 fake 注入） */

const INVENTORY = [
  { name: "main", branch: "dev", head: "a", path: "C:/repo", isMain: true, preview: null, mergeStatus: null },
  {
    name: "F028",
    branch: "feat/x",
    head: "b",
    path: "C:/repo/.worktrees/F028",
    isMain: false,
    preview: { apiPort: 8801, webPort: 3101, apiAlive: true, webAlive: true, ownership: "ui" as const },
    mergeStatus: { ahead: 5, behind: 0, mergedHint: false },
  },
]

function makeOpts(overrides: Partial<WorktreeRoutesOpts> = {}): WorktreeRoutesOpts & {
  calls: string[]
} {
  const calls: string[] = []
  const opts: WorktreeRoutesOpts = {
    controlEnabled: true,
    inventory: async () => INVENTORY,
    summary: async (name) =>
      name === "F028"
        ? {
            branch: "feat/x",
            head: "b",
            commits: [],
            diffStat: { baseRef: "dev", files: 1, insertions: 2, deletions: 3 },
            working: { staged: 0, unstaged: 0, untracked: 0 },
          }
        : { error: "boom" },
    orchestrator: {
      compileBackend: async (name) => {
        calls.push(`compile:${name}`)
        return { ok: true, apiPort: 8801, webPort: 3101 }
      },
      restartAll: async () => ({ ok: true, apiPort: 8801, webPort: 3101 }),
      start: async () => ({ ok: true, apiPort: 8801, webPort: 3101 }),
      stop: async (name) => {
        calls.push(`stop:${name}`)
        return { ok: true, apiPort: 8801, webPort: 3101 }
      },
      withCleanupLock: async (_name, _onBusy, fn) => fn(async () => ({ ok: true, apiPort: 0, webPort: 0 })),
      tailLog: async (name, proc, lines) => {
        calls.push(`tail:${name}:${proc}:${lines}`)
        return { lines: ["a", "b"], logPath: "p" }
      },
    },
    cleanup: async (name) => {
      calls.push(`cleanup:${name}`)
      return { ok: true, steps: [{ name: "safety-gate", ok: true }, { name: "worktree-remove", ok: true }] }
    },
    allowedOrigins: async () => new Set(["http://localhost:3000", "http://localhost:3101"]),
    reconcile: async () => {
      calls.push("reconcile")
    },
  }
  Object.assign(opts, overrides)
  return Object.assign(opts, { calls })
}

async function makeApp(opts: WorktreeRoutesOpts) {
  const app = Fastify({ logger: false })
  await registerWorktreeRoutes(app, opts)
  await app.ready()
  return app
}

// (1) GET /api/worktrees 透传
test("F028 T7 · GET /api/worktrees returns inventory", async () => {
  const app = await makeApp(makeOpts())
  const res = await app.inject({ method: "GET", url: "/api/worktrees" })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().worktrees.length, 2)
  await app.close()
})

// (2) summary 未知 name → 404
test("F028 T7 · GET summary unknown name → 404", async () => {
  const app = await makeApp(makeOpts())
  const res = await app.inject({ method: "GET", url: "/api/worktrees/ghost/summary" })
  assert.equal(res.statusCode, 404)
  const ok = await app.inject({ method: "GET", url: "/api/worktrees/F028/summary" })
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.json().diffStat.files, 1)
  await app.close()
})

// (3) POST main → 400
test("F028 T7 · POST compile-backend on main → 400", async () => {
  const app = await makeApp(makeOpts())
  const res = await app.inject({ method: "POST", url: "/api/worktrees/main/preview/compile-backend" })
  assert.equal(res.statusCode, 400)
  await app.close()
})

// (4) Origin 矩阵
test("F028 T7 · POST origin matrix: main UI/registry pass, api-self/evil 403, absent pass", async () => {
  const app = await makeApp(makeOpts())
  const url = "/api/worktrees/F028/preview/compile-backend"
  for (const [origin, expected] of [
    ["http://localhost:3000", 200],
    ["http://localhost:3101", 200],
    ["http://localhost:8800", 403],
    ["http://evil.com", 403],
  ] as const) {
    const res = await app.inject({ method: "POST", url, headers: { origin } })
    assert.equal(res.statusCode, expected, `origin=${origin}`)
  }
  const noOrigin = await app.inject({ method: "POST", url })
  assert.equal(noOrigin.statusCode, 200)
  await app.close()
})

// (5) 结果映射：ok 200 / in-progress 409 / 其他失败 200+ok:false
test("F028 T7 · action result mapping 200/409/200-okfalse", async () => {
  const okApp = await makeApp(makeOpts())
  const okRes = await okApp.inject({ method: "POST", url: "/api/worktrees/F028/preview/compile-backend" })
  assert.equal(okRes.statusCode, 200)
  assert.equal(okRes.json().ok, true)
  await okApp.close()

  const busyApp = await makeApp(
    makeOpts({
      orchestrator: {
        compileBackend: async () => ({ ok: false, stage: "in-progress", message: "busy" }),
        restartAll: async () => ({ ok: false, stage: "occupied-foreign", message: "x" }),
        start: async () => ({ ok: true, apiPort: 1, webPort: 2 }),
        stop: async () => ({ ok: true, apiPort: 1, webPort: 2 }),
        withCleanupLock: async (_n, _b, fn) => fn(async () => ({ ok: true, apiPort: 0, webPort: 0 })),
        tailLog: async () => ({ lines: [], logPath: "" }),
      },
    }),
  )
  const busy = await busyApp.inject({ method: "POST", url: "/api/worktrees/F028/preview/compile-backend" })
  assert.equal(busy.statusCode, 409)
  const foreign = await busyApp.inject({ method: "POST", url: "/api/worktrees/F028/preview/restart" })
  assert.equal(foreign.statusCode, 200)
  assert.equal(foreign.json().ok, false)
  assert.equal(foreign.json().stage, "occupied-foreign")
  await busyApp.close()
})

// (6) log 端点
test("F028 T7 · GET log passes through, invalid proc → 400", async () => {
  const opts = makeOpts()
  const app = await makeApp(opts)
  const res = await app.inject({ method: "GET", url: "/api/worktrees/F028/preview/log?proc=web&lines=50" })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().lines, ["a", "b"])
  assert.ok(opts.calls.includes("tail:F028:web:50"))
  const bad = await app.inject({ method: "GET", url: "/api/worktrees/F028/preview/log?proc=evil" })
  assert.equal(bad.statusCode, 400)
  await app.close()
})

// (7) name 名单外 → 400
test("F028 T7 · POST with traversal-ish name → 400", async () => {
  const app = await makeApp(makeOpts())
  const res = await app.inject({ method: "POST", url: "/api/worktrees/..%2Fx/preview/compile-backend" })
  assert.equal(res.statusCode, 400)
  await app.close()
})

// (8) reconcile 恰一次（注册路径）
test("F028 T7 · reconcile called exactly once at registration when control enabled", async () => {
  const opts = makeOpts()
  const app = await makeApp(opts)
  assert.equal(opts.calls.filter((c) => c === "reconcile").length, 1)
  await app.close()
})

// (9) D12 注册门禁
test("F028 T7 · WORKTREE_PREVIEW gate: control routes absent, read-only present, capabilities false", async () => {
  const opts = makeOpts({ controlEnabled: false })
  const app = await makeApp(opts)

  const cap = await app.inject({ method: "GET", url: "/api/worktrees/capabilities" })
  assert.equal(cap.statusCode, 200)
  assert.equal(cap.json().control, false)

  const list = await app.inject({ method: "GET", url: "/api/worktrees" })
  assert.equal(list.statusCode, 200) // 只读正常

  const post = await app.inject({ method: "POST", url: "/api/worktrees/F028/preview/compile-backend" })
  assert.equal(post.statusCode, 404) // 控制路由未注册

  assert.equal(opts.calls.filter((c) => c === "reconcile").length, 0) // preview 实例不 reconcile
  await app.close()

  const mainApp = await makeApp(makeOpts())
  const cap2 = await mainApp.inject({ method: "GET", url: "/api/worktrees/capabilities" })
  assert.equal(cap2.json().control, true)
  await mainApp.close()
})

// ── 续作 AC12 · 清理端点 ────────────────────────────────────────────────────

// 清理 happy：200 + {ok, steps} 透传，cleanup(name) 被调
test("F028 AC12 · POST cleanup returns ok+steps and calls cleanup(name)", async () => {
  const opts = makeOpts()
  const app = await makeApp(opts)
  const res = await app.inject({
    method: "POST",
    url: "/api/worktrees/F028/cleanup",
    headers: { origin: "http://localhost:3000" },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  assert.ok(Array.isArray(res.json().steps))
  assert.ok(opts.calls.includes("cleanup:F028"))
  await app.close()
})

// 清理 control 关（preview 实例 D12）→ 路由不注册 → 404
test("F028 AC12 · POST cleanup not registered when control disabled (404)", async () => {
  const app = await makeApp(makeOpts({ controlEnabled: false }))
  const res = await app.inject({ method: "POST", url: "/api/worktrees/F028/cleanup" })
  assert.equal(res.statusCode, 404)
  await app.close()
})

// 清理错误 Origin → 403（延续 AC6 控制面合同）
test("F028 AC12 · POST cleanup wrong origin → 403", async () => {
  const opts = makeOpts()
  const app = await makeApp(opts)
  const res = await app.inject({
    method: "POST",
    url: "/api/worktrees/F028/cleanup",
    headers: { origin: "http://evil.example" },
  })
  assert.equal(res.statusCode, 403)
  assert.ok(!opts.calls.includes("cleanup:F028"), "Origin 不过不得进入清理")
  await app.close()
})

// 无 Origin（curl/同进程）→ 放行 200
test("F028 AC12 · POST cleanup without origin allowed (200)", async () => {
  const app = await makeApp(makeOpts())
  const res = await app.inject({ method: "POST", url: "/api/worktrees/F028/cleanup" })
  assert.equal(res.statusCode, 200)
  await app.close()
})
