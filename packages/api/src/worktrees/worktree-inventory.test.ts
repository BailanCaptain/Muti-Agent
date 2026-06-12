import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildInventory,
  parseWorktreePorcelain,
  type InventoryDeps,
} from "./worktree-inventory"

/**
 * F028 Task 1 · worktree 枚举器（plan v5 用例 1-6）
 * deps 全注入：execGit/readRegistry/probePort/readState/probeCreationDate 零真 IO。
 */

const PORCELAIN_3 = [
  "worktree C:/Users/-/Desktop/Multi-Agent",
  "HEAD aaaa111122223333aaaa111122223333aaaa1111",
  "branch refs/heads/dev",
  "",
  "worktree C:/Users/-/Desktop/Multi-Agent/.worktrees/F027",
  "HEAD bbbb111122223333bbbb111122223333bbbb1111",
  "branch refs/heads/feat/F027-unified-memory-architecture",
  "",
  "worktree C:/Users/-/Desktop/Multi-Agent/.worktrees/F028",
  "HEAD cccc111122223333cccc111122223333cccc1111",
  "branch refs/heads/feat/F028-workspace-explorer-tabs",
  "",
].join("\n")

const PORCELAIN_DETACHED = [
  "worktree C:/Users/-/Desktop/Multi-Agent",
  "HEAD aaaa111122223333aaaa111122223333aaaa1111",
  "branch refs/heads/dev",
  "",
  "worktree C:/Users/-/Desktop/Multi-Agent/.worktrees/exp",
  "HEAD dddd111122223333dddd111122223333dddd1111",
  "detached",
  "",
].join("\n")

function makeDeps(overrides: Partial<InventoryDeps> = {}): InventoryDeps {
  return {
    execGitWorktreeList: async () => PORCELAIN_3,
    readRegistry: async () => [],
    probePort: async () => false,
    readState: async () => null,
    probeCreationDate: async () => null,
    ...overrides,
  }
}

// (1) porcelain 3 worktree（含主仓）→ name/branch/head/path/isMain
test("F028 T1 · parseWorktreePorcelain extracts name/branch/head/path/isMain", () => {
  const rows = parseWorktreePorcelain(PORCELAIN_3)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], {
    name: "main",
    branch: "dev",
    head: "aaaa1111",
    path: "C:/Users/-/Desktop/Multi-Agent",
    isMain: true,
  })
  assert.equal(rows[1].name, "F027")
  assert.equal(rows[1].branch, "feat/F027-unified-memory-architecture")
  assert.equal(rows[1].isMain, false)
  assert.equal(rows[2].name, "F028")
  assert.equal(rows[2].head, "cccc1111")
})

// (6) detached HEAD 块 → branch:"(detached)" 不抛
test("F028 T1 · parseWorktreePorcelain handles detached HEAD as (detached)", () => {
  const rows = parseWorktreePorcelain(PORCELAIN_DETACHED)
  assert.equal(rows.length, 2)
  assert.equal(rows[1].branch, "(detached)")
  assert.equal(rows[1].name, "exp")
})

// (5) registry 无条目 → preview:null
test("F028 T1 · no registry entry → preview null", async () => {
  const inv = await buildInventory(makeDeps())
  assert.equal(inv.length, 3)
  for (const row of inv) assert.equal(row.preview, null)
})

// (2) registry 有条目 + 双端口活 + 状态文件 pid+CreationDate 实测匹配 → ownership:"ui"
test("F028 T1 · alive ports + state pid/CreationDate match → ownership ui", async () => {
  const deps = makeDeps({
    readRegistry: async () => [{ worktreeName: "F028", apiPort: 8801, webPort: 3101 }],
    probePort: async (port) => port === 8801 || port === 3101,
    readState: async (name) =>
      name === "F028"
        ? {
            worktreeName: "F028",
            worktreeId: "F028-deadbeef",
            apiPort: 8801,
            webPort: 3101,
            processes: {
              api: { pid: 100, creationDate: "1781117591629", startedAt: "x" },
              web: { pid: 200, creationDate: "1781117591999", startedAt: "x" },
            },
          }
        : null,
    probeCreationDate: async (pid) =>
      pid === 100 ? "1781117591629" : pid === 200 ? "1781117591999" : null,
  })
  const inv = await buildInventory(deps)
  const f028 = inv.find((r) => r.name === "F028")
  assert.ok(f028?.preview)
  assert.equal(f028.preview.apiAlive, true)
  assert.equal(f028.preview.webAlive, true)
  assert.equal(f028.preview.ownership, "ui")
})

// (3) 端口活但无状态文件（或 CreationDate 失配）→ ownership:"foreign"
test("F028 T1 · alive ports without state file → foreign", async () => {
  const deps = makeDeps({
    readRegistry: async () => [{ worktreeName: "F028", apiPort: 8801, webPort: 3101 }],
    probePort: async () => true,
    readState: async () => null,
  })
  const inv = await buildInventory(deps)
  assert.equal(inv.find((r) => r.name === "F028")?.preview?.ownership, "foreign")
})

test("F028 T1 · alive ports with CreationDate mismatch → foreign", async () => {
  const deps = makeDeps({
    readRegistry: async () => [{ worktreeName: "F028", apiPort: 8801, webPort: 3101 }],
    probePort: async () => true,
    readState: async () => ({
      worktreeName: "F028",
      worktreeId: "F028-deadbeef",
      apiPort: 8801,
      webPort: 3101,
      processes: {
        api: { pid: 100, creationDate: "1781117591629", startedAt: "x" },
        web: null,
      },
    }),
    probeCreationDate: async () => "9999999999999", // OS 实测与落盘不符
  })
  const inv = await buildInventory(deps)
  assert.equal(inv.find((r) => r.name === "F028")?.preview?.ownership, "foreign")
})

// 德彪 r1 P2-3：每个 alive 端口都必须有**自己的**匹配记录——web 活而 web 记录缺、
// api 记录匹配，旧逻辑判 ui（只验非空记录），实际 web listener 已脱管 → 必须 foreign
test("F028 r1-P2-3 · alive port without its own record → foreign", async () => {
  const deps = makeDeps({
    readRegistry: async () => [{ worktreeName: "F028", apiPort: 8801, webPort: 3101 }],
    probePort: async () => true, // 双端口都活
    readState: async () => ({
      worktreeName: "F028",
      worktreeId: "F028-deadbeef",
      apiPort: 8801,
      webPort: 3101,
      processes: { api: { pid: 100, creationDate: "1781117591629", startedAt: "x" }, web: null },
    }),
    probeCreationDate: async (pid) => (pid === 100 ? "1781117591629" : null),
  })
  const inv = await buildInventory(deps)
  assert.equal(inv.find((r) => r.name === "F028")?.preview?.ownership, "foreign")
})

// 对照（防修过头）：死端口不需要记录——api 活且匹配、web 死无记录 → 仍是 ui
// （compile-backend 之后 web 暂死的合法形态）
test("F028 r1-P2-3 · dead port needs no record; alive api matched → ui", async () => {
  const deps = makeDeps({
    readRegistry: async () => [{ worktreeName: "F028", apiPort: 8801, webPort: 3101 }],
    probePort: async (port) => port === 8801,
    readState: async () => ({
      worktreeName: "F028",
      worktreeId: "F028-deadbeef",
      apiPort: 8801,
      webPort: 3101,
      processes: { api: { pid: 100, creationDate: "1781117591629", startedAt: "x" }, web: null },
    }),
    probeCreationDate: async (pid) => (pid === 100 ? "1781117591629" : null),
  })
  const inv = await buildInventory(deps)
  assert.equal(inv.find((r) => r.name === "F028")?.preview?.ownership, "ui")
})

// (4) registry 有条目端口全死 → alive false/false, ownership:"none"
test("F028 T1 · registry entry with dead ports → none", async () => {
  const deps = makeDeps({
    readRegistry: async () => [{ worktreeName: "F027", apiPort: 8800, webPort: 3100 }],
    probePort: async () => false,
  })
  const inv = await buildInventory(deps)
  const f027 = inv.find((r) => r.name === "F027")
  assert.ok(f027?.preview)
  assert.equal(f027.preview.apiAlive, false)
  assert.equal(f027.preview.webAlive, false)
  assert.equal(f027.preview.ownership, "none")
})
