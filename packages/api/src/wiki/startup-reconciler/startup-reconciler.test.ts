/**
 * F027 P7.5 · Startup Reconciler 端到端测试
 * 真相源：docs/plans/V16.5-final.md chap 5 + chap 8
 * AC：kill -9 后重启状态恢复
 *
 * 三层覆盖：
 *   1. decideVerdict（pure）—— 决策表 6 种 hash 组合
 *   2. reconcileWikiEvents —— DB + fs 集成 + state CAS
 *   3. StartupReconciler —— wiki_events + room_checkpoints 复合恢复（核心 AC）
 */

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { promises as fsAsync } from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { drizzle as drizzleBetter } from "drizzle-orm/better-sqlite3"
import { createDrizzleDb } from "../../db/drizzle-instance"
import { WikiEventsRepository } from "../../db/repositories/wiki-events-repository"
import * as schema from "../../db/schema"
import { RoomCompiler } from "../room-compiler/room-compiler"
import { SqliteCheckpointStore } from "../room-compiler/sqlite-checkpoint-store"
import type { CompileArtifact } from "../room-compiler/types"
import { StartupReconciler, runStartupReconcilerOnce } from "./startup-reconciler"
import { decideVerdict, reconcileWikiEvents } from "./wiki-event-reconciler"

function makeDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "startup-reconciler-test-"))
  const dbPath = path.join(dir, "test.sqlite")
  const { raw, close } = createDrizzleDb(dbPath)
  // drizzle wrapper for repo（repo 用 better-sqlite3 风格 drizzle，与 raw adapter 兼容）
  const drizzleDb = drizzleBetter(raw as any, { schema })
  return {
    raw,
    drizzle: drizzleDb,
    cleanup: () => {
      close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function makeWikiRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "startup-reconciler-wiki-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex")
}

function makeArtifact(opts: {
  cursorCommitSeq: number
  cursorMessageId: string
  viewfinderMd?: string
}): CompileArtifact {
  return {
    viewfinderMd: opts.viewfinderMd ?? `# v ${opts.cursorCommitSeq}`,
    decisionsMd: "# d",
    logMd: "# l",
    cursorCommitSeq: opts.cursorCommitSeq,
    cursorMessageId: opts.cursorMessageId,
    sealedCursorSeq: 0,
    threadSealId: null,
  }
}

// ─── decideVerdict pure decision table ─────────────────────────────

describe("decideVerdict · 决策表 6 组合", () => {
  it("file_hash == attemptedHash → committed_via_attempted", () => {
    assert.equal(
      decideVerdict({ attemptedHash: "A", baseHash: "B" }, "A"),
      "committed_via_attempted",
    )
  })

  it("file_hash == baseHash → aborted_clean", () => {
    assert.equal(decideVerdict({ attemptedHash: "A", baseHash: "B" }, "B"), "aborted_clean")
  })

  it("file_hash 不匹配两者 → aborted_dirty", () => {
    assert.equal(decideVerdict({ attemptedHash: "A", baseHash: "B" }, "C"), "aborted_dirty")
  })

  it("baseHash null + file 缺失 (fileHash null) → aborted_clean (新文件未生效)", () => {
    assert.equal(decideVerdict({ attemptedHash: "A", baseHash: null }, null), "aborted_clean")
  })

  it("baseHash null + file 存在且 hash == attempted → committed", () => {
    assert.equal(
      decideVerdict({ attemptedHash: "A", baseHash: null }, "A"),
      "committed_via_attempted",
    )
  })

  it("baseHash 'X' + file 缺失 → aborted_dirty (base 文件意外消失)", () => {
    assert.equal(decideVerdict({ attemptedHash: "A", baseHash: "X" }, null), "aborted_dirty")
  })

  it("attemptedHash null + file == base → aborted_clean", () => {
    assert.equal(decideVerdict({ attemptedHash: null, baseHash: "B" }, "B"), "aborted_clean")
  })

  it("attemptedHash null + file 不在 base → aborted_dirty", () => {
    assert.equal(decideVerdict({ attemptedHash: null, baseHash: "B" }, "C"), "aborted_dirty")
  })
})

// ─── reconcileWikiEvents DB + fs 集成 ──────────────────────────────

describe("reconcileWikiEvents · DB + fs 集成", () => {
  it("scenario: WRITE 后崩 → 文件已落 attempted hash → state='committed' + contentHash 写回", async () => {
    const { drizzle, cleanup: dbClean } = makeDb()
    const { root, cleanup: rootClean } = makeWikiRoot()
    try {
      const repo = new WikiEventsRepository(drizzle)
      const content = "# new wiki content"
      const attemptedHash = sha256(content)
      // PREPARE
      const ev = repo.appendPending({
        ts: "2026-05-12T01:00:00Z",
        alias: "黄仁勋",
        action: "write",
        path: "wiki/concepts/topic.md",
        baseHash: null,
        attemptedHash,
        fencingToken: "1",
        leaderTerm: "1",
      })
      // 模拟 WRITE 完成（atomic-rename 落盘）
      const abs = path.join(root, "wiki/concepts/topic.md")
      await fsAsync.mkdir(path.dirname(abs), { recursive: true })
      await fsAsync.writeFile(abs, content, "utf-8")
      // 但 COMMIT 没跑（崩了）
      assert.equal(repo.get(ev.id)?.state, "pending")

      const summary = await reconcileWikiEvents({ repo, wikiRoot: root })
      assert.equal(summary.scanned, 1)
      assert.equal(summary.committed, 1)
      assert.equal(summary.abortedClean, 0)
      assert.equal(summary.abortedDirty, 0)
      const after = repo.get(ev.id)
      assert.equal(after?.state, "committed")
      assert.equal(after?.contentHash, attemptedHash)
    } finally {
      rootClean()
      dbClean()
    }
  })

  it("scenario: PREPARE 后崩 (write 没跑) → file ENOENT + base null → aborted_clean", async () => {
    const { drizzle, cleanup: dbClean } = makeDb()
    const { root, cleanup: rootClean } = makeWikiRoot()
    try {
      const repo = new WikiEventsRepository(drizzle)
      const ev = repo.appendPending({
        ts: "2026-05-12T01:00:00Z",
        alias: "黄仁勋",
        action: "write",
        path: "wiki/concepts/never-written.md",
        baseHash: null,
        attemptedHash: sha256("would-be content"),
        fencingToken: "1",
        leaderTerm: "1",
      })
      // 文件不存在
      const summary = await reconcileWikiEvents({ repo, wikiRoot: root })
      assert.equal(summary.abortedClean, 1)
      const after = repo.get(ev.id)
      assert.equal(after?.state, "aborted")
      assert.equal(after?.reason, "clean_rollback")
    } finally {
      rootClean()
      dbClean()
    }
  })

  it("scenario: 第三方污染 → file_hash != attempted && != base → aborted_dirty + logger 告警 + 不动文件", async () => {
    const { drizzle, cleanup: dbClean } = makeDb()
    const { root, cleanup: rootClean } = makeWikiRoot()
    try {
      const repo = new WikiEventsRepository(drizzle)
      const baseContent = "# base content"
      const attemptedContent = "# new content"
      const ev = repo.appendPending({
        ts: "2026-05-12T01:00:00Z",
        alias: "黄仁勋",
        action: "patch",
        path: "wiki/concepts/topic.md",
        baseHash: sha256(baseContent),
        attemptedHash: sha256(attemptedContent),
        fencingToken: "1",
        leaderTerm: "1",
      })
      // 第三方写了完全不一样的东西
      const dirtyContent = "# someone else's content"
      const abs = path.join(root, "wiki/concepts/topic.md")
      await fsAsync.mkdir(path.dirname(abs), { recursive: true })
      await fsAsync.writeFile(abs, dirtyContent, "utf-8")

      const logged: string[] = []
      const summary = await reconcileWikiEvents({
        repo,
        wikiRoot: root,
        logger: (m) => logged.push(m),
      })
      assert.equal(summary.abortedDirty, 1)
      assert.ok(
        logged.some((m) => m.includes("DIRTY")),
        "logger 必须告警",
      )
      const after = repo.get(ev.id)
      assert.equal(after?.state, "aborted")
      assert.equal(after?.reason, "aborted_dirty")
      // 文件不应被改（不自动恢复 —— V16.5 chap 5）
      const stillThere = await fsAsync.readFile(abs, "utf-8")
      assert.equal(stillThere, dirtyContent, "reconciler 不应擅自恢复 dirty 文件")
    } finally {
      rootClean()
      dbClean()
    }
  })

  it("scenario: 已 settle (committed/aborted) 不在扫描范围 (getPending filter)", async () => {
    const { drizzle, cleanup: dbClean } = makeDb()
    const { root, cleanup: rootClean } = makeWikiRoot()
    try {
      const repo = new WikiEventsRepository(drizzle)
      const ev = repo.appendPending({
        ts: "2026-05-12T01:00:00Z",
        alias: "黄仁勋",
        action: "write",
        path: "wiki/x.md",
        attemptedHash: "X",
        fencingToken: "1",
        leaderTerm: "1",
      })
      repo.commit(ev.id, { contentHash: "X" })
      const summary = await reconcileWikiEvents({ repo, wikiRoot: root })
      assert.equal(summary.scanned, 0)
    } finally {
      rootClean()
      dbClean()
    }
  })

  it("scenario: 多 pending 行（committed + aborted_clean + aborted_dirty 各一）→ 计数正确", async () => {
    const { drizzle, cleanup: dbClean } = makeDb()
    const { root, cleanup: rootClean } = makeWikiRoot()
    try {
      const repo = new WikiEventsRepository(drizzle)
      // case 1: 已写 → committed
      const c1 = "# a"
      const e1 = repo.appendPending({
        ts: "2026-05-12T01:00:00Z",
        alias: "x",
        action: "write",
        path: "wiki/a.md",
        attemptedHash: sha256(c1),
        fencingToken: "1",
        leaderTerm: "1",
      })
      await fsAsync.mkdir(path.join(root, "wiki"), { recursive: true })
      await fsAsync.writeFile(path.join(root, "wiki/a.md"), c1)
      // case 2: 文件不存在 → aborted_clean (base null)
      const e2 = repo.appendPending({
        ts: "2026-05-12T01:00:01Z",
        alias: "x",
        action: "write",
        path: "wiki/b.md",
        attemptedHash: sha256("b"),
        fencingToken: "2",
        leaderTerm: "1",
      })
      // case 3: 第三方污染 → aborted_dirty
      const e3 = repo.appendPending({
        ts: "2026-05-12T01:00:02Z",
        alias: "x",
        action: "patch",
        path: "wiki/c.md",
        baseHash: sha256("c-base"),
        attemptedHash: sha256("c-new"),
        fencingToken: "3",
        leaderTerm: "1",
      })
      await fsAsync.writeFile(path.join(root, "wiki/c.md"), "# DIRTY")

      const summary = await reconcileWikiEvents({ repo, wikiRoot: root })
      assert.equal(summary.scanned, 3)
      assert.equal(summary.committed, 1)
      assert.equal(summary.abortedClean, 1)
      assert.equal(summary.abortedDirty, 1)
      assert.equal(repo.get(e1.id)?.state, "committed")
      assert.equal(repo.get(e2.id)?.state, "aborted")
      assert.equal(repo.get(e2.id)?.reason, "clean_rollback")
      assert.equal(repo.get(e3.id)?.state, "aborted")
      assert.equal(repo.get(e3.id)?.reason, "aborted_dirty")
    } finally {
      rootClean()
      dbClean()
    }
  })

  it("scenario: race - 行已被并发 settle 到 committed → noop_race_settled", async () => {
    const { drizzle, cleanup: dbClean } = makeDb()
    const { root, cleanup: rootClean } = makeWikiRoot()
    try {
      const repo = new WikiEventsRepository(drizzle)
      const content = "# x"
      const ev = repo.appendPending({
        ts: "2026-05-12T01:00:00Z",
        alias: "x",
        action: "write",
        path: "wiki/x.md",
        attemptedHash: sha256(content),
        fencingToken: "1",
        leaderTerm: "1",
      })
      await fsAsync.mkdir(path.join(root, "wiki"), { recursive: true })
      await fsAsync.writeFile(path.join(root, "wiki/x.md"), content)
      // 模拟 race：reconciler 还没动手，别处先 commit 了
      repo.commit(ev.id, { contentHash: sha256(content) })

      const summary = await reconcileWikiEvents({ repo, wikiRoot: root })
      assert.equal(summary.scanned, 0, "已 committed 不在 getPending() 列表")
    } finally {
      rootClean()
      dbClean()
    }
  })
})

// ─── 范-r1 P1-2 修：path containment（safeWikiPath 校验）────────────

describe("reconcileWikiEvents · 范-r1 P1-2 path containment", () => {
  it("event.path = '../../etc/passwd' (path traversal) → aborted_dirty + 不读外部文件", async () => {
    const { drizzle, cleanup: dbClean } = makeDb()
    const { root, cleanup: rootClean } = makeWikiRoot()
    try {
      const repo = new WikiEventsRepository(drizzle)
      const ev = repo.appendPending({
        ts: "2026-05-12T01:00:00Z",
        alias: "evil",
        action: "write",
        path: "wiki/../../etc/passwd",
        attemptedHash: sha256("malicious"),
        fencingToken: "1",
        leaderTerm: "1",
      })
      const summary = await reconcileWikiEvents({ repo, wikiRoot: root })
      assert.equal(summary.scanned, 1)
      assert.equal(summary.abortedDirty, 1, "path traversal 必须当 dirty 处理")
      const after = repo.get(ev.id)
      assert.equal(after?.state, "aborted")
      assert.equal(after?.reason, "aborted_dirty")
      assert.ok(after?.error?.includes("path"))
    } finally {
      rootClean()
      dbClean()
    }
  })

  it("event.path 不以 'wiki/' 开头 (namespace 外) → aborted_dirty", async () => {
    const { drizzle, cleanup: dbClean } = makeDb()
    const { root, cleanup: rootClean } = makeWikiRoot()
    try {
      const repo = new WikiEventsRepository(drizzle)
      const ev = repo.appendPending({
        ts: "2026-05-12T01:00:00Z",
        alias: "x",
        action: "write",
        path: "outside-wiki.md",
        attemptedHash: sha256("x"),
        fencingToken: "1",
        leaderTerm: "1",
      })
      const summary = await reconcileWikiEvents({ repo, wikiRoot: root })
      assert.equal(summary.abortedDirty, 1)
      const after = repo.get(ev.id)
      assert.equal(after?.reason, "aborted_dirty")
    } finally {
      rootClean()
      dbClean()
    }
  })

  it("dirty 行 settle 后再次 reconciler 跑 → scanned=0（getPending filter 不返已 settle 行）", async () => {
    const { drizzle, cleanup: dbClean } = makeDb()
    const { root, cleanup: rootClean } = makeWikiRoot()
    try {
      const repo = new WikiEventsRepository(drizzle)
      repo.appendPending({
        ts: "2026-05-12T01:00:00Z",
        alias: "x",
        action: "patch",
        path: "wiki/x.md",
        baseHash: sha256("base"),
        attemptedHash: sha256("attempted"),
        fencingToken: "1",
        leaderTerm: "1",
      })
      await fsAsync.mkdir(path.join(root, "wiki"), { recursive: true })
      await fsAsync.writeFile(path.join(root, "wiki/x.md"), "# DIRTY")

      const r1 = await reconcileWikiEvents({ repo, wikiRoot: root })
      assert.equal(r1.abortedDirty, 1)
      // 再跑一次：dirty 已 settle 到 aborted → getPending 不返
      const r2 = await reconcileWikiEvents({ repo, wikiRoot: root })
      assert.equal(r2.scanned, 0)
    } finally {
      rootClean()
      dbClean()
    }
  })

  it("dirty event 必须把 error 字段写进 wiki_events.error（持久化排错信息）", async () => {
    const { drizzle, cleanup: dbClean } = makeDb()
    const { root, cleanup: rootClean } = makeWikiRoot()
    try {
      const repo = new WikiEventsRepository(drizzle)
      const ev = repo.appendPending({
        ts: "2026-05-12T01:00:00Z",
        alias: "x",
        action: "patch",
        path: "wiki/x.md",
        baseHash: sha256("base"),
        attemptedHash: sha256("attempted"),
        fencingToken: "1",
        leaderTerm: "1",
      })
      await fsAsync.mkdir(path.join(root, "wiki"), { recursive: true })
      await fsAsync.writeFile(path.join(root, "wiki/x.md"), "# DIRTY")
      await reconcileWikiEvents({ repo, wikiRoot: root })
      const after = repo.get(ev.id)
      assert.equal(after?.reason, "aborted_dirty")
      assert.ok(after?.error, "error 字段必须有内容")
      assert.ok(after?.error?.includes("third-party"))
      assert.ok(after?.error?.includes("attempted="))
      assert.ok(after?.error?.includes("base="))
    } finally {
      rootClean()
      dbClean()
    }
  })
})

// ─── 范-r1 P1-3 修：CAS race noop_race_settled 真正测到 ──────────

describe("reconcileWikiEvents · 范-r1 P1-3 CAS race", () => {
  it("getPending 返回 row 后但 settle 之前别处先 commit → noop_race_settled 计数", async () => {
    const { drizzle, cleanup: dbClean } = makeDb()
    const { root, cleanup: rootClean } = makeWikiRoot()
    try {
      const repo = new WikiEventsRepository(drizzle)
      const content = "# x"
      const ev = repo.appendPending({
        ts: "2026-05-12T01:00:00Z",
        alias: "x",
        action: "write",
        path: "wiki/x.md",
        attemptedHash: sha256(content),
        fencingToken: "1",
        leaderTerm: "1",
      })
      await fsAsync.mkdir(path.join(root, "wiki"), { recursive: true })
      await fsAsync.writeFile(path.join(root, "wiki/x.md"), content)

      // 用 stub 模拟 race：getPending 仍返回 ev 行（pending 视图），
      // 但 commit/abort 都 false（说明并发 settle 已发生）
      const stubRepo = {
        getPending() {
          return [{ ...ev, state: "pending" as const }]
        },
        commit() {
          return false
        },
        abort() {
          return false
        },
        get(id: number) {
          return repo.get(id)
        },
      } as unknown as WikiEventsRepository

      const summary = await reconcileWikiEvents({ repo: stubRepo, wikiRoot: root })
      assert.equal(summary.scanned, 1)
      assert.equal(summary.committed, 0, "CAS false 不能算成 committed")
      assert.equal(summary.abortedClean, 0)
      assert.equal(summary.abortedDirty, 0)
      assert.equal(summary.noopRaceSettled, 1, "应该走 noop_race_settled 分支")
      assert.equal(summary.details[0].verdict, "noop_race_settled")
    } finally {
      rootClean()
      dbClean()
    }
  })
})

// ─── StartupReconciler 复合（wiki_events + room_checkpoints）──────────

describe("StartupReconciler · 复合 AC: kill -9 后重启状态恢复", () => {
  it("crash 后重启：wiki_events committed_via_attempted + room_checkpoint patched 同时发生 → 都恢复", async () => {
    const { raw, drizzle, cleanup: dbClean } = makeDb()
    const { root, cleanup: rootClean } = makeWikiRoot()
    try {
      const repo = new WikiEventsRepository(drizzle)
      const store = new SqliteCheckpointStore(raw)

      // —— 模拟 crash 前的状态 ——
      // (a) wiki_events: PREPARE + WRITE 完成，未 commit（state='pending'，文件已落 attempted hash）
      const wikiContent = "# wiki update"
      const ev = repo.appendPending({
        ts: "2026-05-12T01:00:00Z",
        alias: "范德彪",
        action: "write",
        path: "wiki/people/范德彪.md",
        attemptedHash: sha256(wikiContent),
        fencingToken: "1",
        leaderTerm: "1",
      })
      const wikiAbs = path.join(root, "wiki/people/范德彪.md")
      await fsAsync.mkdir(path.dirname(wikiAbs), { recursive: true })
      await fsAsync.writeFile(wikiAbs, wikiContent, "utf-8")

      // (b) room_checkpoints: PREPARE + WRITE 完成，未 commit
      const artifact = makeArtifact({
        cursorCommitSeq: 7,
        cursorMessageId: "m7",
        viewfinderMd: "# vf snapshot",
      })
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
      const roomDir = path.join(root, "rooms", "R1")
      await fsAsync.mkdir(roomDir, { recursive: true })
      await fsAsync.writeFile(path.join(roomDir, "viewfinder.md"), artifact.viewfinderMd)
      await fsAsync.writeFile(path.join(roomDir, "decisions.md"), artifact.decisionsMd)
      await fsAsync.writeFile(path.join(roomDir, "log.md"), artifact.logMd)

      // —— 重启：跑 reconciler ——
      const roomCompiler = new RoomCompiler({
        store,
        wikiRoot: root,
        leaderTerm: "2",
        fencingToken: "200",
        compileFn: () => artifact,
      })
      const logged: string[] = []
      const reconciler = new StartupReconciler({
        wikiEvents: repo,
        roomCompiler,
        wikiRoot: root,
        logger: (m) => logged.push(m),
      })
      const report = await reconciler.run(Date.parse("2026-05-12T02:00:00Z"))

      // wiki_events 恢复
      assert.equal(report.wikiEvents.scanned, 1)
      assert.equal(report.wikiEvents.committed, 1)
      assert.equal(repo.get(ev.id)?.state, "committed")
      // room_checkpoints 恢复
      assert.equal(report.roomCheckpoints.scanned, 1)
      assert.equal(report.roomCheckpoints.patched, 1)
      assert.ok(store.read("R1")?.committedAt)
      // 总报告
      assert.equal(report.alerts.abortedDirtyCount, 0)
      assert.ok(logged.some((m) => m.includes("[startup-reconciler] done")))
    } finally {
      rootClean()
      dbClean()
    }
  })

  it("crash 后重启：dirty wiki_events + room rollback → alerts 计数 + room 行被删", async () => {
    const { raw, drizzle, cleanup: dbClean } = makeDb()
    const { root, cleanup: rootClean } = makeWikiRoot()
    try {
      const repo = new WikiEventsRepository(drizzle)
      const store = new SqliteCheckpointStore(raw)

      // dirty wiki_events
      const ev = repo.appendPending({
        ts: "2026-05-12T01:00:00Z",
        alias: "x",
        action: "patch",
        path: "wiki/x.md",
        baseHash: sha256("base"),
        attemptedHash: sha256("attempted"),
        fencingToken: "1",
        leaderTerm: "1",
      })
      await fsAsync.mkdir(path.join(root, "wiki"), { recursive: true })
      await fsAsync.writeFile(path.join(root, "wiki/x.md"), "# DIRTY")

      // room_checkpoint with mismatched file → rollback
      store.prepare({
        roomId: "R2",
        cursorCommitSeq: 1,
        cursorMessageId: "m1",
        sealedCursorSeq: 0,
        viewfinderHash: sha256("expected"),
        decisionsHash: sha256("d"),
        logHash: sha256("l"),
        threadSealId: null,
        compiledAt: "2026-05-12T01:00:00.000Z",
        fencingToken: "1",
        leaderTerm: "1",
      })
      // 文件不写 → recover ENOENT → rollback

      const roomCompiler = new RoomCompiler({
        store,
        wikiRoot: root,
        leaderTerm: "2",
        fencingToken: "2",
        compileFn: () => makeArtifact({ cursorCommitSeq: 1, cursorMessageId: "m1" }),
      })
      const logged: string[] = []
      const reconciler = new StartupReconciler({
        wikiEvents: repo,
        roomCompiler,
        wikiRoot: root,
        logger: (m) => logged.push(m),
      })
      const report = await reconciler.run()

      assert.equal(report.wikiEvents.abortedDirty, 1)
      assert.equal(report.alerts.abortedDirtyCount, 1)
      assert.equal(repo.get(ev.id)?.state, "aborted")
      assert.equal(repo.get(ev.id)?.reason, "aborted_dirty")
      assert.ok(logged.some((m) => m.includes("DIRTY")))
      assert.equal(report.roomCheckpoints.rolledBack, 1)
      assert.equal(store.read("R2"), null)
    } finally {
      rootClean()
      dbClean()
    }
  })

  it("二次 run 幂等：第一次 patch + 第二次 scanned=0（重启重复执行安全）", async () => {
    const { raw, drizzle, cleanup: dbClean } = makeDb()
    const { root, cleanup: rootClean } = makeWikiRoot()
    try {
      const repo = new WikiEventsRepository(drizzle)
      const store = new SqliteCheckpointStore(raw)
      // pending wiki_events with file in place
      const content = "# x"
      const ev = repo.appendPending({
        ts: "2026-05-12T01:00:00Z",
        alias: "x",
        action: "write",
        path: "wiki/x.md",
        attemptedHash: sha256(content),
        fencingToken: "1",
        leaderTerm: "1",
      })
      await fsAsync.mkdir(path.join(root, "wiki"), { recursive: true })
      await fsAsync.writeFile(path.join(root, "wiki/x.md"), content)
      // pending checkpoint with all 3 files in place
      const a = makeArtifact({ cursorCommitSeq: 1, cursorMessageId: "m1", viewfinderMd: "# v" })
      store.prepare({
        roomId: "R1",
        cursorCommitSeq: 1,
        cursorMessageId: "m1",
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

      const roomCompiler = new RoomCompiler({
        store,
        wikiRoot: root,
        leaderTerm: "1",
        fencingToken: "1",
        compileFn: () => a,
      })
      const reconciler = new StartupReconciler({
        wikiEvents: repo,
        roomCompiler,
        wikiRoot: root,
      })
      const r1 = await reconciler.run()
      assert.equal(r1.wikiEvents.committed, 1)
      assert.equal(r1.roomCheckpoints.patched, 1)
      // 第二次 run：所有都 settle 了
      const r2 = await reconciler.run()
      assert.equal(r2.wikiEvents.scanned, 0, "wiki_events 已 settle 不再扫")
      assert.equal(r2.roomCheckpoints.scanned, 0, "checkpoints 已 commit 不在 listIncomplete")
      assert.equal(r2.alerts.abortedDirtyCount, 0)
      // 持久化状态：第一次结果保留
      assert.equal(repo.get(ev.id)?.state, "committed")
      assert.ok(store.read("R1")?.committedAt)
    } finally {
      rootClean()
      dbClean()
    }
  })

  it("范-r1 P1-1 wire helper · runStartupReconcilerOnce 等价于 new + run（caller 一行接入）", async () => {
    const { raw, drizzle, cleanup: dbClean } = makeDb()
    const { root, cleanup: rootClean } = makeWikiRoot()
    try {
      const repo = new WikiEventsRepository(drizzle)
      const store = new SqliteCheckpointStore(raw)
      const roomCompiler = new RoomCompiler({
        store,
        wikiRoot: root,
        leaderTerm: "1",
        fencingToken: "1",
        compileFn: () => makeArtifact({ cursorCommitSeq: 1, cursorMessageId: "m1" }),
      })
      const report = await runStartupReconcilerOnce({
        wikiEvents: repo,
        roomCompiler,
        wikiRoot: root,
      })
      assert.equal(report.wikiEvents.scanned, 0)
      assert.equal(report.roomCheckpoints.scanned, 0)
      assert.equal(report.alerts.abortedDirtyCount, 0)
      assert.ok(report.startedAt)
      assert.ok(report.finishedAt)
    } finally {
      rootClean()
      dbClean()
    }
  })

  it("空状态：无 pending wiki_events + 无 incomplete checkpoint → 都返 0，no alerts", async () => {
    const { raw, drizzle, cleanup: dbClean } = makeDb()
    const { root, cleanup: rootClean } = makeWikiRoot()
    try {
      const repo = new WikiEventsRepository(drizzle)
      const store = new SqliteCheckpointStore(raw)
      const roomCompiler = new RoomCompiler({
        store,
        wikiRoot: root,
        leaderTerm: "1",
        fencingToken: "1",
        compileFn: () => makeArtifact({ cursorCommitSeq: 1, cursorMessageId: "m1" }),
      })
      const reconciler = new StartupReconciler({
        wikiEvents: repo,
        roomCompiler,
        wikiRoot: root,
      })
      const report = await reconciler.run()
      assert.equal(report.wikiEvents.scanned, 0)
      assert.equal(report.roomCheckpoints.scanned, 0)
      assert.equal(report.alerts.abortedDirtyCount, 0)
    } finally {
      rootClean()
      dbClean()
    }
  })
})
