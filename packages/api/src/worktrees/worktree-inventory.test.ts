import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildInventory,
  computeMergeStatus,
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
    baseRef: "dev",
    execGitAt: async () => {
      throw new Error("execGitAt not stubbed")
    },
    ...overrides,
  }
}

/** is-ancestor 非祖先用退出码 1 抛出（git 真实行为）；坏 ref 用 128 */
function gitExit(code: number): Error {
  return Object.assign(new Error(`git exit ${code}`), { code })
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

// 合入后真机 bug（小孙 2026-06-13 实测）：F024 CLI `pnpm worktree:preview` 用
// **全分支名** claim registry（worktreeName="feat/F030-..."），但 inventory 只按
// row.name（短名 "F030"）匹配 → 全 CLI 起的 preview 误判 null（未运行）。
// 修复：registry key 匹配 row.name **或** row.branch（全分支名），任一命中即认。
// （德彪 r1 披露 5 只验了"不误吸附"，漏了"该匹配的全分支名 key 没匹配上"反面）
test("F028 bugfix · registry keyed by full branch name matches (F024 CLI claim)", async () => {
  const deps = makeDeps({
    execGitWorktreeList: async () =>
      [
        "worktree C:/repo",
        "HEAD aaaa111122223333aaaa111122223333aaaa1111",
        "branch refs/heads/dev",
        "",
        "worktree C:/repo/.worktrees/F030",
        "HEAD ffff111122223333ffff111122223333ffff1111",
        "branch refs/heads/feat/F030-rich-blocks-readonly-cards",
        "",
      ].join("\n"),
    readRegistry: async () => [
      { worktreeName: "feat/F030-rich-blocks-readonly-cards", apiPort: 8803, webPort: 3103 },
    ],
    probePort: async () => true,
    readState: async () => null,
  })
  const inv = await buildInventory(deps)
  const f030 = inv.find((r) => r.name === "F030")
  assert.ok(f030?.preview, "F030 应匹配全分支名 registry key，preview 不为 null")
  assert.equal(f030.preview.apiPort, 8803)
  assert.equal(f030.preview.webPort, 3103)
  assert.equal(f030.preview.apiAlive, true)
})

// 防回归：短名 key 仍匹配（F028 自己用短名 claim）
test("F028 bugfix · short-name registry key still matches", async () => {
  const deps = makeDeps({
    readRegistry: async () => [{ worktreeName: "F028", apiPort: 8801, webPort: 3101 }],
    probePort: async () => true,
    readState: async () => null,
  })
  const inv = await buildInventory(deps)
  assert.ok(inv.find((r) => r.name === "F028")?.preview, "短名 key 匹配不能被破坏")
})

// ── 续作 AC11 · 合并状态（computeMergeStatus 纯函数）────────────────────────

// rev-list --left-right --count：左=behind 右=ahead
test("F028 AC11 · computeMergeStatus parses left=behind right=ahead", async () => {
  const ms = await computeMergeStatus(async (args) => {
    if (args[0] === "rev-list") return "3\t5\n"
    return "" // is-ancestor exit 0
  }, "dev")
  assert.equal(ms.behind, 3)
  assert.equal(ms.ahead, 5)
  assert.equal(ms.mergedHint, true)
})

// is-ancestor 退出码 1（非祖先）→ mergedHint false；坏 ref(128) → null
test("F028 AC11 · is-ancestor exit 1 → false; exit 128 → null", async () => {
  const notMerged = await computeMergeStatus(async (args) => {
    if (args[0] === "rev-list") return "0\t2"
    throw gitExit(1)
  }, "dev")
  assert.equal(notMerged.mergedHint, false)
  assert.equal(notMerged.ahead, 2)

  const badRef = await computeMergeStatus(async (args) => {
    if (args[0] === "rev-list") throw gitExit(128)
    throw gitExit(128)
  }, "nonexistent")
  assert.equal(badRef.mergedHint, null, "坏 ref 不能谎报未合并")
  assert.equal(badRef.ahead, null)
  assert.equal(badRef.behind, null)
})

// 每信号独立：rev-list 挂但 is-ancestor 成功 → ahead/behind null 但 mergedHint 仍 true
test("F028 AC11 · per-signal try/catch: rev-list fails, is-ancestor ok", async () => {
  const ms = await computeMergeStatus(async (args) => {
    if (args[0] === "rev-list") throw gitExit(128)
    return ""
  }, "dev")
  assert.equal(ms.ahead, null)
  assert.equal(ms.behind, null)
  assert.equal(ms.mergedHint, true)
})

// computeMergeStatus 永不抛（即使 execGit 同步爆）
test("F028 AC11 · computeMergeStatus never throws", async () => {
  const ms = await computeMergeStatus(async () => {
    throw new Error("boom no code")
  }, "dev")
  assert.deepEqual(ms, { ahead: null, behind: null, mergedHint: null })
})

// ── 续作 AC11 · buildInventory 接线 ────────────────────────────────────────

// 主仓行 mergeStatus=null；非主行带 mergeStatus
test("F028 AC11 · main row mergeStatus null; non-main rows computed", async () => {
  const deps = makeDeps({
    execGitAt: async (cwd, args) => {
      assert.ok(cwd.includes("F02"), `execGitAt 只该对非主行调，cwd=${cwd}`)
      if (args[0] === "rev-list") return "0\t0"
      return "" // is-ancestor exit 0 = 已含
    },
  })
  const inv = await buildInventory(deps)
  const main = inv.find((r) => r.isMain)
  assert.equal(main?.mergeStatus, null, "主仓不算合并状态")
  const f027 = inv.find((r) => r.name === "F027")
  assert.deepEqual(f027?.mergeStatus, { ahead: 0, behind: 0, mergedHint: true })
})

// 一行 git 失败不连累整列表（其它行 + 列表完整）
test("F028 AC11 · one row's git failure does not break the list", async () => {
  const deps = makeDeps({
    execGitAt: async (cwd, args) => {
      if (cwd.includes("F027")) throw gitExit(128) // F027 整体爆
      if (args[0] === "rev-list") return "1\t4"
      return ""
    },
  })
  const inv = await buildInventory(deps)
  assert.equal(inv.length, 3, "列表仍 3 行")
  const f027 = inv.find((r) => r.name === "F027")
  assert.deepEqual(
    f027?.mergeStatus,
    { ahead: null, behind: null, mergedHint: null },
    "爆掉的行降级全 null，不抛、不丢行",
  )
  const f028 = inv.find((r) => r.name === "F028")
  assert.deepEqual(f028?.mergeStatus, { ahead: 4, behind: 1, mergedHint: true })
})
