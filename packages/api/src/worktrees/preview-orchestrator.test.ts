import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { slugifyWorktreeId } from "./preview-guards"
import {
  createPreviewOrchestrator,
  type OrchestratorDeps,
} from "./preview-orchestrator"
import { createPreviewStateStore } from "./preview-state"
import type { PreviewState } from "./preview-state-types"

/**
 * F028 Task 4 · preview 编排器（plan v5 14 用例）
 * deps 全注入零真 IO；callLog 记录调用序做顺序断言（case 4：双预检先于首杀）。
 */

const WT = { name: "F028", branch: "feat/x", head: "abc", path: "C:/repo/.worktrees/F028", isMain: false }
const MAIN = {
  name: "main",
  branch: "dev",
  head: "aaa",
  path: "C:/repo",
  isMain: true,
  preview: null,
}
const API_REC = { pid: 100, creationDate: "1700000000100", startedAt: "t0" }
const WEB_REC = { pid: 200, creationDate: "1700000000200", startedAt: "t0" }

type Harness = {
  deps: OrchestratorDeps
  calls: string[]
  base: string
  seedState: (state?: Partial<PreviewState>) => Promise<void>
}

async function makeHarness(overrides: Partial<OrchestratorDeps> = {}): Promise<Harness> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "f028-orch-"))
  const calls: string[] = []
  const store = createPreviewStateStore({ baseDir: base, now: () => "T" })

  const fullState: PreviewState = {
    worktreeName: "F028",
    worktreeId: slugifyWorktreeId("F028"),
    apiPort: 8801,
    webPort: 3101,
    processes: { api: { ...API_REC }, web: { ...WEB_REC } },
  }

  let spawnSeq = 0
  const deps: OrchestratorDeps = {
    inventory: async () => [
      MAIN,
      {
        ...WT,
        preview: { apiPort: 8801, webPort: 3101, apiAlive: true, webAlive: true, ownership: "ui" as const },
      },
    ],
    store,
    probeCreationDate: async (pid) => {
      calls.push(`probeCreation:${pid}`)
      if (pid === 100) return API_REC.creationDate
      if (pid === 200) return WEB_REC.creationDate
      if (pid >= 9000) return `spawned-${pid}` // 新 spawn 的进程
      return null
    },
    processTable: async () => [
      { pid: 100, ppid: 1 },
      { pid: 101, ppid: 100 }, // api listener = 后代
      { pid: 200, ppid: 1 },
      { pid: 201, ppid: 200 }, // web listener = 后代
      { pid: 666, ppid: 665 }, // 外来
    ],
    portListeners: async (ports) => {
      calls.push(`listeners:${ports.join(",")}`)
      const m = new Map<number, number[]>()
      for (const p of ports) {
        if (p === 8801) m.set(p, [101])
        else if (p === 3101) m.set(p, [201])
        else m.set(p, [])
      }
      return m
    },
    killTree: async (pid) => {
      calls.push(`kill:${pid}`)
    },
    spawnProc: async (proc) => {
      spawnSeq += 1
      const pid = 9000 + spawnSeq
      calls.push(`spawn:${proc}:${pid}`)
      return { pid, creationDate: `spawned-${pid}`, logPath: path.join(base, "x.log") }
    },
    claimPorts: async (name) => {
      calls.push(`claim:${name}`)
      return { apiPort: 8802, webPort: 3102 }
    },
    ensureSqliteDataDir: async (root) => {
      calls.push(`ensureDataDir:${root}`)
      return { realDataDir: `${root}/.runtime/worktree-preview/data` }
    },
    mainDataPaths: ["C:/repo/data", "C:/repo/.runtime/db.sqlite"],
    waitPortReady: async (port) => {
      calls.push(`ready:${port}`)
      return true
    },
    waitPortFree: async (port) => {
      calls.push(`portFree:${port}`)
      return true
    },
    readLogTail: async (logPath, lines) => {
      calls.push(`tail:${logPath}:${lines}`)
      return logPath.includes("missing") ? [] : ["line1", "line2"]
    },
    now: () => "T",
  }

  Object.assign(deps, overrides)
  return {
    deps,
    calls,
    base,
    seedState: async (partial) => {
      await store.writeState({ ...fullState, ...partial } as PreviewState)
    },
  }
}

async function auditLines(base: string): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await fs.readFile(path.join(base, "audit.log"), "utf8")
    return raw.trim().split("\n").map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

// (1) compileBackend happy：预检→杀 api→spawn→ready→ok；web deps 零调用
test("F028 T4 · compileBackend targets api only, web untouched", async () => {
  const h = await makeHarness()
  await h.seedState()
  const orch = createPreviewOrchestrator(h.deps)
  const res = await orch.compileBackend("F028")
  assert.equal(res.ok, true)
  assert.ok(h.calls.includes("kill:100"))
  assert.ok(h.calls.some((c) => c.startsWith("spawn:api")))
  assert.ok(!h.calls.includes("kill:200"), "web 进程必须不被杀")
  assert.ok(!h.calls.some((c) => c.startsWith("spawn:web")), "web 必须不被 spawn")
  const audits = await auditLines(h.base)
  assert.equal(audits.length, 1) // (13) 恰一次
  assert.equal(audits[0].ok, true)
})

// (2) listener 非后代 → occupied-foreign，kill 零调用
test("F028 T4 · compileBackend foreign listener → occupied-foreign, zero kill", async () => {
  const h = await makeHarness({
    portListeners: async (ports) => {
      const m = new Map<number, number[]>()
      for (const p of ports) m.set(p, p === 8801 ? [666] : [])
      return m
    },
  })
  await h.seedState()
  const orch = createPreviewOrchestrator(h.deps)
  const res = await orch.compileBackend("F028")
  assert.equal(res.ok, false)
  assert.ok(!res.ok && res.stage === "occupied-foreign")
  assert.ok(!h.calls.some((c) => c.startsWith("kill:")), "kill 必须零调用")
})

// (3) CreationDate 差 1ms → occupied-foreign（精确比较回归锚）
test("F028 T4 · compileBackend CreationDate off-by-1ms → occupied-foreign, zero kill", async () => {
  const h = await makeHarness({
    probeCreationDate: async (pid) => (pid === 100 ? "1700000000101" : null), // 差 1
  })
  await h.seedState()
  const orch = createPreviewOrchestrator(h.deps)
  const res = await orch.compileBackend("F028")
  assert.ok(!res.ok && res.stage === "occupied-foreign")
  assert.ok(!h.calls.some((c) => c.startsWith("kill:")))
})

// (4) restartAll：双进程全量预检完成后才首杀（顺序断言）
test("F028 T4 · restartAll prechecks both before first kill", async () => {
  const h = await makeHarness()
  await h.seedState()
  const orch = createPreviewOrchestrator(h.deps)
  const res = await orch.restartAll("F028")
  assert.equal(res.ok, true)
  const firstKill = h.calls.findIndex((c) => c.startsWith("kill:"))
  const probe100 = h.calls.indexOf("probeCreation:100")
  const probe200 = h.calls.indexOf("probeCreation:200")
  assert.ok(firstKill > -1 && probe100 > -1 && probe200 > -1)
  assert.ok(probe100 < firstKill && probe200 < firstKill, "双预检必须全部先于首杀")
  assert.ok(h.calls.includes("kill:100") && h.calls.includes("kill:200"))
})

// (5) restartAll web 预检失败 → api 也不杀
test("F028 T4 · restartAll web precheck fail → api not killed either", async () => {
  const h = await makeHarness({
    probeCreationDate: async (pid) => (pid === 100 ? API_REC.creationDate : null), // web 失配
  })
  await h.seedState()
  const orch = createPreviewOrchestrator(h.deps)
  const res = await orch.restartAll("F028")
  assert.equal(res.ok, false)
  assert.ok(!h.calls.some((c) => c.startsWith("kill:")), "半杀禁止")
})

// (6) start 已 running → already-running spawn 零调用；端口被外占 → occupied-foreign spawn 零调用
test("F028 T4 · start when already running ui → refuses without spawn", async () => {
  const h = await makeHarness()
  await h.seedState()
  const orch = createPreviewOrchestrator(h.deps)
  const res = await orch.start("F028")
  assert.equal(res.ok, false)
  assert.ok(!res.ok && /already/i.test(res.message))
  assert.ok(!h.calls.some((c) => c.startsWith("spawn:")))
})

test("F028 T4 · start with foreign listener on claimed port → occupied-foreign, zero spawn", async () => {
  const h = await makeHarness({
    inventory: async () => [
      MAIN,
      { ...WT, preview: { apiPort: 8801, webPort: 3101, apiAlive: true, webAlive: false, ownership: "foreign" as const } },
    ],
    portListeners: async (ports) => {
      const m = new Map<number, number[]>()
      for (const p of ports) m.set(p, p === 8801 ? [666] : [])
      return m
    },
  })
  const orch = createPreviewOrchestrator(h.deps)
  const res = await orch.start("F028")
  assert.ok(!res.ok && res.stage === "occupied-foreign")
  assert.ok(!h.calls.some((c) => c.startsWith("spawn:")))
})

// (7) start 无 registry 条目 → claim worker 分配端口 → spawn → ok
test("F028 T4 · start without registry entry claims ports then spawns", async () => {
  const h = await makeHarness({
    inventory: async () => [MAIN, { ...WT, preview: null }],
    portListeners: async (ports) => new Map(ports.map((p) => [p, []])),
  })
  const orch = createPreviewOrchestrator(h.deps)
  const res = await orch.start("F028")
  assert.equal(res.ok, true)
  assert.ok(h.calls.includes("claim:F028"))
  assert.ok(h.calls.some((c) => c.startsWith("spawn:api")) && h.calls.some((c) => c.startsWith("spawn:web")))
  if (res.ok) {
    assert.equal(res.apiPort, 8802)
    assert.equal(res.webPort, 3102)
  }
})

// (8) start 安全目录创建：ensureSqliteDataDir 在 spawn 前；junction 抛 → 拒 spawn + 审计
test("F028 T4 · start runs ensureSqliteDataDir before spawn; junction throw → no spawn + audit", async () => {
  const h = await makeHarness({
    inventory: async () => [MAIN, { ...WT, preview: null }],
    portListeners: async (ports) => new Map(ports.map((p) => [p, []])),
    ensureSqliteDataDir: async () => {
      throw new Error(".runtime is a junction — refusing")
    },
  })
  const orch = createPreviewOrchestrator(h.deps)
  const res = await orch.start("F028")
  assert.ok(!res.ok && res.stage === "spawn")
  assert.ok(!h.calls.some((c) => c.startsWith("spawn:")), "junction 拒后零 spawn")
  const audits = await auditLines(h.base)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].ok, false)
})

test("F028 T4 · start orders ensureSqliteDataDir before any spawn on happy path", async () => {
  const h = await makeHarness({
    inventory: async () => [MAIN, { ...WT, preview: null }],
    portListeners: async (ports) => new Map(ports.map((p) => [p, []])),
  })
  const orch = createPreviewOrchestrator(h.deps)
  const res = await orch.start("F028")
  assert.equal(res.ok, true)
  const ensureIdx = h.calls.findIndex((c) => c.startsWith("ensureDataDir:"))
  const spawnIdx = h.calls.findIndex((c) => c.startsWith("spawn:"))
  assert.ok(ensureIdx > -1 && spawnIdx > -1 && ensureIdx < spawnIdx)
})

// (9) ready-timeout → 回收已 spawn 子进程 + 状态回滚
test("F028 T4 · compileBackend ready-timeout reclaims spawned child and rolls back state", async () => {
  const h = await makeHarness({ waitPortReady: async () => false })
  await h.seedState()
  const orch = createPreviewOrchestrator(h.deps)
  const res = await orch.compileBackend("F028")
  assert.ok(!res.ok && res.stage === "ready-timeout")
  const spawnedKill = h.calls.filter((c) => c.startsWith("kill:90")) // 9001+
  assert.equal(spawnedKill.length, 1, "超时必须回收新 spawn 的 api 子进程")
  const state = await h.deps.store.readState("F028")
  assert.equal(state?.processes.api, null, "状态文件 api 记录回滚为 null")
})

// (10) spawn 抛 → stage spawn，状态不留半截
test("F028 T4 · compileBackend spawn throw → stage spawn, state api null", async () => {
  const h = await makeHarness({
    spawnProc: async () => {
      throw new Error("spawn failed")
    },
  })
  await h.seedState()
  const orch = createPreviewOrchestrator(h.deps)
  const res = await orch.compileBackend("F028")
  assert.ok(!res.ok && res.stage === "spawn")
  const state = await h.deps.store.readState("F028")
  assert.equal(state?.processes.api, null)
})

// (11) AC6：8787 端口构造 → kill 前断言抛，审计 ok:false
test("F028 T4 · main-port construction rejected before any kill, audited", async () => {
  const h = await makeHarness({
    inventory: async () => [
      MAIN,
      { ...WT, preview: { apiPort: 8787, webPort: 3101, apiAlive: true, webAlive: true, ownership: "ui" as const } },
    ],
  })
  await h.seedState({ apiPort: 8787 })
  const orch = createPreviewOrchestrator(h.deps)
  const res = await orch.compileBackend("F028")
  assert.equal(res.ok, false)
  assert.ok(!h.calls.some((c) => c.startsWith("kill:")), "主库端口绝不进入 kill")
  const audits = await auditLines(h.base)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].ok, false)
})

// (12) AC10：同名并发第二发 in-progress；异名并行互不挡
test("F028 T4 · same-name concurrency 409s, different names run in parallel", async () => {
  let release!: () => void
  const blocker = new Promise<void>((r) => {
    release = r
  })
  const h = await makeHarness({
    inventory: async () => [
      MAIN,
      { ...WT, preview: { apiPort: 8801, webPort: 3101, apiAlive: true, webAlive: true, ownership: "ui" as const } },
      { ...WT, name: "F029", path: "C:/repo/.worktrees/F029", preview: null },
    ],
    waitPortReady: async (port) => {
      if (port === 8801) await blocker // 只卡 F028 的 api 端口制造并发窗口；F029 端口即时就绪
      return true
    },
    portListeners: async (ports) => {
      const m = new Map<number, number[]>()
      for (const p of ports) m.set(p, p === 8801 ? [101] : [])
      return m
    },
  })
  await h.seedState()
  const orch = createPreviewOrchestrator(h.deps)
  const first = orch.compileBackend("F028")
  await new Promise((r) => setTimeout(r, 20)) // 让第一发拿到锁
  const second = await orch.compileBackend("F028")
  assert.ok(!second.ok && second.stage === "in-progress")
  const other = await orch.start("F029") // 异名不被挡（claim+spawn 路径）
  assert.equal(other.ok, true)
  release()
  const firstRes = await first
  assert.equal(firstRes.ok, true)
})

// 德彪 r1 P1-3a：killTree 抛错（access denied 等真失败）→ stage:"kill"，不得继续 spawn
test("F028 r1-P1-3 · compileBackend: killTree failure → stage kill, no spawn", async () => {
  const h = await makeHarness({
    killTree: async () => {
      throw new Error("Access is denied.")
    },
  })
  await h.seedState()
  const orch = createPreviewOrchestrator(h.deps)
  const res = await orch.compileBackend("F028")
  assert.ok(!res.ok && res.stage === "kill")
  assert.ok(!h.calls.some((c) => c.startsWith("spawn:")), "kill 失败后必须不 spawn")
})

// 德彪 r1 P1-3b：杀后端口复探（plan 风险表："taskkill /T 树杀 + 杀后端口复探确认空"）——
// 端口迟迟不空 → stage:"kill"，不得 spawn（否则旧 listener 让 ready 立即真、UI 假报成功）
test("F028 r1-P1-3 · compileBackend: port still occupied after kill → stage kill, no spawn", async () => {
  const h = await makeHarness({
    waitPortFree: async () => false,
  })
  await h.seedState()
  const orch = createPreviewOrchestrator(h.deps)
  const res = await orch.compileBackend("F028")
  assert.ok(!res.ok && res.stage === "kill")
  assert.ok(h.calls.includes("kill:100"), "杀已执行")
  assert.ok(!h.calls.some((c) => c.startsWith("spawn:")), "端口未清不得 spawn")
})

// 德彪 r1 P1-3c：restartAll 双杀后两端口都复探；任一不空 → stage kill 且零 spawn
test("F028 r1-P1-3 · restartAll: web port not freed after kill → stage kill, no spawn", async () => {
  const h = await makeHarness({
    waitPortFree: async (port) => port !== 3101, // api 清空、web 未清
  })
  await h.seedState()
  const orch = createPreviewOrchestrator(h.deps)
  const res = await orch.restartAll("F028")
  assert.ok(!res.ok && res.stage === "kill")
  assert.ok(!h.calls.some((c) => c.startsWith("spawn:")), "任一端口未清不得 spawn")
})

// (14) tailLog：尾 N 行 / 不存在 [] / slug 路径无嵌套
test("F028 T4 · tailLog uses worktreeId slug paths and tolerates missing file", async () => {
  const h = await makeHarness()
  const orch = createPreviewOrchestrator(h.deps)
  const res = await orch.tailLog("feat/F028-x", "api", 50)
  const expectedId = slugifyWorktreeId("feat/F028-x")
  assert.ok(res.logPath.includes(`${expectedId}-api.log`))
  assert.ok(!res.logPath.includes("feat/"), "slug 路径不得含原始 / 名")
  assert.deepEqual(res.lines, ["line1", "line2"])

  const h2 = await makeHarness({ readLogTail: async () => [] })
  const orch2 = createPreviewOrchestrator(h2.deps)
  const miss = await orch2.tailLog("ghost", "web", 10)
  assert.deepEqual(miss.lines, [])
})
