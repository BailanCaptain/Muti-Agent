/**
 * F027 P19.12 · MonthlySnapshot 测试 — AC-P2-14
 *
 * 覆盖：
 *   - computeDrift word-Jaccard：完全一致=0 / 完全不同=1 / 部分重叠
 *   - drift > 30% → replace；≤ 30% → 不 replace
 *   - backup 先于 replace；backup 失败 → fail-safe 跳过 replace
 *   - **幂等**：第一次 replace 后，第二次 recompile 返一致内容 → drift 0 → 不再 replace
 *   - Jan-1 边界：label = "2027-01"（年首月）
 *   - pushAudit 回调被调 + throw 不打断
 *   - replaceViewfinder throw → 落 replaceError，不打断其他 room
 *   - **100k mock pressure**：100k room 跑完不 OOM + 线性时间
 */

import assert from "node:assert/strict"
import test from "node:test"
import {
  MonthlySnapshot,
  type RoomSnapshot,
  type SnapshotReport,
  computeDrift,
} from "./monthly-snapshot"

// ── computeDrift ────────────────────────────────────────────────────────

test("MonthlySnapshot · computeDrift 完全一致 → 0", () => {
  assert.equal(computeDrift("the quick brown fox", "the quick brown fox"), 0)
})

test("MonthlySnapshot · computeDrift 完全不同 → 1", () => {
  assert.equal(computeDrift("alpha beta gamma", "delta epsilon zeta"), 1)
})

test("MonthlySnapshot · computeDrift 部分重叠 → 0..1 之间", () => {
  // A={a,b,c,d} B={c,d,e,f} 交2 并6 → sim 1/3 → drift 2/3
  const d = computeDrift("a b c d", "c d e f")
  assert.ok(Math.abs(d - 2 / 3) < 1e-9, `expected ~0.667, got ${d}`)
})

test("MonthlySnapshot · computeDrift 措辞微调不算大 drift（Jaccard 语义）", () => {
  const d = computeDrift(
    "room decided to use croner for scheduling",
    "room decided to use croner library for scheduling",
  )
  // 只多 1 词 → drift 很小
  assert.ok(d < 0.2, `措辞微调 drift 应小, got ${d}`)
})

test("MonthlySnapshot · computeDrift 两者皆空 → 0", () => {
  assert.equal(computeDrift("", ""), 0)
})

// ── drift > 30% replace 决策 ─────────────────────────────────────────────

test("MonthlySnapshot · AC-P2-14: drift > 30% → replace", async () => {
  const snapshots: RoomSnapshot[] = [
    {
      roomId: "R-drifted",
      currentViewfinder: "alpha beta gamma delta",
      recompiledViewfinder: "epsilon zeta eta theta", // 完全不同 → drift 1
    },
  ]
  const replaced: Array<{ roomId: string; content: string }> = []
  const snap = new MonthlySnapshot({
    recompileAllRooms: async () => snapshots,
    replaceViewfinder: async (roomId, content) => {
      replaced.push({ roomId, content })
    },
  })
  const report = await snap.run()
  assert.equal(report.roomsReplaced, 1)
  assert.equal(report.rooms[0].replaced, true)
  assert.ok(report.rooms[0].driftRatio > 0.3)
  assert.equal(replaced.length, 1)
  assert.equal(replaced[0].content, "epsilon zeta eta theta")
})

test("MonthlySnapshot · AC-P2-14: drift ≤ 30% → 不 replace", async () => {
  const snapshots: RoomSnapshot[] = [
    {
      roomId: "R-stable",
      currentViewfinder: "a b c d e f g h i j", // 10 词
      recompiledViewfinder: "a b c d e f g h i k", // 换 1 词 → drift 小
    },
  ]
  const replaced: string[] = []
  const snap = new MonthlySnapshot({
    recompileAllRooms: async () => snapshots,
    replaceViewfinder: async (roomId) => {
      replaced.push(roomId)
    },
  })
  const report = await snap.run()
  assert.equal(report.roomsReplaced, 0)
  assert.equal(report.rooms[0].replaced, false)
  assert.ok(report.rooms[0].driftRatio <= 0.3)
  assert.equal(replaced.length, 0)
})

// ── backup ───────────────────────────────────────────────────────────────

test("MonthlySnapshot · backup 先于 replace 执行", async () => {
  const order: string[] = []
  const snap = new MonthlySnapshot({
    recompileAllRooms: async () => {
      order.push("recompile")
      return [{ roomId: "R-1", currentViewfinder: "a b", recompiledViewfinder: "x y z" }]
    },
    backup: async (label) => {
      order.push("backup")
      return `backup://${label}`
    },
    replaceViewfinder: async () => {
      order.push("replace")
    },
  })
  const report = await snap.run()
  assert.equal(order[0], "backup", "backup 必须最先")
  assert.ok(order.indexOf("backup") < order.indexOf("replace"))
  assert.match(report.backupLocation ?? "", /^backup:\/\/monthly-snapshot-/)
})

test("MonthlySnapshot · backup 失败 → fail-safe 跳过 replace", async () => {
  const replaced: string[] = []
  const snap = new MonthlySnapshot({
    recompileAllRooms: async () => [
      { roomId: "R-1", currentViewfinder: "a b c", recompiledViewfinder: "x y z" },
    ],
    backup: async () => {
      throw new Error("disk full")
    },
    replaceViewfinder: async (roomId) => {
      replaced.push(roomId)
    },
  })
  const report = await snap.run()
  assert.equal(replaced.length, 0, "backup 失败时绝不 replace（无回滚兜底）")
  assert.equal(report.backupLocation, null)
  assert.equal(report.rooms[0].replaced, false)
  assert.match(report.rooms[0].replaceError ?? "", /backup failed/)
})

// ── 幂等 ─────────────────────────────────────────────────────────────────

test("MonthlySnapshot · AC-P2-14 幂等: 第二次 recompile 一致 → drift 0 不再 replace", async () => {
  let viewfinder = "alpha beta gamma"
  const recompiled = "delta epsilon zeta" // 第一次完全不同

  const snap = new MonthlySnapshot({
    recompileAllRooms: async () => [
      {
        roomId: "R-1",
        currentViewfinder: viewfinder,
        recompiledViewfinder: recompiled,
      },
    ],
    replaceViewfinder: async (_roomId, content) => {
      viewfinder = content // replace 后 current 更新
    },
  })

  // 第一次：drift 1 → replace
  const r1 = await snap.run()
  assert.equal(r1.roomsReplaced, 1)
  assert.equal(viewfinder, "delta epsilon zeta")

  // 第二次：current 已 = recompiled → drift 0 → 不 replace
  const r2 = await snap.run()
  assert.equal(r2.roomsReplaced, 0, "幂等：第二次无 drift 不再 replace")
  assert.equal(r2.rooms[0].driftRatio, 0)
})

// ── Jan-1 边界 ───────────────────────────────────────────────────────────

test("MonthlySnapshot · Jan-1 边界: label = 年首月 2027-01", async () => {
  const snap = new MonthlySnapshot({
    recompileAllRooms: async () => [],
    clock: () => new Date("2027-01-01T03:00:00.000Z"),
  })
  const report = await snap.run()
  assert.equal(report.label, "2027-01")
})

test("MonthlySnapshot · label 普通月份 2026-06", async () => {
  const snap = new MonthlySnapshot({
    recompileAllRooms: async () => [],
    clock: () => new Date("2026-06-01T03:00:00.000Z"),
  })
  const report = await snap.run()
  assert.equal(report.label, "2026-06")
})

// ── pushAudit + replace 错误处理 ────────────────────────────────────────

test("MonthlySnapshot · pushAudit 回调被调 + throw 不打断", async () => {
  const audits: SnapshotReport[] = []
  const snap = new MonthlySnapshot({
    recompileAllRooms: async () => [
      { roomId: "R-1", currentViewfinder: "a", recompiledViewfinder: "b" },
    ],
    pushAudit: async (r) => {
      audits.push(r)
      throw new Error("R-201 unreachable")
    },
  })
  const report = await snap.run()
  assert.ok(report)
  assert.equal(audits.length, 1)
})

test("MonthlySnapshot · replaceViewfinder throw → 落 replaceError，不打断其他 room", async () => {
  const snap = new MonthlySnapshot({
    recompileAllRooms: async () => [
      { roomId: "R-ok", currentViewfinder: "a b", recompiledViewfinder: "x y z w" },
      { roomId: "R-fail", currentViewfinder: "a b", recompiledViewfinder: "x y z w" },
    ],
    replaceViewfinder: async (roomId) => {
      if (roomId === "R-fail") throw new Error("write conflict")
    },
  })
  const report = await snap.run()
  assert.equal(report.roomsReplaced, 1, "R-ok 成功")
  assert.equal(report.roomsReplaceFailed, 1, "R-fail 失败")
  const failRoom = report.rooms.find((r) => r.roomId === "R-fail")
  assert.match(failRoom?.replaceError ?? "", /write conflict/)
})

test("MonthlySnapshot · dry-run（无 replaceViewfinder）→ 记 drift 不 replace", async () => {
  const snap = new MonthlySnapshot({
    recompileAllRooms: async () => [
      { roomId: "R-1", currentViewfinder: "a b c", recompiledViewfinder: "x y z" },
    ],
  })
  const report = await snap.run()
  assert.equal(report.roomsReplaced, 0)
  assert.ok(report.rooms[0].driftRatio > 0.3, "drift 仍计算")
})

// ── 100k mock pressure ──────────────────────────────────────────────────

test("MonthlySnapshot · AC-P2-14: 100k room mock pressure — 跑完不 OOM + 线性", async () => {
  const N = 100_000
  const snap = new MonthlySnapshot({
    recompileAllRooms: async () => {
      const rooms: RoomSnapshot[] = []
      for (let i = 0; i < N; i++) {
        // 一半 drift 大（replace），一半稳定
        const drifted = i % 2 === 0
        rooms.push({
          roomId: `R-${i}`,
          currentViewfinder: `room ${i} alpha beta`,
          recompiledViewfinder: drifted
            ? `room ${i} totally different content xyz`
            : `room ${i} alpha beta`,
        })
      }
      return rooms
    },
    replaceViewfinder: async () => {
      // no-op stub
    },
  })
  const start = Date.now()
  const report = await snap.run()
  const elapsedMs = Date.now() - start

  assert.equal(report.totalRooms, N)
  assert.equal(report.roomsReplaced, N / 2, "一半 room drift 大 → replace")
  // 线性时间 sanity：100k room 应在合理时间内（宽松 30s 上限，防 O(n²)）
  assert.ok(elapsedMs < 30_000, `100k room 应线性时间完成, 实际 ${elapsedMs}ms`)
})
