import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { slugifyWorktreeId } from "./preview-guards"
import { createPreviewStateStore, reconcileOnBoot } from "./preview-state"
import type { PreviewState } from "./preview-state-types"

/** F028 Task 3 · 状态文件 + 审计日志 + boot reconcile（plan v5 用例 1-3，tmpdir 真 fs） */

async function makeTmpBase(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "f028-state-"))
}

function makeState(name: string, apiPid = 100, webPid = 200): PreviewState {
  return {
    worktreeName: name,
    worktreeId: slugifyWorktreeId(name),
    apiPort: 8801,
    webPort: 3101,
    processes: {
      api: { pid: apiPid, creationDate: "1781117591629", startedAt: "2026-06-11T00:00:00Z" },
      web: { pid: webPid, creationDate: "1781117591999", startedAt: "2026-06-11T00:00:00Z" },
    },
  }
}

// (1) round-trip + slug 文件名 + 损坏 JSON 容错
test("F028 T3 · writeState/readState round-trip with slug filename (feat/x no nesting)", async () => {
  const base = await makeTmpBase()
  const store = createPreviewStateStore({ baseDir: base, now: () => "2026-06-11T00:00:00Z" })
  const state = makeState("feat/F028-x")
  await store.writeState(state)

  // slug 文件名：base 直下且不产生子目录
  const files = await fs.readdir(base)
  assert.equal(files.length, 1)
  assert.ok(!files[0].includes("feat" + path.sep))
  assert.ok(files[0].endsWith(".json"))
  assert.equal(files[0], `${slugifyWorktreeId("feat/F028-x")}.json`)

  const back = await store.readState("feat/F028-x")
  assert.deepEqual(back, state)

  // 不存在 → null
  assert.equal(await store.readState("ghost"), null)

  // 损坏 JSON → null 不抛
  await fs.writeFile(path.join(base, files[0]), "{broken", "utf8")
  assert.equal(await store.readState("feat/F028-x"), null)
})

// (2) appendAudit 追加一行 JSON
test("F028 T3 · appendAudit appends one JSON line with time/action/worktree/ok", async () => {
  const base = await makeTmpBase()
  const store = createPreviewStateStore({ baseDir: base, now: () => "2026-06-11T01:02:03Z" })
  await store.appendAudit({ action: "compile-backend", worktree: "F028", ok: true })
  await store.appendAudit({ action: "start", worktree: "F027", ok: false, stage: "spawn", message: "boom" })

  const raw = await fs.readFile(path.join(base, "audit.log"), "utf8")
  const lines = raw.trim().split("\n")
  assert.equal(lines.length, 2)
  const first = JSON.parse(lines[0])
  assert.equal(first.time, "2026-06-11T01:02:03Z")
  assert.equal(first.action, "compile-backend")
  assert.equal(first.worktree, "F028")
  assert.equal(first.ok, true)
  const second = JSON.parse(lines[1])
  assert.equal(second.stage, "spawn")
  assert.equal(second.message, "boom")
})

// (3) reconcileOnBoot：失配清记录、匹配原样、全程不杀
test("F028 T3 · reconcileOnBoot clears stale records, keeps matches, never kills", async () => {
  const base = await makeTmpBase()
  const store = createPreviewStateStore({ baseDir: base, now: () => "t" })
  await store.writeState(makeState("alive", 100, 200))   // 两进程实测匹配 → 原样
  await store.writeState(makeState("deadpid", 300, 400)) // pid 不存在 → 双清
  await store.writeState(makeState("reused", 500, 600))  // CreationDate 失配 → 双清

  let killCalls = 0
  await reconcileOnBoot({
    store,
    probeCreationDate: async (pid) => {
      if (pid === 100) return "1781117591629" // 匹配
      if (pid === 200) return "1781117591999" // 匹配
      if (pid === 500 || pid === 600) return "8888888888888" // PID 复用：值不同
      return null // 300/400 不存在
    },
    kill: async () => {
      killCalls += 1
    },
  })

  assert.equal(killCalls, 0) // 铁则：reconcile 只清记录绝不杀进程

  const alive = await store.readState("alive")
  assert.ok(alive?.processes.api && alive.processes.web) // 原样保留

  const dead = await store.readState("deadpid")
  assert.equal(dead?.processes.api, null)
  assert.equal(dead?.processes.web, null)

  const reused = await store.readState("reused")
  assert.equal(reused?.processes.api, null)
  assert.equal(reused?.processes.web, null)
})

// 续作 AC12 · deleteState：删状态文件，幂等（不存在不抛）
test("F028 AC12 · deleteState removes state file and is idempotent", async () => {
  const base = await makeTmpBase()
  const store = createPreviewStateStore({ baseDir: base, now: () => "T" })
  await store.writeState(makeState("F028"))
  assert.equal((await fs.readdir(base)).length, 1)
  await store.deleteState("F028")
  assert.equal((await fs.readdir(base)).length, 0, "状态文件应被删")
  // 再删一次（已不存在）→ 不抛
  await store.deleteState("F028")
  assert.equal(await store.readState("F028"), null)
})
