import assert from "node:assert/strict"
import { test } from "node:test"

import {
  NotOwnedError,
  PreviewGuardError,
  assertAllowedOrigin,
  assertListenerDescendant,
  assertOperableWorktree,
  assertOwnedProcess,
  assertPathNoAds,
  assertSqlitePathContained,
  assertWorktreePort,
  resolveControlPlaneOrigins,
  slugifyWorktreeId,
} from "./preview-guards"

/** F028 Task 2 · 安全边界原语（plan v5 九组用例） */

// (1) assertWorktreePort
test("F028 T2 · assertWorktreePort allows worktree bases, rejects main/system ports", () => {
  for (const ok of [8800, 8801, 3100, 3101]) assert.doesNotThrow(() => assertWorktreePort(ok))
  for (const bad of [8787, 3000, 80, 0, -1]) {
    assert.throws(() => assertWorktreePort(bad), PreviewGuardError)
  }
})

// (2) assertOperableWorktree
test("F028 T2 · assertOperableWorktree rejects main and unknown names", () => {
  const inventory = [
    { name: "main", isMain: true },
    { name: "F028", isMain: false },
  ]
  assert.throws(() => assertOperableWorktree("main", inventory), PreviewGuardError)
  assert.throws(() => assertOperableWorktree("../x", inventory), PreviewGuardError)
  assert.throws(() => assertOperableWorktree("ghost", inventory), PreviewGuardError)
  assert.equal(assertOperableWorktree("F028", inventory).name, "F028")
})

// (3) assertOwnedProcess — 精确相等，无容差
test("F028 T2 · assertOwnedProcess requires exact CreationDate equality", () => {
  const rec = { pid: 100, creationDate: "1781117591629", startedAt: "x" }
  assert.doesNotThrow(() => assertOwnedProcess(rec, "1781117591629"))
  assert.throws(() => assertOwnedProcess(rec, "1781117591630"), NotOwnedError) // 1ms 差
  assert.throws(() => assertOwnedProcess(rec, null), NotOwnedError)
  assert.throws(() => assertOwnedProcess(null, "1781117591629"), NotOwnedError)
})

// (4) resolveControlPlaneOrigins — 三种 CORS 形态
test("F028 T2 · resolveControlPlaneOrigins under default RegExp keeps exact whitelist only", () => {
  const origins = resolveControlPlaneOrigins(/^http:\/\/localhost:\d+$/, [3101, 3102])
  assert.ok(origins.has("http://localhost:3000")) // 主 UI 固定来源
  assert.ok(origins.has("http://localhost:3101"))
  assert.ok(origins.has("http://localhost:3102"))
  assert.ok(!origins.has("http://localhost:8800")) // RegExp 不可枚举，绝不因它放行 API 端口
})

test("F028 T2 · resolveControlPlaneOrigins keeps string and array string forms, ignores RegExp members", () => {
  const fromString = resolveControlPlaneOrigins("http://localhost:5173", [])
  assert.ok(fromString.has("http://localhost:5173"))
  assert.ok(fromString.has("http://localhost:3000"))

  const fromArray = resolveControlPlaneOrigins(
    ["http://localhost:5174", /^http:\/\/localhost:\d+$/],
    [3101],
  )
  assert.ok(fromArray.has("http://localhost:5174"))
  assert.ok(fromArray.has("http://localhost:3101"))
  assert.ok(!fromArray.has("http://localhost:8800"))
})

// (5) assertAllowedOrigin
test("F028 T2 · assertAllowedOrigin: absent passes, whitelist passes, api-self and foreign throw", () => {
  const allowed = new Set(["http://localhost:3000", "http://localhost:3101"])
  assert.doesNotThrow(() => assertAllowedOrigin(undefined, allowed))
  assert.doesNotThrow(() => assertAllowedOrigin("http://localhost:3000", allowed))
  assert.doesNotThrow(() => assertAllowedOrigin("http://localhost:3101", allowed))
  assert.throws(() => assertAllowedOrigin("http://localhost:8800", allowed), PreviewGuardError)
  assert.throws(() => assertAllowedOrigin("http://evil.com", allowed), PreviewGuardError)
})

// (6) assertListenerDescendant
test("F028 T2 · assertListenerDescendant walks ppid chain with cycle defense", () => {
  const table = [
    { pid: 10, ppid: 1 },
    { pid: 20, ppid: 10 },
    { pid: 30, ppid: 20 },
    { pid: 99, ppid: 98 }, // 无关链
  ]
  assert.doesNotThrow(() => assertListenerDescendant(table, 30, 10)) // 30→20→10 可达
  assert.doesNotThrow(() => assertListenerDescendant(table, 10, 10)) // 自身
  assert.throws(() => assertListenerDescendant(table, 99, 10), PreviewGuardError) // 不可达
  assert.throws(() => assertListenerDescendant(table, 777, 10), PreviewGuardError) // 表中无 listener
  const cyclic = [
    { pid: 5, ppid: 6 },
    { pid: 6, ppid: 5 },
  ]
  assert.throws(() => assertListenerDescendant(cyclic, 5, 1), PreviewGuardError) // 环
})

// (7) slugifyWorktreeId
test("F028 T2 · slugifyWorktreeId is fs-safe, collision-proof, length-capped", () => {
  const a = slugifyWorktreeId("feat/F028")
  assert.ok(!a.includes("/"))
  assert.match(a, /-[0-9a-f]{8}$/)

  // 三方互不碰撞（sanitize 同形，哈希区分）
  const ids = new Set([
    slugifyWorktreeId("feat/a-b"),
    slugifyWorktreeId("feat-a/b"),
    slugifyWorktreeId("feat-a-b"),
  ])
  assert.equal(ids.size, 3)

  // 超长名：总长 ≤40（前缀 ≤31 + "-" + 8）
  const long = slugifyWorktreeId("x".repeat(120))
  assert.ok(long.length <= 40, `len=${long.length}`)

  // 纯 Unicode：sanitize 后空 → "wt" 兜底
  const uni = slugifyWorktreeId("特性分支")
  assert.match(uni, /^wt-/)

  // 仅安全字符集
  assert.match(a, /^[A-Za-z0-9._-]+$/)
})

// (8) assertSqlitePathContained — 验父目录；DB 文件不存在也过（纯路径逻辑）
test("F028 T2 · assertSqlitePathContained validates parent dir containment", () => {
  const wt = "C:/repo/.worktrees/F028"
  const mains = ["C:/repo/data", "C:/repo/.runtime/db.sqlite"]
  const good = `${wt}/.runtime/worktree-preview/data/multi-agent.sqlite`
  assert.doesNotThrow(() => assertSqlitePathContained(good, wt, mains)) // 文件可不存在
  assert.throws(
    () => assertSqlitePathContained("C:/repo/data/multi-agent.sqlite", wt, mains),
    PreviewGuardError,
  )
  assert.throws(() => assertSqlitePathContained("C:/repo/.runtime/db.sqlite", wt, mains), PreviewGuardError)
  assert.throws(
    () =>
      assertSqlitePathContained(
        `${wt}/.runtime/worktree-preview/data/../../../../data/x.sqlite`,
        wt,
        mains,
      ),
    PreviewGuardError,
  )
})

// (9) assertPathNoAds
test("F028 T2 · assertPathNoAds rejects NTFS alternate data streams", () => {
  assert.doesNotThrow(() => assertPathNoAds("packages/api/src/config.ts"))
  assert.throws(() => assertPathNoAds("file.ts:hidden"), PreviewGuardError)
  assert.throws(() => assertPathNoAds("a/b:stream:$DATA"), PreviewGuardError)
})
