/**
 * F027 P7 · RoomCompiler 端到端测试
 * 真相源：docs/plans/V16.5-final.md chap 8
 * AC：crash recovery test 通过（断点续编）
 *
 * 三层覆盖：
 *   1. shouldCompile: 4 触发条件 + 阈值边界
 *   2. staleness:     warn / sync / fallback × 几种 checkpoint 形态
 *   3. RoomCompiler:  happy path + write 后崩 + commit 后崩 + 文件半写
 */

import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { promises as fsAsync } from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { createDrizzleDb } from "../../db/drizzle-instance"
import { RoomCompiler } from "./room-compiler"
import { DEFAULT_IDLE_MS, DEFAULT_USER_COUNT_THRESHOLD, shouldCompile } from "./should-compile"
import { SqliteCheckpointStore } from "./sqlite-checkpoint-store"
import { DEFAULT_MAX_STALENESS_MS, checkStaleness } from "./staleness"
import type { CompileArtifact, MessageCommitRow, ThreadSealRow } from "./types"

function makeDb(): { db: ReturnType<typeof createDrizzleDb>["raw"]; close: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "room-compiler-test-"))
  const dbPath = path.join(dir, "test.sqlite")
  const { raw, close } = createDrizzleDb(dbPath)
  return {
    db: raw,
    close: () => {
      close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function makeWikiRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "room-compiler-wiki-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function userMsg(
  messageId: string,
  seq: number,
  committedAt = "2026-05-12T00:00:00Z",
): MessageCommitRow {
  return { seq, messageId, committedAt, role: "user" }
}

function asstMsg(
  messageId: string,
  seq: number,
  committedAt = "2026-05-12T00:00:00Z",
): MessageCommitRow {
  return { seq, messageId, committedAt, role: "assistant" }
}

function makeArtifact(opts: {
  cursorCommitSeq: number
  cursorMessageId: string
  sealedCursorSeq?: number
  viewfinderMd?: string
  decisionsMd?: string
  logMd?: string
}): CompileArtifact {
  return {
    viewfinderMd: opts.viewfinderMd ?? `# viewfinder\ncursor=${opts.cursorCommitSeq}`,
    decisionsMd: opts.decisionsMd ?? "# decisions",
    logMd: opts.logMd ?? "# log",
    cursorCommitSeq: opts.cursorCommitSeq,
    cursorMessageId: opts.cursorMessageId,
    sealedCursorSeq: opts.sealedCursorSeq ?? 0,
    threadSealId: null,
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex")
}

// ─── shouldCompile ─────────────────────────────────────────────────────

describe("shouldCompile · 4 触发条件 + 阈值", () => {
  const baseInput = {
    checkpoint: null,
    newMessages: [] as MessageCommitRow[],
    newSeals: [] as ThreadSealRow[],
    now: Date.parse("2026-05-12T01:00:00Z"),
  }

  it("空消息 + 无 checkpoint → 不触发", () => {
    const d = shouldCompile(baseInput)
    assert.equal(d.shouldCompile, false)
    assert.deepEqual(d.reasons, [])
  })

  it("首次 + 任何新 message → first_compile", () => {
    const d = shouldCompile({ ...baseInput, newMessages: [userMsg("m1", 1)] })
    assert.equal(d.shouldCompile, true)
    assert.ok(d.reasons.includes("first_compile"))
  })

  it("user 消息 == 8 → user_count_reached（边界包含）", () => {
    const msgs = Array.from({ length: DEFAULT_USER_COUNT_THRESHOLD }, (_, i) =>
      userMsg(`m${i}`, i + 1),
    )
    const d = shouldCompile({ ...baseInput, newMessages: msgs })
    assert.ok(d.reasons.includes("user_count_reached"))
    assert.equal(d.details.userCount, DEFAULT_USER_COUNT_THRESHOLD)
  })

  it("user 消息 == 7 + 无 checkpoint → 仅 first_compile，不命中 user_count_reached", () => {
    const msgs = Array.from({ length: 7 }, (_, i) => userMsg(`m${i}`, i + 1))
    const d = shouldCompile({ ...baseInput, newMessages: msgs })
    assert.ok(!d.reasons.includes("user_count_reached"))
    assert.ok(d.reasons.includes("first_compile"))
  })

  it("assistant 消息不计入 user count（只数 role==user）", () => {
    const msgs = Array.from({ length: 20 }, (_, i) => asstMsg(`m${i}`, i + 1))
    const d = shouldCompile({ ...baseInput, newMessages: msgs })
    assert.equal(d.details.userCount, 0)
    // first_compile 仍触发因为有新 message
    assert.ok(d.reasons.includes("first_compile"))
    assert.ok(!d.reasons.includes("user_count_reached"))
  })

  it("idle > 30min（已有 checkpoint）→ idle_timeout", () => {
    const checkpoint = {
      roomId: "R1",
      cursorCommitSeq: 10,
      cursorMessageId: "m10",
      sealedCursorSeq: 0,
      viewfinderHash: "h",
      decisionsHash: "h",
      logHash: "h",
      threadSealId: null,
      compiledAt: new Date(baseInput.now - DEFAULT_IDLE_MS - 1000).toISOString(),
      committedAt: new Date(baseInput.now - DEFAULT_IDLE_MS - 500).toISOString(),
      fencingToken: "1",
      leaderTerm: "1",
    }
    const d = shouldCompile({ ...baseInput, checkpoint, newMessages: [userMsg("m11", 11)] })
    assert.ok(d.reasons.includes("idle_timeout"))
  })

  it("idle == 30min 整 → 不触发（chap 8 用 > 不是 >=）", () => {
    const checkpoint = {
      roomId: "R1",
      cursorCommitSeq: 10,
      cursorMessageId: "m10",
      sealedCursorSeq: 0,
      viewfinderHash: "h",
      decisionsHash: "h",
      logHash: "h",
      threadSealId: null,
      compiledAt: new Date(baseInput.now - DEFAULT_IDLE_MS).toISOString(),
      committedAt: new Date(baseInput.now - DEFAULT_IDLE_MS).toISOString(),
      fencingToken: "1",
      leaderTerm: "1",
    }
    const d = shouldCompile({ ...baseInput, checkpoint })
    assert.ok(!d.reasons.includes("idle_timeout"))
  })

  it("有 newSeals → new_seal（哪怕无 message——这是 V16 修的漏洞）", () => {
    const seal: ThreadSealRow = {
      seq: 1,
      threadId: "T1",
      roomId: "R1",
      sealedAt: "2026-05-12T00:00:00Z",
      fencingToken: "1",
    }
    const d = shouldCompile({ ...baseInput, newSeals: [seal] })
    assert.ok(d.reasons.includes("new_seal"))
    assert.equal(d.details.sealCount, 1)
  })

  it("自定义阈值 (config.userCountThreshold=3) 生效", () => {
    const msgs = Array.from({ length: 3 }, (_, i) => userMsg(`m${i}`, i + 1))
    const d = shouldCompile({ ...baseInput, newMessages: msgs, config: { userCountThreshold: 3 } })
    assert.ok(d.reasons.includes("user_count_reached"))
  })
})

// ─── staleness ─────────────────────────────────────────────────────────

describe("checkStaleness · 三种 strategy + 几种 checkpoint 形态", () => {
  const now = Date.parse("2026-05-12T01:00:00Z")

  it("无 checkpoint → ageMs=∞ + 默认 warn", () => {
    const r = checkStaleness({ checkpoint: null, now })
    assert.equal(r.stale, true)
    assert.equal(r.ageMs, Number.POSITIVE_INFINITY)
    assert.equal(r.decision, "use_viewfinder") // warn 仍允许读
    assert.ok(r.warning)
  })

  it("uncommitted checkpoint (committed_at=NULL) → 视为 stale", () => {
    const r = checkStaleness({
      checkpoint: {
        roomId: "R1",
        cursorCommitSeq: 1,
        cursorMessageId: "m1",
        sealedCursorSeq: 0,
        viewfinderHash: "h",
        decisionsHash: "h",
        logHash: "h",
        threadSealId: null,
        compiledAt: new Date(now).toISOString(),
        committedAt: null,
        fencingToken: "1",
        leaderTerm: "1",
      },
      now,
    })
    assert.equal(r.stale, true)
  })

  it("fresh checkpoint (age < max) → not stale, decision=use_viewfinder, no warning", () => {
    const r = checkStaleness({
      checkpoint: {
        roomId: "R1",
        cursorCommitSeq: 1,
        cursorMessageId: "m1",
        sealedCursorSeq: 0,
        viewfinderHash: "h",
        decisionsHash: "h",
        logHash: "h",
        threadSealId: null,
        compiledAt: new Date(now - 1000).toISOString(),
        committedAt: new Date(now - 1000).toISOString(),
        fencingToken: "1",
        leaderTerm: "1",
      },
      now,
    })
    assert.equal(r.stale, false)
    assert.equal(r.decision, "use_viewfinder")
    assert.equal(r.warning, undefined)
  })

  it("stale + strategy=sync → trigger_sync", () => {
    const r = checkStaleness({
      checkpoint: {
        roomId: "R1",
        cursorCommitSeq: 1,
        cursorMessageId: "m1",
        sealedCursorSeq: 0,
        viewfinderHash: "h",
        decisionsHash: "h",
        logHash: "h",
        threadSealId: null,
        compiledAt: new Date(now - DEFAULT_MAX_STALENESS_MS - 1000).toISOString(),
        committedAt: new Date(now - DEFAULT_MAX_STALENESS_MS - 1000).toISOString(),
        fencingToken: "1",
        leaderTerm: "1",
      },
      now,
      config: { strategy: "sync" },
    })
    assert.equal(r.stale, true)
    assert.equal(r.decision, "trigger_sync")
  })

  it("stale + strategy=fallback → fallback_messages", () => {
    const r = checkStaleness({
      checkpoint: {
        roomId: "R1",
        cursorCommitSeq: 1,
        cursorMessageId: "m1",
        sealedCursorSeq: 0,
        viewfinderHash: "h",
        decisionsHash: "h",
        logHash: "h",
        threadSealId: null,
        compiledAt: new Date(now - DEFAULT_MAX_STALENESS_MS - 1000).toISOString(),
        committedAt: new Date(now - DEFAULT_MAX_STALENESS_MS - 1000).toISOString(),
        fencingToken: "1",
        leaderTerm: "1",
      },
      now,
      config: { strategy: "fallback" },
    })
    assert.equal(r.decision, "fallback_messages")
  })
})

// ─── RoomCompiler 二阶段提交 + 崩溃恢复（核心 AC）──────────────────────

describe("RoomCompiler · 二阶段提交 happy path", () => {
  it("PREPARE → WRITE → COMMIT 全成功 → checkpoint.committedAt 非空 + 3 文件落盘", async () => {
    const { db, close } = makeDb()
    const { root, cleanup } = makeWikiRoot()
    try {
      const store = new SqliteCheckpointStore(db)
      const compiler = new RoomCompiler({
        store,
        wikiRoot: root,
        leaderTerm: "1",
        fencingToken: "100",
        compileFn: () => makeArtifact({ cursorCommitSeq: 5, cursorMessageId: "m5" }),
      })
      const result = await compiler.run({
        roomId: "R1",
        newMessages: [userMsg("m5", 5)],
        newSeals: [],
        now: Date.parse("2026-05-12T01:00:00Z"),
      })
      assert.ok(result.checkpoint.committedAt)
      assert.equal(result.checkpoint.cursorCommitSeq, 5)
      // 3 文件存在
      const dir = path.join(root, "rooms", "R1")
      const v = await fsAsync.readFile(path.join(dir, "viewfinder.md"), "utf-8")
      const d = await fsAsync.readFile(path.join(dir, "decisions.md"), "utf-8")
      const l = await fsAsync.readFile(path.join(dir, "log.md"), "utf-8")
      assert.equal(sha256(v), result.checkpoint.viewfinderHash)
      assert.equal(sha256(d), result.checkpoint.decisionsHash)
      assert.equal(sha256(l), result.checkpoint.logHash)
      // DB row committed_at IS NOT NULL
      const row = store.read("R1")
      assert.ok(row?.committedAt)
    } finally {
      cleanup()
      close()
    }
  })

  it("compileFn throws → 抛 RoomCompilerError(stage=prepare) + 无 checkpoint 行 + 无文件", async () => {
    const { db, close } = makeDb()
    const { root, cleanup } = makeWikiRoot()
    try {
      const store = new SqliteCheckpointStore(db)
      const compiler = new RoomCompiler({
        store,
        wikiRoot: root,
        leaderTerm: "1",
        fencingToken: "100",
        compileFn: () => {
          throw new Error("LLM exploded")
        },
      })
      await assert.rejects(
        compiler.run({ roomId: "R1", newMessages: [userMsg("m1", 1)], newSeals: [] }),
        (err: Error) => /LLM exploded/.test(err.message),
      )
      assert.equal(store.read("R1"), null)
      // viewfinder.md 不该被建出来
      await assert.rejects(fsAsync.access(path.join(root, "rooms", "R1", "viewfinder.md")))
    } finally {
      cleanup()
      close()
    }
  })
})

describe("RoomCompiler · 崩溃恢复 (核心 AC: 断点续编)", () => {
  it("write 后崩 (commit 没跑) → reconciler 比对 hash 命中 → 补 committed_at", async () => {
    const { db, close } = makeDb()
    const { root, cleanup } = makeWikiRoot()
    try {
      const store = new SqliteCheckpointStore(db)
      const artifact = makeArtifact({
        cursorCommitSeq: 7,
        cursorMessageId: "m7",
        viewfinderMd: "# viewfinder R1 commit=7",
      })

      // 模拟 write 后崩：手动跑 PREPARE + WRITE，跳过 COMMIT
      const dir = path.join(root, "rooms", "R1")
      const compiledAt = "2026-05-12T01:00:00.000Z"
      store.prepare({
        roomId: "R1",
        cursorCommitSeq: artifact.cursorCommitSeq,
        cursorMessageId: artifact.cursorMessageId,
        sealedCursorSeq: artifact.sealedCursorSeq,
        viewfinderHash: sha256(artifact.viewfinderMd),
        decisionsHash: sha256(artifact.decisionsMd),
        logHash: sha256(artifact.logMd),
        threadSealId: null,
        compiledAt,
        fencingToken: "100",
        leaderTerm: "1",
      })
      // 文件全落（write 阶段成功）
      await fsAsync.mkdir(dir, { recursive: true })
      await fsAsync.writeFile(path.join(dir, "viewfinder.md"), artifact.viewfinderMd)
      await fsAsync.writeFile(path.join(dir, "decisions.md"), artifact.decisionsMd)
      await fsAsync.writeFile(path.join(dir, "log.md"), artifact.logMd)

      // committed_at 应是 NULL
      assert.equal(store.read("R1")?.committedAt, null)
      assert.equal(store.listIncomplete().length, 1)

      // 重启：跑 reconciler
      const compiler = new RoomCompiler({
        store,
        wikiRoot: root,
        leaderTerm: "2",
        fencingToken: "200",
        compileFn: () => artifact,
      })
      const report = await compiler.recoverIncomplete(Date.parse("2026-05-12T02:00:00Z"))
      assert.equal(report.scanned, 1)
      assert.equal(report.patched, 1)
      assert.equal(report.rolledBack, 0)

      // checkpoint 现在 committedAt 非空 = SessionBootstrap 可读
      const row = store.read("R1")
      assert.ok(row?.committedAt)
      assert.equal(row?.cursorCommitSeq, 7)
    } finally {
      cleanup()
      close()
    }
  })

  it("write 半完成 (viewfinder 半写) → hash 不匹配 → 删 prepare 行（caller 重新 compile）", async () => {
    const { db, close } = makeDb()
    const { root, cleanup } = makeWikiRoot()
    try {
      const store = new SqliteCheckpointStore(db)
      const artifact = makeArtifact({
        cursorCommitSeq: 7,
        cursorMessageId: "m7",
        viewfinderMd: "# expected viewfinder content",
      })

      const dir = path.join(root, "rooms", "R1")
      const compiledAt = "2026-05-12T01:00:00.000Z"
      store.prepare({
        roomId: "R1",
        cursorCommitSeq: artifact.cursorCommitSeq,
        cursorMessageId: artifact.cursorMessageId,
        sealedCursorSeq: 0,
        viewfinderHash: sha256(artifact.viewfinderMd),
        decisionsHash: sha256(artifact.decisionsMd),
        logHash: sha256(artifact.logMd),
        threadSealId: null,
        compiledAt,
        fencingToken: "100",
        leaderTerm: "1",
      })
      // 文件半写（不同 content → hash 不匹配）
      await fsAsync.mkdir(dir, { recursive: true })
      await fsAsync.writeFile(path.join(dir, "viewfinder.md"), "# garbage half-write")

      const compiler = new RoomCompiler({
        store,
        wikiRoot: root,
        leaderTerm: "2",
        fencingToken: "200",
        compileFn: () => artifact,
      })
      const report = await compiler.recoverIncomplete()
      assert.equal(report.scanned, 1)
      assert.equal(report.patched, 0)
      assert.equal(report.rolledBack, 1)
      assert.equal(report.details[0].reason, "viewfinder.md_hash_mismatch")
      // checkpoint 行被删（caller 下次 run 会从 prev=null 重头编）
      assert.equal(store.read("R1"), null)
    } finally {
      cleanup()
      close()
    }
  })

  it("write 完全没跑 (viewfinder 文件都没建) → ENOENT → 删 prepare 行", async () => {
    const { db, close } = makeDb()
    const { root, cleanup } = makeWikiRoot()
    try {
      const store = new SqliteCheckpointStore(db)
      const artifact = makeArtifact({
        cursorCommitSeq: 7,
        cursorMessageId: "m7",
        viewfinderMd: "# v",
      })
      const compiledAt = "2026-05-12T01:00:00.000Z"
      store.prepare({
        roomId: "R1",
        cursorCommitSeq: artifact.cursorCommitSeq,
        cursorMessageId: artifact.cursorMessageId,
        sealedCursorSeq: 0,
        viewfinderHash: sha256(artifact.viewfinderMd),
        decisionsHash: sha256(artifact.decisionsMd),
        logHash: sha256(artifact.logMd),
        threadSealId: null,
        compiledAt,
        fencingToken: "100",
        leaderTerm: "1",
      })
      // 文件不存在
      const compiler = new RoomCompiler({
        store,
        wikiRoot: root,
        leaderTerm: "2",
        fencingToken: "200",
        compileFn: () => artifact,
      })
      const report = await compiler.recoverIncomplete()
      assert.equal(report.rolledBack, 1)
      assert.equal(report.details[0].reason, "viewfinder.md_missing")
      assert.equal(store.read("R1"), null)
    } finally {
      cleanup()
      close()
    }
  })

  it("混合：3 行 prepare（1 hash 匹配 / 1 hash 不匹配 / 1 文件缺失）→ 1 patched + 2 rolled_back", async () => {
    const { db, close } = makeDb()
    const { root, cleanup } = makeWikiRoot()
    try {
      const store = new SqliteCheckpointStore(db)
      // R1 hash 匹配
      const a1 = makeArtifact({ cursorCommitSeq: 1, cursorMessageId: "m1", viewfinderMd: "# A" })
      // R2 hash 不匹配
      const a2 = makeArtifact({
        cursorCommitSeq: 2,
        cursorMessageId: "m2",
        viewfinderMd: "# B-expected",
      })
      // R3 文件缺失
      const a3 = makeArtifact({ cursorCommitSeq: 3, cursorMessageId: "m3", viewfinderMd: "# C" })
      const ts = "2026-05-12T01:00:00.000Z"

      for (const [room, art] of [
        ["R1", a1],
        ["R2", a2],
        ["R3", a3],
      ] as const) {
        store.prepare({
          roomId: room,
          cursorCommitSeq: art.cursorCommitSeq,
          cursorMessageId: art.cursorMessageId,
          sealedCursorSeq: 0,
          viewfinderHash: sha256(art.viewfinderMd),
          decisionsHash: sha256(art.decisionsMd),
          logHash: sha256(art.logMd),
          threadSealId: null,
          compiledAt: ts,
          fencingToken: "1",
          leaderTerm: "1",
        })
      }
      // R1 落盘正确（3 文件全对，按范-r1 P1-1 必须 3 文件全 hash 匹配才 patch）
      await fsAsync.mkdir(path.join(root, "rooms", "R1"), { recursive: true })
      await fsAsync.writeFile(path.join(root, "rooms", "R1", "viewfinder.md"), a1.viewfinderMd)
      await fsAsync.writeFile(path.join(root, "rooms", "R1", "decisions.md"), a1.decisionsMd)
      await fsAsync.writeFile(path.join(root, "rooms", "R1", "log.md"), a1.logMd)
      // R2 落盘错的（viewfinder hash 不匹配 → rollback）
      await fsAsync.mkdir(path.join(root, "rooms", "R2"), { recursive: true })
      await fsAsync.writeFile(path.join(root, "rooms", "R2", "viewfinder.md"), "# B-WRONG")
      // R3 不写文件

      const compiler = new RoomCompiler({
        store,
        wikiRoot: root,
        leaderTerm: "2",
        fencingToken: "2",
        compileFn: () => a1,
      })
      const report = await compiler.recoverIncomplete()
      assert.equal(report.scanned, 3)
      assert.equal(report.patched, 1)
      assert.equal(report.rolledBack, 2)
      assert.ok(store.read("R1")?.committedAt)
      assert.equal(store.read("R2"), null)
      assert.equal(store.read("R3"), null)
    } finally {
      cleanup()
      close()
    }
  })

  it("commit 后再读：committedAt 行 SessionBootstrap 可读，prepare 行不可见", async () => {
    const { db, close } = makeDb()
    const { root, cleanup } = makeWikiRoot()
    try {
      const store = new SqliteCheckpointStore(db)
      const compiler = new RoomCompiler({
        store,
        wikiRoot: root,
        leaderTerm: "1",
        fencingToken: "1",
        compileFn: () => makeArtifact({ cursorCommitSeq: 1, cursorMessageId: "m1" }),
      })
      await compiler.run({ roomId: "R1", newMessages: [userMsg("m1", 1)], newSeals: [] })
      // listIncomplete 应该为空
      assert.deepEqual(store.listIncomplete(), [])
      // 读得到 committed checkpoint
      const row = store.read("R1")
      assert.ok(row?.committedAt)
    } finally {
      cleanup()
      close()
    }
  })
})

// ─── 范-r1 P1-1 修：3 文件 hash 必须全匹配才补 committed_at ───────────

describe("RoomCompiler · 范-r1 P1-1 三文件 hash 全校验", () => {
  it("viewfinder hash 匹配 但 decisions.md 缺失 → 不补 committed_at, 走 rollback", async () => {
    const { db, close } = makeDb()
    const { root, cleanup } = makeWikiRoot()
    try {
      const store = new SqliteCheckpointStore(db)
      const artifact = makeArtifact({
        cursorCommitSeq: 7,
        cursorMessageId: "m7",
        viewfinderMd: "# viewfinder OK",
        decisionsMd: "# decisions OK",
        logMd: "# log OK",
      })
      const compiledAt = "2026-05-12T01:00:00.000Z"
      store.prepare({
        roomId: "R1",
        cursorCommitSeq: artifact.cursorCommitSeq,
        cursorMessageId: artifact.cursorMessageId,
        sealedCursorSeq: 0,
        viewfinderHash: sha256(artifact.viewfinderMd),
        decisionsHash: sha256(artifact.decisionsMd),
        logHash: sha256(artifact.logMd),
        threadSealId: null,
        compiledAt,
        fencingToken: "100",
        leaderTerm: "1",
      })
      // viewfinder 落盘 OK，decisions / log 缺失（write 阶段崩在第 1 个 atomic-rename 之后）
      const dir = path.join(root, "rooms", "R1")
      await fsAsync.mkdir(dir, { recursive: true })
      await fsAsync.writeFile(path.join(dir, "viewfinder.md"), artifact.viewfinderMd)

      const compiler = new RoomCompiler({
        store,
        wikiRoot: root,
        leaderTerm: "2",
        fencingToken: "200",
        compileFn: () => artifact,
      })
      const report = await compiler.recoverIncomplete()
      assert.equal(report.scanned, 1)
      assert.equal(report.patched, 0, "viewfinder match alone must NOT patch — 范-r1 P1-1")
      assert.equal(report.rolledBack, 1)
      assert.equal(store.read("R1"), null)
    } finally {
      cleanup()
      close()
    }
  })

  it("viewfinder + decisions OK, log.md hash 不匹配 → 不补 committed_at", async () => {
    const { db, close } = makeDb()
    const { root, cleanup } = makeWikiRoot()
    try {
      const store = new SqliteCheckpointStore(db)
      const artifact = makeArtifact({
        cursorCommitSeq: 7,
        cursorMessageId: "m7",
        viewfinderMd: "# v",
        decisionsMd: "# d",
        logMd: "# expected log",
      })
      const compiledAt = "2026-05-12T01:00:00.000Z"
      store.prepare({
        roomId: "R1",
        cursorCommitSeq: artifact.cursorCommitSeq,
        cursorMessageId: artifact.cursorMessageId,
        sealedCursorSeq: 0,
        viewfinderHash: sha256(artifact.viewfinderMd),
        decisionsHash: sha256(artifact.decisionsMd),
        logHash: sha256(artifact.logMd),
        threadSealId: null,
        compiledAt,
        fencingToken: "100",
        leaderTerm: "1",
      })
      const dir = path.join(root, "rooms", "R1")
      await fsAsync.mkdir(dir, { recursive: true })
      await fsAsync.writeFile(path.join(dir, "viewfinder.md"), artifact.viewfinderMd)
      await fsAsync.writeFile(path.join(dir, "decisions.md"), artifact.decisionsMd)
      await fsAsync.writeFile(path.join(dir, "log.md"), "# WRONG LOG")

      const compiler = new RoomCompiler({
        store,
        wikiRoot: root,
        leaderTerm: "2",
        fencingToken: "200",
        compileFn: () => artifact,
      })
      const report = await compiler.recoverIncomplete()
      assert.equal(report.patched, 0)
      assert.equal(report.rolledBack, 1)
      assert.equal(report.details[0].reason, "log.md_hash_mismatch")
    } finally {
      cleanup()
      close()
    }
  })

  it("3 文件 hash 全匹配 → 补 committed_at", async () => {
    const { db, close } = makeDb()
    const { root, cleanup } = makeWikiRoot()
    try {
      const store = new SqliteCheckpointStore(db)
      const artifact = makeArtifact({
        cursorCommitSeq: 7,
        cursorMessageId: "m7",
        viewfinderMd: "# v",
        decisionsMd: "# d",
        logMd: "# l",
      })
      const compiledAt = "2026-05-12T01:00:00.000Z"
      store.prepare({
        roomId: "R1",
        cursorCommitSeq: artifact.cursorCommitSeq,
        cursorMessageId: artifact.cursorMessageId,
        sealedCursorSeq: 0,
        viewfinderHash: sha256(artifact.viewfinderMd),
        decisionsHash: sha256(artifact.decisionsMd),
        logHash: sha256(artifact.logMd),
        threadSealId: null,
        compiledAt,
        fencingToken: "100",
        leaderTerm: "1",
      })
      const dir = path.join(root, "rooms", "R1")
      await fsAsync.mkdir(dir, { recursive: true })
      await fsAsync.writeFile(path.join(dir, "viewfinder.md"), artifact.viewfinderMd)
      await fsAsync.writeFile(path.join(dir, "decisions.md"), artifact.decisionsMd)
      await fsAsync.writeFile(path.join(dir, "log.md"), artifact.logMd)

      const compiler = new RoomCompiler({
        store,
        wikiRoot: root,
        leaderTerm: "2",
        fencingToken: "200",
        compileFn: () => artifact,
      })
      const report = await compiler.recoverIncomplete()
      assert.equal(report.patched, 1)
      assert.equal(report.rolledBack, 0)
      assert.ok(store.read("R1")?.committedAt)
    } finally {
      cleanup()
      close()
    }
  })

  it("recover 跑两次幂等：第二次扫到 0 行（committed_at 已补）", async () => {
    const { db, close } = makeDb()
    const { root, cleanup } = makeWikiRoot()
    try {
      const store = new SqliteCheckpointStore(db)
      const compiler = new RoomCompiler({
        store,
        wikiRoot: root,
        leaderTerm: "1",
        fencingToken: "1",
        compileFn: () => makeArtifact({ cursorCommitSeq: 1, cursorMessageId: "m1" }),
      })
      // 模拟 write 后崩
      const a = makeArtifact({ cursorCommitSeq: 1, cursorMessageId: "m1" })
      store.prepare({
        roomId: "R1",
        cursorCommitSeq: a.cursorCommitSeq,
        cursorMessageId: a.cursorMessageId,
        sealedCursorSeq: 0,
        viewfinderHash: sha256(a.viewfinderMd),
        decisionsHash: sha256(a.decisionsMd),
        logHash: sha256(a.logMd),
        threadSealId: null,
        compiledAt: "2026-05-12T01:00:00.000Z",
        fencingToken: "1",
        leaderTerm: "1",
      })
      const dir = path.join(root, "rooms", "R1")
      await fsAsync.mkdir(dir, { recursive: true })
      await fsAsync.writeFile(path.join(dir, "viewfinder.md"), a.viewfinderMd)
      await fsAsync.writeFile(path.join(dir, "decisions.md"), a.decisionsMd)
      await fsAsync.writeFile(path.join(dir, "log.md"), a.logMd)

      const r1 = await compiler.recoverIncomplete()
      assert.equal(r1.patched, 1)
      const r2 = await compiler.recoverIncomplete()
      assert.equal(r2.scanned, 0, "幂等：第二次 listIncomplete 应为空")
      assert.equal(r2.patched, 0)
      assert.equal(r2.rolledBack, 0)
    } finally {
      cleanup()
      close()
    }
  })
})

// ─── 范-r1 P1-2 修：同 room 并发互斥 ─────────────────────────────────

describe("RoomCompiler · 范-r1 P1-2 同 room 并发安全", () => {
  it("两次 run() 并发触发同 room → 串行执行，最终状态一致（不会互相覆盖文件）", async () => {
    const { db, close } = makeDb()
    const { root, cleanup } = makeWikiRoot()
    try {
      const store = new SqliteCheckpointStore(db)
      let cursor = 0
      const compileLatencies: number[] = []
      const compiler = new RoomCompiler({
        store,
        wikiRoot: root,
        leaderTerm: "1",
        fencingToken: "1",
        compileFn: async () => {
          cursor++
          const myCursor = cursor
          // 模拟 LLM 耗时；前一个 compile 还在 await 时第二个 run() 会进入
          await new Promise((r) => setTimeout(r, 30))
          compileLatencies.push(Date.now())
          return makeArtifact({
            cursorCommitSeq: myCursor,
            cursorMessageId: `m${myCursor}`,
            viewfinderMd: `# v cursor=${myCursor}`,
          })
        },
      })
      // 并发触发两次
      const [a, b] = await Promise.all([
        compiler.run({ roomId: "R1", newMessages: [userMsg("m1", 1)], newSeals: [] }),
        compiler.run({ roomId: "R1", newMessages: [userMsg("m2", 2)], newSeals: [] }),
      ])
      // 最终 row 必须 committed_at 非空 + 文件 hash 匹配 row 的 hash
      const final = store.read("R1")
      assert.ok(final?.committedAt, "最终 row 必须 commit")
      const v = await fsAsync.readFile(path.join(root, "rooms", "R1", "viewfinder.md"), "utf-8")
      assert.equal(
        sha256(v),
        final?.viewfinderHash,
        "文件 hash 必须匹配最终 row 的 hash —— 范-r1 P1-2 防 stale writer 覆盖",
      )
      // listIncomplete 必须空
      assert.deepEqual(store.listIncomplete(), [])
      // 两次都拿到合法 artifact
      assert.ok(a.checkpoint.committedAt)
      assert.ok(b.checkpoint.committedAt)
    } finally {
      cleanup()
      close()
    }
  })

  it("mutex 必须 per-room：同 room 串行 / 不同 room 可交叠（用 observable order 而非 wall-clock）", async () => {
    const { db, close } = makeDb()
    const { root, cleanup } = makeWikiRoot()
    try {
      const store = new SqliteCheckpointStore(db)
      const order: string[] = []
      const counters: Record<string, number> = {}
      const compiler = new RoomCompiler({
        store,
        wikiRoot: root,
        leaderTerm: "1",
        fencingToken: "1",
        compileFn: async ({ roomId }) => {
          const idx = counters[roomId] ?? 0
          counters[roomId] = idx + 1
          order.push(`start-${roomId}-${idx}`)
          await new Promise((r) => setTimeout(r, 20))
          order.push(`end-${roomId}-${idx}`)
          return makeArtifact({
            cursorCommitSeq: idx + 1,
            cursorMessageId: `m-${roomId}-${idx}`,
            viewfinderMd: `# v ${roomId} ${idx}`,
          })
        },
      })
      // R1 ×2 + R2 ×1 并发触发
      await Promise.all([
        compiler.run({ roomId: "R1", newMessages: [userMsg("m1a", 1)], newSeals: [] }),
        compiler.run({ roomId: "R1", newMessages: [userMsg("m1b", 2)], newSeals: [] }),
        compiler.run({ roomId: "R2", newMessages: [userMsg("m2", 3)], newSeals: [] }),
      ])

      // 同 room 必须严格串行：R1 第二次 start 必须在 R1 第一次 end 之后
      const r1Start1 = order.indexOf("start-R1-0")
      const r1End1 = order.indexOf("end-R1-0")
      const r1Start2 = order.indexOf("start-R1-1")
      assert.ok(
        r1Start1 >= 0 && r1End1 >= 0 && r1Start2 >= 0,
        `R1 events missing in order: ${order.join(",")}`,
      )
      assert.ok(
        r1End1 < r1Start2,
        `同 R1 必须串行: end-R1-0(${r1End1}) < start-R1-1(${r1Start2}); order=${order.join(",")}`,
      )

      // 不同 room 必须可交叠：R2 start 必须早于 R1 第二次 end（即不被 R1 全部 block 完才轮上）
      const r2Start = order.indexOf("start-R2-0")
      const r1End2 = order.indexOf("end-R1-1")
      assert.ok(r2Start >= 0 && r1End2 >= 0)
      assert.ok(
        r2Start < r1End2,
        `R2 必须能与 R1 交叠（per-room 而非 global）: r2Start=${r2Start} r1End2=${r1End2}; order=${order.join(",")}`,
      )

      // 最终都 commit
      assert.ok(store.read("R1")?.committedAt)
      assert.ok(store.read("R2")?.committedAt)
    } finally {
      cleanup()
      close()
    }
  })
})

// ─── 范-r1 P2-1 修：read API 拆 ──────────────────────────────────────

describe("CheckpointStore · 范-r1 P2-1 readForBootstrap 只返已 commit", () => {
  it("readForBootstrap 在 committed 行返回；prepare 行返 null（防 SessionBootstrap 误读）", () => {
    const { db, close } = makeDb()
    try {
      const store = new SqliteCheckpointStore(db)
      const artifact = makeArtifact({ cursorCommitSeq: 1, cursorMessageId: "m1" })
      store.prepare({
        roomId: "R1",
        cursorCommitSeq: artifact.cursorCommitSeq,
        cursorMessageId: artifact.cursorMessageId,
        sealedCursorSeq: 0,
        viewfinderHash: sha256(artifact.viewfinderMd),
        decisionsHash: sha256(artifact.decisionsMd),
        logHash: sha256(artifact.logMd),
        threadSealId: null,
        compiledAt: "2026-05-12T01:00:00.000Z",
        fencingToken: "1",
        leaderTerm: "1",
      })
      // prepare 行 read() 看得到，但 readForBootstrap() 看不到
      assert.ok(store.read("R1"), "compiler-side read 必须看得到 prepare 行")
      assert.equal(store.readForBootstrap("R1"), null, "Bootstrap-side 必须看不到 prepare 行")
      // commit 后两边都看得到
      store.commit("R1", "2026-05-12T01:00:00.000Z", "2026-05-12T01:00:01.000Z")
      assert.ok(store.read("R1")?.committedAt)
      assert.ok(store.readForBootstrap("R1")?.committedAt)
    } finally {
      close()
    }
  })
})

describe("RoomCompiler · 二次 run 覆盖 prepare 行（commit 之间无 race）", () => {
  it("第一次 run 完毕 → 第二次 run prepare 覆盖，committedAt 重置 NULL → COMMIT 后再非空", async () => {
    const { db, close } = makeDb()
    const { root, cleanup } = makeWikiRoot()
    try {
      const store = new SqliteCheckpointStore(db)
      let cursor = 1
      const compiler = new RoomCompiler({
        store,
        wikiRoot: root,
        leaderTerm: "1",
        fencingToken: "1",
        compileFn: () =>
          makeArtifact({
            cursorCommitSeq: cursor,
            cursorMessageId: `m${cursor}`,
            viewfinderMd: `# v cursor=${cursor}-${randomBytes(4).toString("hex")}`,
          }),
      })
      await compiler.run({
        roomId: "R1",
        newMessages: [userMsg("m1", 1)],
        newSeals: [],
        now: Date.parse("2026-05-12T01:00:00Z"),
      })
      cursor = 2
      const r2 = await compiler.run({
        roomId: "R1",
        newMessages: [userMsg("m2", 2)],
        newSeals: [],
        now: Date.parse("2026-05-12T02:00:00Z"),
      })
      const final = store.read("R1")
      assert.equal(final?.cursorCommitSeq, 2)
      assert.ok(final?.committedAt)
      assert.equal(final?.compiledAt, r2.checkpoint.compiledAt)
    } finally {
      cleanup()
      close()
    }
  })
})

/**
 * 范-r1 P1（sync codex review）抓出：
 *   appendPending swallow 异常 → viewfinder.md 落盘但无 wiki_events 留痕 →
 *   破坏 V16.5 §5 "所有 wiki 写操作走 append-only event log" 强契约 + 「追溯按钮」空。
 * 修复：fail-closed — appendPending 抛 → deletePrepare rollback room_checkpoints + 抛错。
 */
describe("RoomCompiler · 范-r1 P1 wiki_events fail-closed", () => {
  it("appendPending 抛错 → RoomCompiler.run 抛 RoomCompilerError + rollback prepare 行", async () => {
    const { db, close } = makeDb()
    const { root, cleanup } = makeWikiRoot()
    const store = new SqliteCheckpointStore(db)

    // 模拟 sink: appendPending 总抛错
    let appendCalls = 0
    const failingSink = {
      appendPending: () => {
        appendCalls++
        throw new Error("DB connection lost during appendPending")
      },
      commit: () => true,
      abort: () => true,
    }

    const compiler = new RoomCompiler({
      store,
      wikiRoot: root,
      compileFn: async () => makeArtifact({ cursorCommitSeq: 1, cursorMessageId: "m-1" }),
      fencingToken: "fake-token",
      leaderTerm: "fake-term",
      wikiEventsSink: failingSink,
    })

    try {
      const msgs = [userMsg("m-1", 1)]
      let thrown: Error | null = null
      try {
        await compiler.run({ roomId: "R-fail", newMessages: msgs, newSeals: [] })
      } catch (err) {
        thrown = err as Error
      }
      // 必须抛 RoomCompilerError，phase=prepare
      assert.ok(thrown, "应抛错")
      assert.match(
        thrown!.message,
        /wiki_events\.appendPending failed/,
        "错误信息应明示 wiki_events failure (V16.5 §5 强契约)",
      )
      assert.equal(appendCalls, 1, "appendPending 被调一次")
      // rollback 验证：room_checkpoints 不应留 prepare 行（防 reconciler 复用半成品）
      const remaining = store.read("R-fail")
      assert.equal(remaining, null, "deletePrepare 应已 rollback prepare 行")
      // 文件不应被写（write 在 audit prepare 之后）
      try {
        await fsAsync.access(path.join(root, "rooms", "R-fail", "viewfinder.md"))
        assert.fail("viewfinder.md 不应存在（fail-closed 在 write 前抛）")
      } catch (err) {
        assert.equal((err as NodeJS.ErrnoException).code, "ENOENT", "viewfinder.md 应不存在")
      }
    } finally {
      cleanup()
      close()
    }
  })
})
