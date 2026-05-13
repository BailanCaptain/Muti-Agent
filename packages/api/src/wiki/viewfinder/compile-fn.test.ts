/**
 * F027 P12 · createViewfinderCompileFn E2E 测试
 * 真相源：docs/plans/V16.5-final.md chap 8 + chap 11
 *
 * E2E flow：
 *   1. 临时 SQLite + drizzle init + 插入 session_groups / threads / messages / a2a_calls
 *   2. 注入 stub HaikuDecisionJudge（不调真 Haiku）
 *   3. compileFn(input) → CompileArtifact
 *   4. 断言 viewfinder.md 含 6 段 + ledger 写入 + coverage 报告
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { createDrizzleDb } from "../../db/drizzle-instance"
import { createViewfinderCompileFn } from "./compile-fn"
import { DecisionLedger } from "./decision-ledger"
import type { BroadCandidate, DecisionJudgeProvider } from "./types"

function makeDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "compile-fn-test-"))
  const dbPath = path.join(dir, "test.sqlite")
  const { raw, close } = createDrizzleDb(dbPath)
  return {
    db: raw,
    cleanup: () => {
      close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

interface SeedOpts {
  roomId?: string
  sessionGroupId?: string
  title?: string
}

function seedRoom(
  db: ReturnType<typeof makeDb>["db"],
  opts: SeedOpts = {},
): { sessionGroupId: string; threadId: string; roomId: string } {
  const roomId = opts.roomId ?? "R-201"
  const sessionGroupId = opts.sessionGroupId ?? "sg-201"
  const title = opts.title ?? "F026-A2A 设计重新对"
  const now = "2026-05-13T10:00:00Z"
  db.prepare(`
    INSERT INTO session_groups (id, title, created_at, updated_at, room_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionGroupId, title, now, now, roomId)
  const threadId = `t-${roomId}-1`
  db.prepare(`
    INSERT INTO threads (id, session_group_id, provider, alias, updated_at)
    VALUES (?, ?, 'claude', '黄仁勋', ?)
  `).run(threadId, sessionGroupId, now)
  return { sessionGroupId, threadId, roomId }
}

function insertMessage(
  db: ReturnType<typeof makeDb>["db"],
  opts: {
    id: string
    threadId: string
    role: "user" | "assistant"
    content: string
    createdAt: string
  },
): void {
  db.prepare(`
    INSERT INTO messages (id, thread_id, role, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(opts.id, opts.threadId, opts.role, opts.content, opts.createdAt)
}

function insertCall(
  db: ReturnType<typeof makeDb>["db"],
  opts: {
    callId: string
    sessionGroupId: string
    status: string
    deadlineAt: string
    issuer?: string
  },
): void {
  db.prepare(`
    INSERT INTO a2a_calls (
      call_id, root_call_id, issuer_id, convener_id, reply_to,
      deadline_at, status, session_group_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.callId,
    opts.callId,
    opts.issuer ?? "user",
    "黄仁勋",
    "user",
    opts.deadlineAt,
    opts.status,
    opts.sessionGroupId,
    opts.deadlineAt,
    opts.deadlineAt,
  )
}

/** stub judge：根据 candidate.matchedKeyword 模拟 Haiku 行为 */
const stubJudge: DecisionJudgeProvider = {
  async judge({ candidate }) {
    if (candidate.content.includes("必须闭环") || candidate.content.includes("改ADR")) {
      return {
        isDecision: true,
        type: "pivot",
        content: "改 ADR 不改实现，今天必须闭环",
        confidence: 0.95,
      }
    }
    if (candidate.content.includes("F026") && candidate.content.includes("做完")) {
      return {
        isDecision: true,
        type: "commit",
        content: "F026 做完，进 merger-gate",
        confidence: 0.9,
      }
    }
    if (candidate.content === "@黄仁勋 go") {
      return { isDecision: true, type: "commit", content: "批准上一步动作", confidence: 0.7 }
    }
    if (candidate.content === "@黄仁勋 A") {
      return { isDecision: true, type: "spec", content: "选 A 路径", confidence: 0.8 }
    }
    if (candidate.content.includes("不用管")) {
      return { isDecision: true, type: "reject", content: "跳过 review", confidence: 0.8 }
    }
    return { isDecision: false, reason: "stub: not a decision" }
  },
}

// ─── E2E 测试 ────────────────────────────────────────────────────────

describe("createViewfinderCompileFn · E2E happy path (R-201 真实场景)", () => {
  it("messages → extractor → ledger → renderer → CompileArtifact", async () => {
    const { db, cleanup } = makeDb()
    try {
      const { sessionGroupId, threadId, roomId } = seedRoom(db)
      // 模拟 R-201 5/8 真实场景子集
      insertMessage(db, {
        id: "m-1",
        threadId,
        role: "user",
        content: "@黄仁勋 F026我们做完了，我们现在进merger-gate",
        createdAt: "2026-05-08T06:00:00Z",
      })
      insertMessage(db, {
        id: "m-2",
        threadId,
        role: "assistant",
        content: "## 答：还没合 · 卡在两件事...",
        createdAt: "2026-05-08T06:01:00Z",
      })
      insertMessage(db, {
        id: "m-3",
        threadId,
        role: "user",
        content: "@黄仁勋 改ADR 不改实现！ 必须闭环",
        createdAt: "2026-05-08T07:00:00Z",
      })
      insertMessage(db, {
        id: "m-4",
        threadId,
        role: "assistant",
        content: "✅ 阻塞 1 收尾。",
        createdAt: "2026-05-08T07:01:00Z",
      })
      insertMessage(db, {
        id: "m-5",
        threadId,
        role: "user",
        content: "@黄仁勋 go",
        createdAt: "2026-05-08T08:00:00Z",
      })
      // 加 1 个 fresh blocker call
      insertCall(db, {
        callId: "call-fresh-abc",
        sessionGroupId,
        status: "pending",
        deadlineAt: "2026-05-13T15:00:00Z",
      })
      // 加 1 个 stale blocker（5 天前 — B024 兜底必须过滤掉）
      insertCall(db, {
        callId: "call-stale-xyz",
        sessionGroupId,
        status: "pending",
        deadlineAt: "2026-05-08T09:00:00Z",
      })

      const ledger = new DecisionLedger(db, () => "2026-05-13T10:00:00Z")
      const compileFn = createViewfinderCompileFn({
        db,
        ledger,
        judge: stubJudge,
        fencingToken: "leader-1",
        leaderTerm: "term-1",
        nowFn: () => "2026-05-13T14:30:00Z",
      })

      const result = await compileFn({
        roomId,
        prevCheckpoint: null,
        newMessages: [
          { seq: 1, messageId: "m-1", committedAt: "2026-05-08T06:00:00Z", role: "user" },
          { seq: 2, messageId: "m-3", committedAt: "2026-05-08T07:00:00Z", role: "user" },
          { seq: 3, messageId: "m-5", committedAt: "2026-05-08T08:00:00Z", role: "user" },
        ],
        newSeals: [],
      })

      // ─── viewfinder.md 断言 ─────────────────────────
      assert.match(result.viewfinderMd, /viewfinder_id: vf_R-201_2026-05-13-14-30/)
      assert.match(result.viewfinderMd, /# R-201 Viewfinder/)

      // §3 应该含 commit 类决策（F026 进 merger-gate / 批准上一步）
      const section3 = result.viewfinderMd.split("## 3. 下一步")[1]?.split("##")[0] ?? ""
      assert.match(
        section3,
        /merger-gate|批准上一步动作/,
        `§3 应含 commit 决策，actual:\n${section3}`,
      )

      // §4 含 fresh call，不含 stale call (B024 兜底)
      const section4 = result.viewfinderMd.split("## 4. 等谁")[1]?.split("##")[0] ?? ""
      assert.match(section4, /call-fresh-ab/, "fresh call 短码渲染")
      assert.doesNotMatch(section4, /call-stale-xy/, "B024: stale 5 天前 call 必须被过滤")

      // §5 含至少 3 个决策
      const section5 = result.viewfinderMd.split("## 5. 关键决策")[1]?.split("##")[0] ?? ""
      const decisionCount = (section5.match(/^- D-\d+/gm) ?? []).length
      assert.ok(decisionCount >= 3, `§5 应含至少 3 个决策，actual=${decisionCount}`)

      // ─── decisions.md 断言（dump active ledger）────
      assert.match(result.decisionsMd, /R-201 Decisions Ledger/)
      assert.match(result.decisionsMd, /D-\d+ · pivot/, "应有 pivot 类决策（改 ADR）")
      assert.match(result.decisionsMd, /D-\d+ · commit/, "应有 commit 类决策（F026 做完）")

      // ─── log.md 断言（编译审计） ───────────────────
      assert.match(result.logMd, /R-201 Compile Log/)
      assert.match(result.logMd, /broad_candidates: 3/, "宽召 3 条")
      assert.match(result.logMd, /written_decisions: 3/, "全部写入")
      assert.match(result.logMd, /coverage:.*100%/)

      // ─── cursor 推进断言 ──────────────────────────
      assert.equal(result.cursorMessageId, "m-5", "cursor 推到最新一条")
      assert.equal(result.cursorCommitSeq, 3)
    } finally {
      cleanup()
    }
  })

  it("空 newMessages → viewfinder 仍能渲染（fallback session_groups.title）", async () => {
    const { db, cleanup } = makeDb()
    try {
      const { roomId } = seedRoom(db, {
        roomId: "R-202",
        sessionGroupId: "sg-202",
        title: "Q-身份认知",
      })
      const ledger = new DecisionLedger(db)
      const compileFn = createViewfinderCompileFn({
        db,
        ledger,
        judge: stubJudge,
        fencingToken: "leader-1",
        leaderTerm: "term-1",
        nowFn: () => "2026-05-13T14:30:00Z",
      })

      const result = await compileFn({
        roomId,
        prevCheckpoint: null,
        newMessages: [],
        newSeals: [],
      })

      // §1 fallback 到 session_groups.title
      const section1 = result.viewfinderMd.split("## 1. 当前主题")[1]?.split("##")[0] ?? ""
      assert.match(section1, /Q-身份认知.*fallback/)

      // log.md 应反映 0 candidates
      assert.match(result.logMd, /broad_candidates: 0/)
      assert.match(result.logMd, /coverage: unknown/, "broad=0 → coverage=unknown")

      // 无 newMessages → cursor 不推进
      assert.equal(result.cursorMessageId, "")
      assert.equal(result.cursorCommitSeq, 0)
    } finally {
      cleanup()
    }
  })

  it("Haiku 失败的 candidate 落 unresolved，不阻塞 viewfinder + 触发 coverage warn", async () => {
    const { db, cleanup } = makeDb()
    try {
      const { threadId, roomId } = seedRoom(db, { roomId: "R-203", sessionGroupId: "sg-203" })
      // 5 条 user message 全是 "go"，stub judge 全部抛错
      for (let i = 1; i <= 5; i++) {
        insertMessage(db, {
          id: `m-${i}`,
          threadId,
          role: "user",
          content: "@黄仁勋 go",
          createdAt: `2026-05-08T0${i}:00:00Z`,
        })
      }
      const flakyJudge: DecisionJudgeProvider = {
        async judge() {
          throw new Error("haiku-failed: timeout")
        },
      }
      const ledger = new DecisionLedger(db)
      const compileFn = createViewfinderCompileFn({
        db,
        ledger,
        judge: flakyJudge,
        fencingToken: "leader-1",
        leaderTerm: "term-1",
        nowFn: () => "2026-05-13T14:30:00Z",
      })
      const result = await compileFn({
        roomId,
        prevCheckpoint: null,
        newMessages: Array.from({ length: 5 }, (_, i) => ({
          seq: i + 1,
          messageId: `m-${i + 1}`,
          committedAt: `2026-05-08T0${i + 1}:00:00Z`,
          role: "user" as const,
        })),
        newSeals: [],
      })

      // viewfinder 仍渲染
      assert.match(result.viewfinderMd, /# R-203 Viewfinder/)
      // coverage = 0/5 → warn
      assert.match(result.viewfinderMd, /coverage_status: warn/)
      assert.match(result.viewfinderMd, /⚠️ Coverage \*\*warn\*\*/)
      // 无决策入 ledger
      assert.match(result.logMd, /written_decisions: 0/)
      assert.match(result.logMd, /haiku-failed/, "log 应反映 Haiku 失败原因")
    } finally {
      cleanup()
    }
  })

  it("prevCheckpoint 存在 → cursor 从 checkpoint 接力", async () => {
    const { db, cleanup } = makeDb()
    try {
      const { threadId, roomId } = seedRoom(db, { roomId: "R-204", sessionGroupId: "sg-204" })
      insertMessage(db, {
        id: "m-100",
        threadId,
        role: "user",
        content: "ping",
        createdAt: "2026-05-08T05:00:00Z",
      })
      const ledger = new DecisionLedger(db)
      const compileFn = createViewfinderCompileFn({
        db,
        ledger,
        judge: stubJudge,
        fencingToken: "leader-1",
        leaderTerm: "term-1",
        nowFn: () => "2026-05-13T14:30:00Z",
      })
      const result = await compileFn({
        roomId,
        prevCheckpoint: {
          roomId,
          cursorCommitSeq: 99,
          cursorMessageId: "m-99-old",
          sealedCursorSeq: 0,
          viewfinderHash: "x",
          decisionsHash: "y",
          logHash: "z",
          threadSealId: null,
          compiledAt: "2026-05-12T00:00:00Z",
          committedAt: "2026-05-12T00:00:00Z",
          fencingToken: "leader-1",
          leaderTerm: "term-1",
        },
        newMessages: [],
        newSeals: [],
      })
      // 没新消息 → cursor 保持 prevCheckpoint
      assert.equal(result.cursorMessageId, "m-99-old")
      assert.equal(result.cursorCommitSeq, 99)
      // viewfinder 含 last_committed_cursor 引用
      assert.match(result.viewfinderMd, /last_committed_cursor: m-99-old/)
    } finally {
      cleanup()
    }
  })
})
