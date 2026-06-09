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
import {
  createViewfinderCompileFn,
  defaultPhaseInfoQuerier,
  extractFeatureIds,
  parseFeatureProgress,
  parseSubjectToPhaseInfo,
  readFeatureProgress,
  safeGitLogSubjects,
} from "./compile-fn"
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
        // 站会式 §3（2026-05-31 拍 A）：注入 null 隔离磁盘 feature.md，测 fallback 路径
        featureProgressQuerier: () => null,
        topicQuerier: () => null,
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

      // §3 站会式（2026-05-31 拍 A）：无 featureProgress → 退最新 spec/pivot 方向（pivot 改 ADR），
      // 绝不取 commit（merger-gate 是已完成，归 §2）
      const section3 = result.viewfinderMd.split("## 3. 下一步")[1]?.split("##")[0] ?? ""
      assert.match(section3, /改 ADR/, `§3 应退 pivot 方向决策，actual:\n${section3}`)
      assert.doesNotMatch(section3, /merger-gate/, "§3 不取 commit（已完成归 §2）")

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
        // 站会式 §3（2026-05-31 拍 A）：注入 null 隔离磁盘 feature.md，测 fallback 路径
        featureProgressQuerier: () => null,
        topicQuerier: () => null,
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

  it("P4 C-auto-2: LLM 判 supersedes 自动 sweep — §3 不再显示已完成 commit", async () => {
    const { db, cleanup } = makeDb()
    try {
      const { sessionGroupId, threadId, roomId } = seedRoom(db, {
        roomId: "R-P4-sweep",
        sessionGroupId: "sg-p4",
      })
      void sessionGroupId

      // Step 1: 模拟之前已有的 active commit "进 merger-gate"
      insertMessage(db, {
        id: "m-old",
        threadId,
        role: "user",
        content: "@黄仁勋 F026 我们做完了，进 merger-gate",
        createdAt: "2026-05-08T06:07:00Z",
      })

      // 注入 stub judge 阶段 1: 把 m-old 判成 commit "进 merger-gate"，不 supersede
      const stubJudge1: DecisionJudgeProvider = {
        async judge({ candidate }) {
          if (candidate.messageId === "m-old") {
            return { isDecision: true, type: "commit", content: "进 merger-gate" }
          }
          return { isDecision: false, reason: "stub" }
        },
      }
      const ledger = new DecisionLedger(db, () => "2026-05-13T09:00:00Z")
      const compile1 = createViewfinderCompileFn({
        db,
        ledger,
        judge: stubJudge1,
        fencingToken: "leader-1",
        leaderTerm: "term-1",
        nowFn: () => "2026-05-13T09:00:00Z",
        featureProgressQuerier: () => null,
        topicQuerier: () => null,
      })
      const r1 = await compile1({
        roomId,
        prevCheckpoint: null,
        newMessages: [
          { seq: 1, messageId: "m-old", committedAt: "2026-05-08T06:07:00Z", role: "user" },
        ],
        newSeals: [],
      })
      // 验证 step 1: 站会式 §3 不取 commit（merger-gate 归 §2 已完成）；无 spec/pivot → 待定。
      // 本测核心是 ledger sweep（step 2 末尾），§3 内容非本测重点
      const r1Section3 = r1.viewfinderMd.split("## 3. 下一步")[1]?.split("##")[0] ?? ""
      assert.doesNotMatch(r1Section3, /进 merger-gate/, "Step 1: §3 不取 commit（已完成归 §2）")
      // §2 已完成列表仍含该 commit（in-flight/已完成的承诺在 §2 呈现）
      const r1Section2 = r1.viewfinderMd.split("## 2. 当前进度")[1]?.split("## 3")[0] ?? ""
      assert.match(r1Section2, /进 merger-gate/, "Step 1: commit 归 §2 已完成列表")

      // Step 2: 新 message "F026 已合 dev" → stub judge 判 supersedes [D-1]
      insertMessage(db, {
        id: "m-new",
        threadId,
        role: "user",
        content: "@黄仁勋 F026 已合 dev，stash 也清了",
        createdAt: "2026-05-13T08:30:00Z",
      })
      const stubJudge2: DecisionJudgeProvider = {
        async judge({ candidate, activeCommits }) {
          if (candidate.messageId === "m-new") {
            // 模拟 Sonnet 判：本次完成了 D-1 "进 merger-gate"
            const supersedesIds = activeCommits?.map((c) => c.decisionId) ?? []
            return {
              isDecision: true,
              type: "commit",
              content: "F026 + stash 收尾完成",
              supersedesDecisionIds: supersedesIds,
            }
          }
          return { isDecision: false, reason: "stub" }
        },
      }
      const compile2 = createViewfinderCompileFn({
        db,
        ledger,
        judge: stubJudge2,
        fencingToken: "leader-1",
        leaderTerm: "term-1",
        nowFn: () => "2026-05-13T09:30:00Z",
        featureProgressQuerier: () => null,
        topicQuerier: () => null,
      })
      const r2 = await compile2({
        roomId,
        prevCheckpoint: null,
        newMessages: [
          { seq: 2, messageId: "m-new", committedAt: "2026-05-13T08:30:00Z", role: "user" },
        ],
        newSeals: [],
      })

      // 验证 step 2: 站会式 §3 不取任何 commit；新 commit "收尾完成" 归 §2 已完成列表，
      // 旧 commit "进 merger-gate" 被 sweep 后从 §2 active 列表消失（P4 sweep 真效果）
      const r2Section3 = r2.viewfinderMd.split("## 3. 下一步")[1]?.split("##")[0] ?? ""
      assert.doesNotMatch(r2Section3, /收尾完成|进 merger-gate/, "Step 2: §3 不取 commit")
      const r2Section2 = r2.viewfinderMd.split("## 2. 当前进度")[1]?.split("## 3")[0] ?? ""
      assert.match(r2Section2, /F026.*收尾完成/, "Step 2: 新 commit 归 §2 已完成")
      assert.doesNotMatch(
        r2Section2,
        /进 merger-gate/,
        "Step 2: §2 已完成列表不含已 sweep 的旧 commit（P4 修好）",
      )

      // 验证 ledger: 旧 commit status='completed'
      const activeCommits = ledger.getActiveByType(roomId, "commit")
      assert.equal(activeCommits.length, 1, "只剩 1 个 active commit（旧的被 sweep）")
      assert.match(activeCommits[0].content, /收尾完成/)

      // 验证 log.md 含 swept_decisions
      assert.match(r2.logMd, /swept_decisions: 1/, "compile log 反映 P4 sweep 数量")
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
        // 站会式 §3（2026-05-31 拍 A）：注入 null 隔离磁盘 feature.md，测 fallback 路径
        featureProgressQuerier: () => null,
        topicQuerier: () => null,
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

// ─── P12.b r2 范-r1 P2-1 + P2-2 修：parser + multi-commits 单元测试 ─────

describe("featureProgress 站会式 §2/§3（小孙 2026-05-31 拍 A）", () => {
  const SAMPLE = [
    "# F027",
    "## Acceptance Criteria",
    "- [x] **AC-P1-1 · 4 张新表 schema**：建表 + 索引",
    "- [x] **AC-P1-2 · update_wiki ACL**：fuzz 100 并发",
    "- [ ] **AC-P3-1 · StatusPanel 拖宽**（性能阈值锁定）：360-1200px",
    "- [ ] **AC-P3-2 · 5 个 tab 全部渲染**：状态保持",
    "其他不是 AC 的行 - [ ] 普通 todo",
  ].join("\n")

  it("parse: 数 checkbox → total/done/pct + 第一条未勾", () => {
    const p = parseFeatureProgress("F027", SAMPLE)
    assert.ok(p)
    assert.equal(p?.total, 4)
    assert.equal(p?.done, 2)
    assert.equal(p?.pct, 50)
    assert.equal(p?.firstUndoneAC?.id, "AC-P3-1")
    assert.match(p?.firstUndoneAC?.title ?? "", /StatusPanel 拖宽/)
  })

  it("parse: 普通 - [ ] todo 行不算 AC（只认 **AC-P 模式）", () => {
    const p = parseFeatureProgress("F027", "- [ ] 普通 todo\n- [ ] 另一个")
    assert.equal(p, null)
  })

  it("parse: 全勾完 → firstUndoneAC=null pct=100", () => {
    const p = parseFeatureProgress("F027", "- [x] **AC-P1-1 · a**\n- [x] **AC-P1-2 · b**")
    assert.equal(p?.pct, 100)
    assert.equal(p?.firstUndoneAC, null)
  })

  it("parse: 无 AC 行 → null", () => {
    assert.equal(parseFeatureProgress("F027", "# 没有 AC 的文档"), null)
  })

  it("extractFeatureIds: 扫消息 F/B id 去重", () => {
    const ids = extractFeatureIds([
      {
        messageId: "m1",
        threadId: "t1",
        authorAlias: "小孙",
        role: "user",
        content: "搞 F027 和 B023",
        createdAt: "2026-05-31T00:00:00Z",
      },
      {
        messageId: "m2",
        threadId: "t1",
        authorAlias: "黄",
        role: "user",
        content: "继续 F027",
        createdAt: "2026-05-31T00:00:01Z",
      },
    ])
    assert.deepEqual([...ids].sort(), ["B023", "F027"])
  })

  // codex P2-1 修：recency 降序（最新房间主题排首），防房间从 F026 转 F027 错读旧 F026
  it("extractFeatureIds: recency 降序 — 房间从 F026 转 F027 取最新 F027", () => {
    const msg = (id: string, content: string, ts: string) => ({
      messageId: id,
      threadId: "t1",
      authorAlias: "小孙",
      role: "user" as const,
      content,
      createdAt: ts,
    })
    // recentMessages 时间正序（caller 已 chronological）：早 F026，晚 F027
    const ids = extractFeatureIds([
      msg("m1", "立项 F026 A2A", "2026-05-20T00:00:00Z"),
      msg("m2", "F026 做完了", "2026-05-21T00:00:00Z"),
      msg("m3", "现在转 F027 统一记忆", "2026-05-31T00:00:00Z"),
    ])
    assert.equal(ids[0], "F027", "最新提及的 F027 排首（querier 取首个 = 当前主题）")
    assert.deepEqual(ids, ["F027", "F026"])
  })

  it("extractFeatureIds: 3 位起过滤 — F5/B12/F1 闲聊不误抓", () => {
    const ids = extractFeatureIds([
      {
        messageId: "m1",
        threadId: "t1",
        authorAlias: "小孙",
        role: "user" as const,
        content: "按 F5 刷新，吃 B12 维生素，挂 F1 档，做 F027",
        createdAt: "2026-05-31T00:00:00Z",
      },
    ])
    assert.deepEqual(ids, ["F027"], "只抓 3 位起的真 feature id")
  })

  it("parse: 分隔符放宽 — `·`/`:`/`：`/`-` 都识别（codex P3-4）", () => {
    const content = [
      "- [x] **AC-P1-1 · 中点分隔**",
      "- [x] **AC-P1-2: 半角冒号**",
      "- [ ] **AC-P1-3：全角冒号**",
      "- [ ] **AC-P1-4 - 连字符**",
    ].join("\n")
    const p = parseFeatureProgress("F027", content)
    assert.equal(p?.total, 4, "4 种分隔符全计入 total（不漏计 → % 不虚高）")
    assert.equal(p?.done, 2)
    assert.equal(p?.firstUndoneAC?.id, "AC-P1-3")
  })

  // codex P2-2 re-review 修：硬锁真实 worktree F027 feature.md 生产行为。
  // 原版锁 done=0/AC-P1-1（防虚勾）——2026-06-10 小孙开始真实验收勾选（dev 68cdd6b），
  // 该锁按设计触发，历史使命完成。现改锁**解析不变量**（done 随小孙验收进度活动，
  // 锁死具体值 = 小孙每勾一个炸一次 suite）：
  //   - total=39（分隔符漏计会变小 → % 虚高，仍是硬锁）
  //   - done/pct/firstUndoneAC 三者自洽（解析口径不漂）
  it("readFeatureProgress: 真实 worktree F027 feature.md — total=39 硬锁 + done/pct/firstUndone 自洽（生产行为）", () => {
    const p = readFeatureProgress("F027", process.cwd())
    assert.ok(p, "能读到 F027 feature.md")
    assert.equal(p?.featureId, "F027")
    assert.equal(p?.total, 39, "worktree F027 共 39 条 AC（分隔符漏计会变小）")
    assert.ok(p!.done >= 0 && p!.done <= 39, `done 必须在 [0,39]（实际 ${p!.done}）`)
    assert.equal(p?.pct, Math.round((p!.done / 39) * 100), "pct 与 done 自洽")
    if (p!.done < 39) {
      assert.match(p?.firstUndoneAC?.id ?? "", /^AC-P\d/, "未勾完 → firstUndoneAC 必有且格式合法")
    } else {
      assert.equal(p?.firstUndoneAC, null, "全勾 → firstUndoneAC=null")
    }
  })
})

describe("P12.b parseSubjectToPhaseInfo (r2 范-r1 P2-2 Day range 后端)", () => {
  it("Day 9-10 → 取后端 10", () => {
    const info = parseSubjectToPhaseInfo(
      "abc1234",
      "feat(F027-P20): Phase 3 Week 2 Day 9-10 — ingest commit endpoint (AC-P3-10)",
      "F027",
    )
    assert.ok(info, "应该 parse 成功")
    assert.equal(info?.day, 10, "Day range 取后端")
    assert.equal(info?.phase, 3)
    assert.equal(info?.week, 2)
    assert.deepEqual(info?.acs, ["AC-P3-10"])
  })

  it("Day 11 单值 → 11", () => {
    const info = parseSubjectToPhaseInfo(
      "def5678",
      "feat(F027-P20): Phase 3 Week 3 Day 11 — StatusPanel 拖宽 (AC-P3-1)",
      "F027",
    )
    assert.equal(info?.day, 11)
  })

  it("Day 11-15 跨周 → 15", () => {
    const info = parseSubjectToPhaseInfo(
      "xyz9999",
      "feat(F027-P20): Phase 3 Week 3 Day 11-15 — frontend skeleton",
      "F027",
    )
    assert.equal(info?.day, 15)
  })

  it("subject 不含 featureId → null (防误抓)", () => {
    const info = parseSubjectToPhaseInfo(
      "abc1234",
      "feat(F026): Phase 3 Day 10",
      "F027", // F026 commit 不能算 F027
    )
    assert.equal(info, null)
  })

  it("subject 不含 Phase/Day/AC → null (HEAD 自身场景 P2-1 触发点)", () => {
    const info = parseSubjectToPhaseInfo(
      "57a88ab",
      "feat(F027-P12.b): viewfinder 6 段语义二轮打磨 — §2/§4/§6 收口",
      "F027",
    )
    // P12.b 自己 commit subject 不含 Phase/Day/AC → null，触发 multi-commits 回溯
    assert.equal(info, null)
  })

  it("只有 AC 没有 Phase/Day → 仍 parse（acs 非空）", () => {
    const info = parseSubjectToPhaseInfo("abc", "fix(F027): AC-P3-9 b lint warning", "F027")
    assert.ok(info)
    assert.deepEqual(info?.acs, ["AC-P3-9"])
    assert.equal(info?.day, undefined)
    assert.equal(info?.phase, undefined)
  })

  it("多 AC → 全部 capture", () => {
    const info = parseSubjectToPhaseInfo(
      "abc",
      "feat(F027): Week 2 — AC-P3-8 + AC-P3-9 + AC-P3-10 整合",
      "F027",
    )
    assert.deepEqual(info?.acs, ["AC-P3-8", "AC-P3-9", "AC-P3-10"])
  })
})

describe("P12.b safeGitLogSubjects (r2 范-r1 P2-1 multi-commits)", () => {
  it("git 不可用 / 命令失败 → 返 [] (fallback null 路径)", () => {
    // 不存在的 cwd → spawn 行为：ENOENT or status != 0
    const results = safeGitLogSubjects("F027", {
      cwd: "/nonexistent/path/that/should/not/exist",
      timeoutMs: 1000,
    })
    assert.deepEqual(results, [], "无 cwd → 静默 fallback []")
  })

  it("真 git log 跑通：拿当前 worktree F027 commits（smoke test）", () => {
    // 用 process.cwd() 跑真 git log（worktree 内 F027 提交多）
    const results = safeGitLogSubjects("F027", {
      cwd: process.cwd(),
      timeoutMs: 5000,
      limit: 5,
    })
    // 至少能拿到 F027 commits（在 F027 worktree 跑测试时）
    assert.ok(results.length > 0, "F027 worktree 内应能 grep 到 F027 commits")
    // 每条都有 shortSha + message
    for (const r of results) {
      assert.match(r.shortSha, /^[0-9a-f]{7,}$/, "shortSha 是 hex")
      assert.ok(r.message.length > 0, "message 非空")
    }
  })
})

describe("P12.b defaultPhaseInfoQuerier (r2 范-r1 P2-1 回溯找首个可 parse)", () => {
  it("recentMessages 含 F027 → 回溯跳过非 Phase HEAD，找首个含 Phase 的 commit", () => {
    const querier = defaultPhaseInfoQuerier(
      {
        // biome-ignore lint/suspicious/noExplicitAny: test deps stub
        db: null as any,
        // biome-ignore lint/suspicious/noExplicitAny: test deps stub
        ledger: null as any,
        // biome-ignore lint/suspicious/noExplicitAny: test deps stub
        judge: null as any,
        fencingToken: "x",
        leaderTerm: "x",
        rootDir: process.cwd(),
        gitTimeoutMs: 5000,
      },
      // 注入确定性 git stub：HEAD（非 Phase）应被跳过 → 回溯到含 Phase 的更早 commit。
      // 不依赖 live git 历史（否则后续 F027 commit 累积会把含 Phase 的 commit 挤出 -30 窗口致漂移性
      // flaky —— 本次会话 4 个 feat/fix(F027) commit 就触发过）；真 git 集成由上方 smoke test 覆盖。
      () => [
        { shortSha: "aaaaaaa", message: "fix(F027): 近期非 Phase commit（应跳过）" },
        { shortSha: "694fcc1", message: "feat(F027): Phase 3 Week 2 Day 10 viewfinder compile" },
      ],
    )
    const info = querier(
      [
        {
          messageId: "m1",
          threadId: "t1",
          authorAlias: "小孙",
          role: "user",
          content: "F027 Phase 3 Week 2 Day 10 开搞",
          createdAt: "2026-05-22T00:00:00Z",
        },
      ],
      "2026-05-22T00:00:00Z",
    )
    // HEAD 非 Phase commit 跳过 → 回溯命中 694fcc1（含 Phase 3 Week 2 Day 10）
    assert.ok(info, "回溯应找到至少一个可 parse 的 F027 commit")
    assert.equal(info?.featureId, "F027")
    assert.ok(info?.phase !== undefined || info?.day !== undefined || (info?.acs?.length ?? 0) > 0)
  })

  it("recentMessages 无 feature ID → 返 null", () => {
    const querier = defaultPhaseInfoQuerier({
      // biome-ignore lint/suspicious/noExplicitAny: test deps stub
      db: null as any,
      // biome-ignore lint/suspicious/noExplicitAny: test deps stub
      ledger: null as any,
      // biome-ignore lint/suspicious/noExplicitAny: test deps stub
      judge: null as any,
      fencingToken: "x",
      leaderTerm: "x",
      rootDir: process.cwd(),
    })
    const info = querier(
      [
        {
          messageId: "m1",
          threadId: "t1",
          authorAlias: "小孙",
          role: "user",
          content: "闲聊，今天天气不错",
          createdAt: "t",
        },
      ],
      "t",
    )
    assert.equal(info, null)
  })

  it("rootDir 不存在 → 返 null (spawn 失败优雅降级)", () => {
    const querier = defaultPhaseInfoQuerier({
      // biome-ignore lint/suspicious/noExplicitAny: test deps stub
      db: null as any,
      // biome-ignore lint/suspicious/noExplicitAny: test deps stub
      ledger: null as any,
      // biome-ignore lint/suspicious/noExplicitAny: test deps stub
      judge: null as any,
      fencingToken: "x",
      leaderTerm: "x",
      rootDir: "/nonexistent/cwd",
      gitTimeoutMs: 1000,
    })
    const info = querier(
      [
        {
          messageId: "m1",
          threadId: "t1",
          authorAlias: "小孙",
          role: "user",
          content: "F027 Phase 3",
          createdAt: "t",
        },
      ],
      "t",
    )
    assert.equal(info, null)
  })
})
