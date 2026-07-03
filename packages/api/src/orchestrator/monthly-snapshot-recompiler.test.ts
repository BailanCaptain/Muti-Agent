/**
 * F027 修2 (C1.5) · monthly-snapshot-recompiler 测试
 *
 * 覆盖面：
 *   1. selectSnapshotRooms 纯函数（活跃过滤 / cap / 滚动排序 / 确定性）
 *   2. createProbeDecisionLedger（overlay 合并视图 + fencing sweep + 默认拒绝）
 *   3. recompileAllRooms 集成（临时 SQLite + tmp wikiRoot + stub judge）：
 *      probe 零副作用（room_decisions 空 / viewfinder 文件不动）+ 滚动 state
 *   4. createSnapshotBackup（全量拷贝 / label 净化）
 *   5. createSnapshotViewfinderReplacer（三阶段留痕 / write 失败 abort / roomId 白名单）
 *   6. MonthlySnapshot 壳端到端（drift 超阈值 → backup + replace + report）
 */

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"

import { createDrizzleDb } from "../db/drizzle-instance"
import type * as schema from "../db/schema"
import { MonthlySnapshot } from "../services/scheduler/monthly-snapshot"
import { DecisionLedger } from "../wiki/viewfinder/decision-ledger"
import type { DecisionJudgeProvider } from "../wiki/viewfinder/types"
import {
  createMonthlySnapshotRecompiler,
  createProbeDecisionLedger,
  createSnapshotBackup,
  createSnapshotViewfinderReplacer,
  selectSnapshotRooms,
} from "./monthly-snapshot-recompiler"

// ── fixtures ────────────────────────────────────────────────────────────

const NOW = new Date("2026-07-03T04:00:00Z")
const NOW_MS = NOW.getTime()

function makeEnv() {
  const dir = mkdtempSync(path.join(tmpdir(), "monthly-snapshot-test-"))
  const { raw, close } = createDrizzleDb(path.join(dir, "test.sqlite"))
  const wikiRoot = path.join(dir, "wiki")
  return {
    dir,
    db: raw,
    // recompiler 参数位类型是 DrizzleDb；raw client 走 adaptDrizzleDb 最后一级 fallback
    // （对象自身就有 prepare/all/get），与 compile-fn.test.ts 同款用法
    dbForRecompiler: raw as unknown as BetterSQLite3Database<typeof schema>,
    wikiRoot,
    statePath: path.join(dir, "state.json"),
    cleanup: () => {
      close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** seed 一个 room：session_group + thread + N 条消息（含 message_commit_seq）。 */
function seedRoom(
  db: ReturnType<typeof makeEnv>["db"],
  opts: { roomId: string; messageAt: string; messages?: string[] },
): void {
  const sgId = `sg-${opts.roomId}`
  const threadId = `t-${opts.roomId}`
  db.prepare(
    "INSERT INTO session_groups (id, title, created_at, updated_at, room_id) VALUES (?, ?, ?, ?, ?)",
  ).run(sgId, `${opts.roomId} 测试房`, opts.messageAt, opts.messageAt, opts.roomId)
  db.prepare(
    "INSERT INTO threads (id, session_group_id, provider, alias, updated_at) VALUES (?, ?, 'claude', '黄仁勋', ?)",
  ).run(threadId, sgId, opts.messageAt)
  const contents = opts.messages ?? ["拍板：本轮走方案 A，必须闭环", "收到，开始实现"]
  contents.forEach((content, i) => {
    const msgId = `m-${opts.roomId}-${i}`
    db.prepare(
      "INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(msgId, threadId, i % 2 === 0 ? "user" : "assistant", content, opts.messageAt)
    db.prepare("INSERT INTO message_commit_seq (message_id, committed_at) VALUES (?, ?)").run(
      msgId,
      opts.messageAt,
    )
  })
}

function writeViewfinder(wikiRoot: string, roomId: string, content: string): void {
  const dir = path.join(wikiRoot, "rooms", roomId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "viewfinder.md"), content, "utf-8")
}

/** stub judge：全判非决策（probe 只读 ledger，判官结果不影响断言主线）。 */
const stubJudge: DecisionJudgeProvider = {
  async judge() {
    return { isDecision: false }
  },
}

function countDecisions(db: ReturnType<typeof makeEnv>["db"]): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM room_decisions").get() as { n: number }).n
}

// ── 1. selectSnapshotRooms ──────────────────────────────────────────────

describe("selectSnapshotRooms", () => {
  const active = "2026-06-20T00:00:00Z" // 13 天前（窗口内）
  const stale = "2026-02-01T00:00:00Z" // 152 天前（窗口外）

  it("过滤 activeDays 窗口外的 room", () => {
    const out = selectSnapshotRooms(
      [
        { roomId: "R-001", lastActivityAt: active },
        { roomId: "R-002", lastActivityAt: stale },
      ],
      {},
      NOW_MS,
      { activeDays: 90, maxRooms: 30 },
    )
    assert.deepEqual(out, ["R-001"])
  })

  it("cap 截断 + roomId 字典序确定性", () => {
    const candidates = ["R-003", "R-001", "R-002"].map((roomId) => ({
      roomId,
      lastActivityAt: active,
    }))
    const out = selectSnapshotRooms(candidates, {}, NOW_MS, { activeDays: 90, maxRooms: 2 })
    assert.deepEqual(out, ["R-001", "R-002"])
  })

  it("滚动窗口：从未探过优先，其次最久未探", () => {
    const candidates = ["R-001", "R-002", "R-003"].map((roomId) => ({
      roomId,
      lastActivityAt: active,
    }))
    const probedAt = {
      "R-001": "2026-06-01T00:00:00Z", // 最近探过
      "R-003": "2026-05-01T00:00:00Z", // 更早探过
      // R-002 从未探过
    }
    const out = selectSnapshotRooms(candidates, probedAt, NOW_MS, { activeDays: 90, maxRooms: 2 })
    assert.deepEqual(out, ["R-002", "R-003"])
  })
})

// ── 2. createProbeDecisionLedger（overlay 视图，范-r1 P1/P2-2） ─────────

describe("createProbeDecisionLedger", () => {
  it("append 进 overlay 不落库；读方法返回真表∪overlay 合并视图", () => {
    const env = makeEnv()
    try {
      const real = new DecisionLedger(env.db, () => "2026-07-01T00:00:00Z")
      const realId = real.append({
        roomId: "R-101",
        decidedBy: "小孙",
        decisionType: "commit",
        content: "真决策（real ledger 写入）",
        sourceMessageIds: ["m-1"],
        sourceQuote: "拍板",
        fencingToken: "ft-old",
      })
      assert.ok(realId > 0)

      const probe = createProbeDecisionLedger(env.db, {
        nowFn: () => "2026-07-03T00:00:00Z",
      })
      const vId = probe.append({
        roomId: "R-101",
        decidedBy: "黄仁勋",
        decisionType: "commit",
        content: "探针新判出的决策（只进 overlay）",
        sourceMessageIds: ["m-2"],
        sourceQuote: "probe",
        fencingToken: "ft-probe",
      })
      assert.ok(vId < 0, "虚拟 id 必须为负，不与真表冲突")
      assert.equal(countDecisions(env.db), 1, "overlay append 不得写入 room_decisions")

      // 合并视图：两条都可见，最新（虚拟行）在前
      const active = probe.getActiveDecisions("R-101")
      assert.deepEqual(
        active.map((d) => d.content),
        ["探针新判出的决策（只进 overlay）", "真决策（real ledger 写入）"],
      )
      // 按 type + limit（合并后截断）
      const commits = probe.getActiveByType("R-101", "commit", 1)
      assert.equal(commits.length, 1)
      assert.equal(commits[0].decisionId, vId)
      // getById 分流
      assert.equal(probe.getById(vId)?.content, "探针新判出的决策（只进 overlay）")
      assert.equal(probe.getById(realId)?.content, "真决策（real ledger 写入）")
    } finally {
      env.cleanup()
    }
  })

  it("markCompleted 生产 fencing 语义：同 token 虚拟行可 sweep，真表行永不动", () => {
    const env = makeEnv()
    try {
      const real = new DecisionLedger(env.db)
      const realId = real.append({
        roomId: "R-102",
        decidedBy: "小孙",
        decisionType: "commit",
        content: "真表旧 commit",
        sourceMessageIds: ["m-1"],
        sourceQuote: "拍板",
        fencingToken: "ft-old",
      })
      const probe = createProbeDecisionLedger(env.db)
      const vId = probe.append({
        roomId: "R-102",
        decidedBy: "黄仁勋",
        decisionType: "commit",
        content: "虚拟 commit",
        sourceMessageIds: ["m-2"],
        sourceQuote: "q",
        fencingToken: "ft-probe",
      })
      // 同 token 虚拟行 → sweep；真表行 token 不匹配 → 不动（与 decision-ledger.ts:141 SQL 同语义）
      assert.deepEqual(probe.markCompleted([vId, realId], "ft-probe"), [vId])
      assert.equal(probe.getById(vId)?.status, "completed")
      const realAfter = env.db
        .prepare("SELECT status FROM room_decisions WHERE decision_id = ?")
        .get(realId) as { status: string }
      assert.equal(realAfter.status, "active", "真表行绝不许被探针 sweep")
      // sweep 后 active 视图排除虚拟行
      assert.deepEqual(
        probe.getActiveDecisions("R-102").map((d) => d.decisionId),
        [realId],
      )
    } finally {
      env.cleanup()
    }
  })

  it("默认拒绝：白名单外的 DecisionLedger 方法不存在，调用即 TypeError", () => {
    const env = makeEnv()
    try {
      const probe = createProbeDecisionLedger(env.db) as unknown as DecisionLedger
      // 组合对象上根本没有这些方法 —— 未来 compile-fn 加新写点时探针大声炸（fail-closed）
      assert.throws(() => probe.revoke({} as never), TypeError)
      assert.throws(() => probe.supersede({} as never), TypeError)
      assert.throws(() => probe.markTombstone(1, "ft"), TypeError)
      assert.throws(() => probe.markCoverageChecked(1, true), TypeError)
    } finally {
      env.cleanup()
    }
  })
})

// ── 3. recompileAllRooms 集成 ───────────────────────────────────────────

describe("createMonthlySnapshotRecompiler", () => {
  it("probe 零副作用：返回重编快照、不写 ledger、不动 viewfinder 文件、写滚动 state", async () => {
    const env = makeEnv()
    try {
      seedRoom(env.db, { roomId: "R-201", messageAt: "2026-07-01T10:00:00Z" })
      const currentContent = "# 旧 viewfinder（人手写占位，与重编结果差异巨大）\n"
      writeViewfinder(env.wikiRoot, "R-201", currentContent)

      const recompile = createMonthlySnapshotRecompiler({
        db: env.dbForRecompiler,
        wikiRoot: env.wikiRoot,
        judgeRunner: {} as never, // judgeProvider 注入后不会被触碰
        judgeProvider: stubJudge,
        statePath: env.statePath,
        nowFn: () => NOW,
      })
      const snapshots = await recompile()

      assert.equal(snapshots.length, 1)
      assert.equal(snapshots[0].roomId, "R-201")
      assert.equal(snapshots[0].currentViewfinder, currentContent)
      assert.ok(snapshots[0].recompiledViewfinder.includes("R-201"), "重编结果应含 room id")
      assert.notEqual(snapshots[0].recompiledViewfinder, currentContent)

      // 零副作用三连
      assert.equal(countDecisions(env.db), 0, "probe 不得写 room_decisions")
      assert.equal(
        readFileSync(path.join(env.wikiRoot, "rooms", "R-201", "viewfinder.md"), "utf-8"),
        currentContent,
        "probe 不得改 viewfinder 文件",
      )
      const checkpoints = (
        env.db.prepare("SELECT COUNT(*) AS n FROM room_checkpoints").get() as { n: number }
      ).n
      assert.equal(checkpoints, 0, "probe 不得写 room_checkpoints")

      // 滚动 state 落盘
      const state = JSON.parse(readFileSync(env.statePath, "utf-8")) as {
        probedAt: Record<string, string>
      }
      assert.equal(state.probedAt["R-201"], NOW.toISOString())
    } finally {
      env.cleanup()
    }
  })

  it("滚动窗口跨 run：maxRooms=1 时第二次 run 探另一个 room", async () => {
    const env = makeEnv()
    try {
      seedRoom(env.db, { roomId: "R-201", messageAt: "2026-07-01T10:00:00Z" })
      seedRoom(env.db, { roomId: "R-202", messageAt: "2026-07-01T11:00:00Z" })
      writeViewfinder(env.wikiRoot, "R-201", "vf 201\n")
      writeViewfinder(env.wikiRoot, "R-202", "vf 202\n")

      const mk = (now: Date) =>
        createMonthlySnapshotRecompiler({
          db: env.dbForRecompiler,
          wikiRoot: env.wikiRoot,
          judgeRunner: {} as never,
          judgeProvider: stubJudge,
          statePath: env.statePath,
          maxRoomsPerRun: 1,
          nowFn: () => now,
        })

      const first = await mk(NOW)()
      assert.deepEqual(
        first.map((s) => s.roomId),
        ["R-201"],
      )
      const second = await mk(new Date(NOW_MS + 1000))()
      assert.deepEqual(
        second.map((s) => s.roomId),
        ["R-202"],
        "第二次 run 必须轮到未探过的 R-202",
      )
    } finally {
      env.cleanup()
    }
  })

  it("正例决策（范-r1 P1/P3）：judge 判出的新决策进入重编结果，但零落库", async () => {
    const env = makeEnv()
    try {
      seedRoom(env.db, { roomId: "R-205", messageAt: "2026-07-01T10:00:00Z" })
      writeViewfinder(env.wikiRoot, "R-205", "# 历史漏编的 viewfinder（缺决策）\n")

      const positiveJudge: DecisionJudgeProvider = {
        async judge({ candidate }) {
          if (candidate.content.includes("必须闭环")) {
            return {
              isDecision: true,
              type: "commit",
              content: "月度探针正例决策XYZ",
              confidence: 0.95,
            }
          }
          return { isDecision: false }
        },
      }
      const recompile = createMonthlySnapshotRecompiler({
        db: env.dbForRecompiler,
        wikiRoot: env.wikiRoot,
        judgeRunner: {} as never,
        judgeProvider: positiveJudge,
        statePath: env.statePath,
        nowFn: () => NOW,
      })
      const snapshots = await recompile()

      assert.equal(snapshots.length, 1)
      assert.ok(
        snapshots[0].recompiledViewfinder.includes("月度探针正例决策XYZ"),
        "探针新判出的决策必须进入 recompiled viewfinder（overlay 合并视图核心价值）",
      )
      assert.equal(countDecisions(env.db), 0, "overlay 决策绝不许落库")
    } finally {
      env.cleanup()
    }
  })

  it("sweep 保真（范-r1 P3）：judge supersedes 指向真表旧行时，真表零变化", async () => {
    const env = makeEnv()
    try {
      seedRoom(env.db, { roomId: "R-206", messageAt: "2026-07-01T10:00:00Z" })
      writeViewfinder(env.wikiRoot, "R-206", "vf\n")
      const real = new DecisionLedger(env.db)
      const realId = real.append({
        roomId: "R-206",
        decidedBy: "小孙",
        decisionType: "commit",
        content: "真表旧 commit（探针不许 sweep）",
        sourceMessageIds: ["m-x"],
        sourceQuote: "拍板",
        fencingToken: "ft-old",
      })

      const sweepingJudge: DecisionJudgeProvider = {
        async judge({ candidate }) {
          if (candidate.content.includes("必须闭环")) {
            return {
              isDecision: true,
              type: "commit",
              content: "新 commit 完成了旧承诺",
              confidence: 0.9,
              supersedesDecisionIds: [realId],
            }
          }
          return { isDecision: false }
        },
      }
      const recompile = createMonthlySnapshotRecompiler({
        db: env.dbForRecompiler,
        wikiRoot: env.wikiRoot,
        judgeRunner: {} as never,
        judgeProvider: sweepingJudge,
        statePath: env.statePath,
        nowFn: () => NOW,
      })
      await recompile()

      const after = env.db
        .prepare("SELECT status FROM room_decisions WHERE decision_id = ?")
        .get(realId) as { status: string }
      assert.equal(after.status, "active", "真表行 status 必须原样（fencing 语义保护）")
      assert.equal(countDecisions(env.db), 1, "真表行数不变")
    } finally {
      env.cleanup()
    }
  })

  it("查询失败（范-r1 P2-1）：SQL 异常不记 probedAt，下次优先重试", async () => {
    const env = makeEnv()
    try {
      seedRoom(env.db, { roomId: "R-207", messageAt: "2026-07-01T10:00:00Z" })
      writeViewfinder(env.wikiRoot, "R-207", "vf\n")

      // 包装 db：message_commit_seq 查询模拟 SQLITE_BUSY，其余透传
      const flakyDb = {
        prepare(sql: string) {
          if (sql.includes("message_commit_seq")) throw new Error("SQLITE_BUSY: database is locked")
          return env.db.prepare(sql)
        },
      } as unknown as typeof env.dbForRecompiler

      const recompile = createMonthlySnapshotRecompiler({
        db: flakyDb,
        wikiRoot: env.wikiRoot,
        judgeRunner: {} as never,
        judgeProvider: stubJudge,
        statePath: env.statePath,
        nowFn: () => NOW,
      })
      const snapshots = await recompile()
      assert.deepEqual(snapshots, [], "查询失败的 room 不产出 snapshot")

      const state = JSON.parse(readFileSync(env.statePath, "utf-8")) as {
        probedAt: Record<string, string>
      }
      assert.equal(
        state.probedAt["R-207"],
        undefined,
        "查询失败不许记 probedAt（否则被当成已体检，滚动窗口排后）",
      )
    } finally {
      env.cleanup()
    }
  })

  it("窗口外 room / 无 viewfinder room 不入选", async () => {
    const env = makeEnv()
    try {
      seedRoom(env.db, { roomId: "R-203", messageAt: "2026-01-01T10:00:00Z" }) // 半年前
      writeViewfinder(env.wikiRoot, "R-203", "vf stale\n")
      seedRoom(env.db, { roomId: "R-204", messageAt: "2026-07-01T10:00:00Z" }) // 活跃但没 viewfinder

      const recompile = createMonthlySnapshotRecompiler({
        db: env.dbForRecompiler,
        wikiRoot: env.wikiRoot,
        judgeRunner: {} as never,
        judgeProvider: stubJudge,
        statePath: env.statePath,
        nowFn: () => NOW,
      })
      assert.deepEqual(await recompile(), [])
    } finally {
      env.cleanup()
    }
  })
})

// ── 4. createSnapshotBackup ─────────────────────────────────────────────

describe("createSnapshotBackup", () => {
  it("全量拷 viewfinder 到 <backupRoot>/<label>/ 并净化 label", async () => {
    const env = makeEnv()
    try {
      writeViewfinder(env.wikiRoot, "R-301", "vf 301\n")
      writeViewfinder(env.wikiRoot, "R-302", "vf 302\n")
      const backupRoot = path.join(env.dir, "backups")
      const backup = createSnapshotBackup({ wikiRoot: env.wikiRoot, backupRoot })

      const dest = await backup("monthly-snapshot-2026-07")
      assert.equal(readFileSync(path.join(dest, "R-301.md"), "utf-8"), "vf 301\n")
      assert.equal(readFileSync(path.join(dest, "R-302.md"), "utf-8"), "vf 302\n")

      // label 净化：路径穿越字符全部替换，落点必须仍在 backupRoot 内
      const evil = await backup("../../evil/label")
      assert.ok(
        path.resolve(evil).startsWith(path.resolve(backupRoot) + path.sep),
        `净化后落点必须在 backupRoot 内: ${evil}`,
      )
      assert.ok(existsSync(evil))
    } finally {
      env.cleanup()
    }
  })
})

// ── 5. createSnapshotViewfinderReplacer ─────────────────────────────────

interface SinkCall {
  kind: "pending" | "commit" | "abort"
  payload: unknown
}

function makeStubSink(calls: SinkCall[]) {
  return {
    appendPending(input: unknown) {
      calls.push({ kind: "pending", payload: input })
      return { id: 42 }
    },
    commit(eventId: number, input: unknown) {
      calls.push({ kind: "commit", payload: { eventId, input } })
      return true
    },
    abort(eventId: number, input: unknown) {
      calls.push({ kind: "abort", payload: { eventId, input } })
      return true
    },
  }
}

const leaderContext = {
  currentLeaderTerm: () => "7",
  newFencingToken: () => "ft-snapshot",
}

describe("createSnapshotViewfinderReplacer", () => {
  it("happy path：原子写 + appendPending→commit 留痕", async () => {
    const env = makeEnv()
    try {
      writeViewfinder(env.wikiRoot, "R-401", "old content\n")
      const calls: SinkCall[] = []
      const replace = createSnapshotViewfinderReplacer({
        wikiRoot: env.wikiRoot,
        wikiEventsSink: makeStubSink(calls),
        leaderContext,
      })
      await replace("R-401", "new content\n")

      assert.equal(
        readFileSync(path.join(env.wikiRoot, "rooms", "R-401", "viewfinder.md"), "utf-8"),
        "new content\n",
      )
      assert.deepEqual(
        calls.map((c) => c.kind),
        ["pending", "commit"],
      )
      const pending = calls[0].payload as { path: string; alias: string; baseHash: string | null }
      assert.equal(pending.path, "wiki/rooms/R-401/viewfinder.md")
      assert.equal(pending.alias, "system-monthly-snapshot")
      assert.ok(pending.baseHash, "已有文件必须带 baseHash")
    } finally {
      env.cleanup()
    }
  })

  it("write 失败 → abort 留痕 + rethrow", async () => {
    const env = makeEnv()
    try {
      // 让 viewfinder.md 是个目录 → writeFileAtomic rename 必失败
      mkdirSync(path.join(env.wikiRoot, "rooms", "R-402", "viewfinder.md"), { recursive: true })
      const calls: SinkCall[] = []
      const replace = createSnapshotViewfinderReplacer({
        wikiRoot: env.wikiRoot,
        wikiEventsSink: makeStubSink(calls),
        leaderContext,
      })
      await assert.rejects(() => replace("R-402", "new\n"))
      assert.deepEqual(
        calls.map((c) => c.kind),
        ["pending", "abort"],
        "write 失败必须 abort audit 行",
      )
    } finally {
      env.cleanup()
    }
  })

  it("roomId 白名单：路径穿越值直接 throw", async () => {
    const env = makeEnv()
    try {
      const replace = createSnapshotViewfinderReplacer({
        wikiRoot: env.wikiRoot,
        wikiEventsSink: null,
        leaderContext,
      })
      await assert.rejects(() => replace("../evil", "x"), /invalid roomId/)
    } finally {
      env.cleanup()
    }
  })
})

// ── 6. MonthlySnapshot 壳端到端 ─────────────────────────────────────────

describe("MonthlySnapshot 端到端（recompiler + backup + replacer）", () => {
  it("drift 超阈值 → backup 后 replace + report 记账", async () => {
    const env = makeEnv()
    try {
      seedRoom(env.db, { roomId: "R-501", messageAt: "2026-07-01T10:00:00Z" })
      // current 与重编结果毫无共同词 → drift ≈ 1 > 任意阈值
      writeViewfinder(env.wikiRoot, "R-501", "zzz qqq xxx yyy\n")
      const backupRoot = path.join(env.dir, "backups")
      const calls: SinkCall[] = []

      const snapshot = new MonthlySnapshot({
        recompileAllRooms: createMonthlySnapshotRecompiler({
          db: env.dbForRecompiler,
          wikiRoot: env.wikiRoot,
          judgeRunner: {} as never,
          judgeProvider: stubJudge,
          statePath: env.statePath,
          nowFn: () => NOW,
        }),
        backup: createSnapshotBackup({ wikiRoot: env.wikiRoot, backupRoot }),
        replaceViewfinder: createSnapshotViewfinderReplacer({
          wikiRoot: env.wikiRoot,
          wikiEventsSink: makeStubSink(calls),
          leaderContext,
        }),
        driftThreshold: 0.5,
        clock: () => NOW,
      })
      const report = await snapshot.run()

      assert.equal(report.totalRooms, 1)
      assert.equal(report.roomsReplaced, 1)
      assert.equal(report.roomsReplaceFailed, 0)
      assert.ok(report.backupLocation, "backup 必须先于 replace 发生")
      // 备份里是旧内容，现场是重编内容
      assert.equal(
        readFileSync(path.join(report.backupLocation as string, "R-501.md"), "utf-8"),
        "zzz qqq xxx yyy\n",
      )
      const replaced = readFileSync(
        path.join(env.wikiRoot, "rooms", "R-501", "viewfinder.md"),
        "utf-8",
      )
      assert.notEqual(replaced, "zzz qqq xxx yyy\n")
      assert.ok(replaced.includes("R-501"))
      assert.deepEqual(
        calls.map((c) => c.kind),
        ["pending", "commit"],
        "replace 必须留 wiki_events 痕",
      )
    } finally {
      env.cleanup()
    }
  })

  it("默认未武装（无 backup/replaceViewfinder）→ dry-run 体检：drift 记录但文件不动", async () => {
    // 生产默认态：MULTI_AGENT_MONTHLY_SNAPSHOT_REPLACE 未设 → server.ts 只注入
    // recompileAllRooms（小孙 2026-06-14 C1.5 fork：auto-replace 默认 OFF 先看报告）
    const env = makeEnv()
    try {
      seedRoom(env.db, { roomId: "R-503", messageAt: "2026-07-01T10:00:00Z" })
      writeViewfinder(env.wikiRoot, "R-503", "zzz qqq xxx yyy\n") // drift ≈ 1
      const snapshot = new MonthlySnapshot({
        recompileAllRooms: createMonthlySnapshotRecompiler({
          db: env.dbForRecompiler,
          wikiRoot: env.wikiRoot,
          judgeRunner: {} as never,
          judgeProvider: stubJudge,
          statePath: env.statePath,
          nowFn: () => NOW,
        }),
        driftThreshold: 0.3,
        clock: () => NOW,
      })
      const report = await snapshot.run()
      assert.equal(report.totalRooms, 1)
      assert.ok(report.rooms[0].driftRatio > 0.3, "drift 必须真被算出并进报告")
      assert.equal(report.roomsReplaced, 0, "未武装不许 replace")
      assert.equal(report.backupLocation, null)
      assert.equal(
        readFileSync(path.join(env.wikiRoot, "rooms", "R-503", "viewfinder.md"), "utf-8"),
        "zzz qqq xxx yyy\n",
        "dry-run 不得动文件",
      )
    } finally {
      env.cleanup()
    }
  })

  it("drift 低于阈值 → 不 replace（MVP 等价路径回归）", async () => {
    const env = makeEnv()
    try {
      seedRoom(env.db, { roomId: "R-502", messageAt: "2026-07-01T10:00:00Z" })
      writeViewfinder(env.wikiRoot, "R-502", "占位\n")
      const backupRoot = path.join(env.dir, "backups")

      const snapshot = new MonthlySnapshot({
        recompileAllRooms: createMonthlySnapshotRecompiler({
          db: env.dbForRecompiler,
          wikiRoot: env.wikiRoot,
          judgeRunner: {} as never,
          judgeProvider: stubJudge,
          statePath: env.statePath,
          nowFn: () => NOW,
        }),
        backup: createSnapshotBackup({ wikiRoot: env.wikiRoot, backupRoot }),
        replaceViewfinder: async () => {
          throw new Error("不该被调用")
        },
        driftThreshold: 0.999999, // 阈值拉满 → 永不 replace
        clock: () => NOW,
      })
      const report = await snapshot.run()
      assert.equal(report.roomsReplaced, 0)
      assert.equal(
        readFileSync(path.join(env.wikiRoot, "rooms", "R-502", "viewfinder.md"), "utf-8"),
        "占位\n",
      )
    } finally {
      env.cleanup()
    }
  })
})
