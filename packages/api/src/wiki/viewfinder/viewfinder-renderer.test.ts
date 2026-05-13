/**
 * F027 P12 · Viewfinder renderer 测试
 * 真相源：docs/plans/V16.5-final.md chap 11 行 1255-1294 + 1296-1337
 *
 * 覆盖：
 *   - 6 段全部渲染 + frontmatter
 *   - §1 优先级：tombstone spec > active spec > session_groups.title fallback
 *   - §2 messages tail 关键词扫
 *   - §3 取最新 commit 决策
 *   - §4 含 B024 24h 防御 SQL 过滤
 *   - §5 [decision_id, msg_id] 证据链
 *   - §6 reject + tombstone 类
 *   - decisionsSummaryHash + decisionsSummaryTokens 给 drift 用
 *   - coverage warning footer
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { createDrizzleDb } from "../../db/drizzle-instance"
import type { BlockerCallRow, CoverageReport, DecisionRow, RenderViewfinderInput } from "./types"
import { queryBlockerCalls, renderBlockers, renderViewfinder } from "./viewfinder-renderer"

function makeDecision(opts: {
  id: number
  type: DecisionRow["decisionType"]
  content: string
  msgId?: string
  by?: string
  tombstone?: boolean
  decidedAt?: string
}): DecisionRow {
  return {
    decisionId: opts.id,
    roomId: "R-201",
    decidedAt: opts.decidedAt ?? "2026-05-13T10:00:00Z",
    decidedBy: opts.by ?? "小孙",
    decisionType: opts.type,
    content: opts.content,
    sourceMessageIds: [opts.msgId ?? `m-${opts.id}`],
    sourceQuote: opts.content,
    sourceHash: "x",
    tombstone: opts.tombstone ?? false,
    supersededBy: null,
    fencingToken: "leader-1",
    extractorConfidence: null,
    coverageCheckPassed: null,
  }
}

function makeCoverage(overrides: Partial<CoverageReport> = {}): CoverageReport {
  return {
    broad: 10,
    resolved: 10,
    unresolved: 0,
    coverage: 1.0,
    status: "pass",
    reason: "ok",
    unresolvedMessageIds: [],
    ...overrides,
  }
}

function defaultInput(overrides: Partial<RenderViewfinderInput> = {}): RenderViewfinderInput {
  return {
    roomId: "R-201",
    activeDecisions: [],
    tombstoneDecisions: [],
    recentMessages: [],
    blockerCalls: [],
    sessionGroupTitle: "F026-A2A 设计重新对",
    coverage: makeCoverage(),
    generatedAt: "2026-05-13T14:30:00Z",
    lastCommittedCursor: null,
    ...overrides,
  }
}

describe("renderViewfinder · 6 段 happy path", () => {
  it("全 6 段标题 + frontmatter", () => {
    const r = renderViewfinder(defaultInput())
    assert.match(r.markdown, /^---\n/, "frontmatter 起始")
    assert.match(r.markdown, /viewfinder_id: vf_R-201_2026-05-13-14-30/)
    assert.match(r.markdown, /generated_by: RoomCompiler \(rule-based template\)/)
    assert.match(r.markdown, /# R-201 Viewfinder/)
    assert.match(r.markdown, /## 1\. 当前主题/)
    assert.match(r.markdown, /## 2\. 当前进度/)
    assert.match(r.markdown, /## 3\. 下一步 \+ 谁做/)
    assert.match(r.markdown, /## 4\. 等谁 \/ blocker/)
    assert.match(r.markdown, /## 5\. 关键决策/)
    assert.match(r.markdown, /## 6\. 不要再做/)
  })

  it("§1 优先级：tombstone spec > active spec > session_groups.title", () => {
    // 三种 fallback case
    // case A: 有 tombstone spec
    const a = renderViewfinder(
      defaultInput({
        tombstoneDecisions: [
          makeDecision({ id: 1, type: "spec", content: "F027 V16.5 立项", tombstone: true }),
        ],
        activeDecisions: [makeDecision({ id: 2, type: "spec", content: "later spec" })],
      }),
    )
    const aSection1 = a.markdown.split("## 1. 当前主题")[1]?.split("##")[0] ?? ""
    assert.match(aSection1, /F027 V16.5 立项/, "tombstone spec 优先")
    assert.doesNotMatch(aSection1, /later spec/, "§1 不取 active spec（tombstone 已命中）")

    // case B: 无 tombstone，有 active spec
    const b = renderViewfinder(
      defaultInput({
        activeDecisions: [makeDecision({ id: 5, type: "spec", content: "active spec only" })],
      }),
    )
    assert.match(b.markdown, /active spec only/)

    // case C: 都没有 → fallback session_groups.title
    const c = renderViewfinder(defaultInput())
    assert.match(c.markdown, /F026-A2A 设计重新对.*fallback/)
  })

  it("§2 messages tail 关键词扫 → 最新进度句", () => {
    const r = renderViewfinder(
      defaultInput({
        recentMessages: [
          {
            messageId: "m-1",
            authorAlias: "黄仁勋",
            role: "assistant",
            content: "正在干活",
            createdAt: "t1",
          },
          {
            messageId: "m-2",
            authorAlias: "黄仁勋",
            role: "assistant",
            content: "✅ 阻塞 1 收尾。修了 X。",
            createdAt: "t2",
          },
        ],
      }),
    )
    assert.match(r.markdown, /✅ 阻塞 1 收尾/)
    assert.match(r.markdown, /msg m-2/)
  })

  it("§2 无任何进度信号 → fallback", () => {
    const r = renderViewfinder(
      defaultInput({
        recentMessages: [
          {
            messageId: "m-1",
            authorAlias: "黄仁勋",
            role: "assistant",
            content: "在思考",
            createdAt: "t1",
          },
        ],
      }),
    )
    assert.match(r.markdown, /最近 messages 无明确进度信号/)
  })

  it("§3 取最新 commit 决策（type=commit 优先）", () => {
    const r = renderViewfinder(
      defaultInput({
        activeDecisions: [
          makeDecision({ id: 10, type: "spec", content: "立项 X", decidedAt: "t10" }),
          makeDecision({ id: 11, type: "commit", content: "进 merger-gate", decidedAt: "t11" }),
        ],
      }),
    )
    assert.match(r.markdown, /进 merger-gate/)
    assert.match(r.markdown, /D-11/)
  })

  it("§3 无 commit 类 → fallback 最新任意 active 决策", () => {
    const r = renderViewfinder(
      defaultInput({
        activeDecisions: [makeDecision({ id: 9, type: "spec", content: "立项 Y" })],
      }),
    )
    // §3 应包含立项 Y（fallback）
    const section3 = r.markdown.split("## 3. 下一步")[1]?.split("##")[0] ?? ""
    assert.match(section3, /立项 Y/)
  })

  it("§4 blockerCalls 渲染含 callId 短码 + status + deadline", () => {
    const r = renderViewfinder(
      defaultInput({
        blockerCalls: [
          {
            callId: "call-abc12345-...",
            issuerId: "user",
            status: "pending",
            deadlineAt: "2026-05-13T15:30:00Z",
          },
          {
            callId: "call-def67890-...",
            issuerId: "桂芬",
            status: "failed",
            deadlineAt: "2026-05-13T14:00:00Z",
            reason: "LLM API 30s 无响应",
          },
        ],
      }),
    )
    const section4 = r.markdown.split("## 4. 等谁")[1]?.split("##")[0] ?? ""
    assert.match(section4, /等 user.*pending.*deadline 15:30/)
    assert.match(section4, /等 桂芬.*failed.*reason="LLM API 30s 无响应"/)
    assert.match(section4, /call-abc12345/, "callId 短码（前 13 字符）")
  })

  it("§4 空 → 显示 '无 blocker'", () => {
    const r = renderViewfinder(defaultInput())
    assert.match(r.markdown, /无 blocker/)
  })

  it("§5 决策列表含 [decision_id, msg_id] 证据链", () => {
    const r = renderViewfinder(
      defaultInput({
        activeDecisions: [
          makeDecision({ id: 1, type: "spec", content: "立项 F027", msgId: "msg-100" }),
          makeDecision({ id: 2, type: "commit", content: "进 merger-gate", msgId: "msg-200" }),
        ],
      }),
    )
    const section5 = r.markdown.split("## 5. 关键决策")[1]?.split("##")[0] ?? ""
    assert.match(section5, /D-1 \[msg_msg-100, 小孙\]: 立项 F027/)
    assert.match(section5, /D-2 \[msg_msg-200, 小孙\]: 进 merger-gate/)
  })

  it("§6 reject + tombstone 列表（去重）", () => {
    const r = renderViewfinder(
      defaultInput({
        tombstoneDecisions: [
          makeDecision({ id: 5, type: "reject", content: "不要回 V12", tombstone: true }),
        ],
        activeDecisions: [makeDecision({ id: 6, type: "reject", content: "跳过 review" })],
      }),
    )
    const section6 = r.markdown.split("## 6. 不要再做")[1] ?? ""
    assert.match(section6, /不要回 V12.*tombstone/)
    assert.match(section6, /跳过 review/)
  })

  it("§6 无 reject/tombstone → fallback 文案", () => {
    const r = renderViewfinder(defaultInput())
    assert.match(r.markdown, /暂无 reject\/tombstone 决策/)
  })
})

describe("renderViewfinder · drift 产物（hash + tokens）", () => {
  it("§5 决策列表 hash + tokens 一致", () => {
    const decisions = [
      makeDecision({ id: 1, type: "spec", content: "立项 F027 V16.5" }),
      makeDecision({ id: 2, type: "commit", content: "进 merger-gate" }),
    ]
    const a = renderViewfinder(defaultInput({ activeDecisions: decisions }))
    const b = renderViewfinder(defaultInput({ activeDecisions: decisions }))
    assert.equal(a.decisionsSummaryHash, b.decisionsSummaryHash, "同输入 → 同 hash")
    assert.deepEqual(
      Array.from(a.decisionsSummaryTokens).sort(),
      Array.from(b.decisionsSummaryTokens).sort(),
    )
    assert.ok(a.decisionsSummaryTokens.size > 0, "应能 tokenize 出非空 set")
  })

  it("决策内容变 → hash 变 → drift 可被检测", () => {
    const a = renderViewfinder(
      defaultInput({
        activeDecisions: [makeDecision({ id: 1, type: "spec", content: "立项 F027" })],
      }),
    )
    const b = renderViewfinder(
      defaultInput({
        activeDecisions: [
          makeDecision({ id: 1, type: "spec", content: "立项 F027 V16.5（已升级）" }),
        ],
      }),
    )
    assert.notEqual(a.decisionsSummaryHash, b.decisionsSummaryHash)
  })
})

describe("renderViewfinder · coverage warning footer", () => {
  it("status=warn → footer 含 unresolved + 手动确认", () => {
    const r = renderViewfinder(
      defaultInput({
        coverage: makeCoverage({
          status: "warn",
          coverage: 0.5,
          resolved: 5,
          broad: 10,
          unresolved: 5,
          unresolvedMessageIds: ["msg-1", "msg-2"],
          reason: "coverage 50% < 95%",
        }),
        recentMessages: [
          {
            messageId: "msg-1",
            authorAlias: "小孙",
            role: "user",
            content: "@黄仁勋 go",
            createdAt: "t",
          },
          {
            messageId: "msg-2",
            authorAlias: "小孙",
            role: "user",
            content: "@黄仁勋 A",
            createdAt: "t",
          },
        ],
      }),
    )
    assert.match(r.markdown, /⚠️ Coverage \*\*warn\*\*/)
    assert.match(r.markdown, /msg msg-1.*"@黄仁勋 go"/)
    assert.match(r.markdown, /msg msg-2.*"@黄仁勋 A"/)
    assert.match(r.markdown, /POST \/api\/rooms\/R-201\/decisions/)
  })

  it("status=pass → 无 footer", () => {
    const r = renderViewfinder(defaultInput())
    assert.doesNotMatch(r.markdown, /⚠️ Coverage/)
  })
})

// ─── §4 防御 SQL 测试（B024 24h 兜底） ────────────────────────────────

describe("queryBlockerCalls · B024 24h deadline_at 防御过滤", () => {
  function makeDb() {
    const dir = mkdtempSync(path.join(tmpdir(), "viewfinder-blockers-"))
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

  function insertCall(
    db: ReturnType<typeof makeDb>["db"],
    opts: {
      callId: string
      sessionGroupId: string
      status: string
      deadlineAt: string
      issuerId?: string
    },
  ) {
    db.prepare(`
      INSERT INTO a2a_calls (
        call_id, root_call_id, issuer_id, convener_id, reply_to,
        deadline_at, status, session_group_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      opts.callId,
      opts.callId,
      opts.issuerId ?? "user",
      "黄仁勋",
      "user",
      opts.deadlineAt,
      opts.status,
      opts.sessionGroupId,
      opts.deadlineAt,
      opts.deadlineAt,
    )
  }

  it("过期 > 24h 的 pending call 被过滤掉（B024 兜底）", () => {
    const { db, cleanup } = makeDb()
    try {
      insertCall(db, {
        callId: "call-stale-1",
        sessionGroupId: "sg-1",
        status: "pending",
        deadlineAt: "2026-05-08T09:11:19Z", // 5 天前 R-201 真实僵尸
      })
      insertCall(db, {
        callId: "call-fresh-1",
        sessionGroupId: "sg-1",
        status: "pending",
        deadlineAt: "2026-05-13T15:00:00Z", // 24h 内
      })
      const blockers = queryBlockerCalls(db, "sg-1", "2026-05-13T14:30:00Z")
      const ids = blockers.map((b) => b.callId)
      assert.ok(!ids.includes("call-stale-1"), "5 天前的 call 必须被过滤（B024 兜底）")
      assert.ok(ids.includes("call-fresh-1"), "24h 内的 call 必须保留")
    } finally {
      cleanup()
    }
  })

  it("不同 status 都参与过滤（pending/working/failed/timeout/cancelled）", () => {
    const { db, cleanup } = makeDb()
    try {
      const fresh = "2026-05-13T15:00:00Z"
      insertCall(db, {
        callId: "c-p",
        sessionGroupId: "sg-1",
        status: "pending",
        deadlineAt: fresh,
      })
      insertCall(db, {
        callId: "c-w",
        sessionGroupId: "sg-1",
        status: "working",
        deadlineAt: fresh,
      })
      insertCall(db, { callId: "c-f", sessionGroupId: "sg-1", status: "failed", deadlineAt: fresh })
      insertCall(db, {
        callId: "c-t",
        sessionGroupId: "sg-1",
        status: "timeout",
        deadlineAt: fresh,
      })
      insertCall(db, {
        callId: "c-c",
        sessionGroupId: "sg-1",
        status: "cancelled",
        deadlineAt: fresh,
      })
      // done 状态不应进 blocker 列表
      insertCall(db, { callId: "c-d", sessionGroupId: "sg-1", status: "done", deadlineAt: fresh })
      const blockers = queryBlockerCalls(db, "sg-1", "2026-05-13T14:30:00Z")
      const ids = blockers.map((b) => b.callId).sort()
      assert.deepEqual(ids, ["c-c", "c-f", "c-p", "c-t", "c-w"], "5 种 blocker 状态全在，done 不在")
    } finally {
      cleanup()
    }
  })

  it("不同 session_group_id 不串", () => {
    const { db, cleanup } = makeDb()
    try {
      insertCall(db, {
        callId: "c-1",
        sessionGroupId: "sg-1",
        status: "pending",
        deadlineAt: "2026-05-13T15:00:00Z",
      })
      insertCall(db, {
        callId: "c-2",
        sessionGroupId: "sg-2",
        status: "pending",
        deadlineAt: "2026-05-13T15:00:00Z",
      })
      const blockers = queryBlockerCalls(db, "sg-1", "2026-05-13T14:30:00Z")
      assert.equal(blockers.length, 1)
      assert.equal(blockers[0].callId, "c-1")
    } finally {
      cleanup()
    }
  })
})

describe("renderBlockers (helper)", () => {
  it("空数组 → 无 blocker 文案", () => {
    const out = renderBlockers(defaultInput())
    assert.match(out, /无 blocker/)
  })

  it("含 cancelled 不显示 reason 字段", () => {
    const blockers: BlockerCallRow[] = [
      {
        callId: "call-cancel-1",
        issuerId: "user",
        status: "cancelled",
        deadlineAt: "2026-05-13T15:00:00Z",
      },
    ]
    const out = renderBlockers(defaultInput({ blockerCalls: blockers }))
    assert.match(out, /status=cancelled/)
    assert.doesNotMatch(out, /reason/)
  })
})
