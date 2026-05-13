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

  // ─── 范-r3 P1-2 修：24h 边界 + 时间格式变种 ────────────────────────

  it("24h 边界等号: 恰好 24h 之前的 call 被严格 > 过滤（秒级精度）", () => {
    const { db, cleanup } = makeDb()
    try {
      // 范-r3 P1-2 修：SQL 用 SQLite datetime() 而非字典序 → 格式宽容但精度到秒
      // 生产 a2a deadline 是分钟/小时级别，秒级精度足够（毫秒边界不是真实场景）
      // R-201 实证：'2026-05-08T09:11:19.603Z' — 秒级粒度比对正常
      insertCall(db, {
        callId: "c-edge-eq",
        sessionGroupId: "sg-1",
        status: "pending",
        deadlineAt: "2026-05-12T14:30:00.000Z",
      })
      // 比 cutoff 晚 1 秒 → datetime() 比较 > → 保留
      insertCall(db, {
        callId: "c-edge-just-after",
        sessionGroupId: "sg-1",
        status: "pending",
        deadlineAt: "2026-05-12T14:30:01.000Z",
      })
      const blockers = queryBlockerCalls(db, "sg-1", "2026-05-13T14:30:00Z")
      const ids = blockers.map((b) => b.callId)
      assert.ok(!ids.includes("c-edge-eq"), "恰好 24h 之前的 call 不算 fresh")
      assert.ok(ids.includes("c-edge-just-after"), "晚 1 秒的 call 算 fresh")
    } finally {
      cleanup()
    }
  })

  it("UTC ISO 字典序边界: 高位字段变化时字符串比较仍正确", () => {
    const { db, cleanup } = makeDb()
    try {
      // 2026 年/月/日/时/分都参与字典序——验证不同月份不会乱序
      insertCall(db, {
        callId: "c-jan",
        sessionGroupId: "sg-1",
        status: "pending",
        deadlineAt: "2026-01-15T00:00:00Z",
      })
      insertCall(db, {
        callId: "c-may-fresh",
        sessionGroupId: "sg-1",
        status: "pending",
        deadlineAt: "2026-05-13T15:00:00Z",
      })
      const blockers = queryBlockerCalls(db, "sg-1", "2026-05-13T14:30:00Z")
      const ids = blockers.map((b) => b.callId)
      assert.ok(!ids.includes("c-jan"), "1 月 call (高位字段早) 字典序 < cutoff，过滤掉")
      assert.ok(ids.includes("c-may-fresh"), "当月 fresh call 保留")
    } finally {
      cleanup()
    }
  })

  it("不带 Z 后缀的 ISO 字符串 deadline 也能正确比较（防 SQLite datetime 变种）", () => {
    const { db, cleanup } = makeDb()
    try {
      // 模拟 F026 schema 写入时未带 Z 后缀的边缘 case
      // 当前 a2a_calls.deadline_at 是 TEXT，约定 UTC ISO with Z，但防御未来格式变种
      insertCall(db, {
        callId: "c-no-z",
        sessionGroupId: "sg-1",
        status: "pending",
        deadlineAt: "2026-05-13T15:00:00",
      })
      // ISO 不带 Z 的字典序：'2026-05-13T15:00:00' < '2026-05-13T15:00:00Z'（因 EOL < 'Z'）
      // 但 cutoff 是 '2026-05-12T14:30:00Z' < '2026-05-13T15:00:00' → 字典序仍 > → 保留
      const blockers = queryBlockerCalls(db, "sg-1", "2026-05-13T14:30:00Z")
      const ids = blockers.map((b) => b.callId)
      assert.ok(ids.includes("c-no-z"), "无 Z 后缀 ISO 字符串字典序仍 > cutoff，正常保留")
    } finally {
      cleanup()
    }
  })

  it("范-r4: +HH:MM offset 格式 deadline 经 datetime() 后正确转 UTC 比较", () => {
    const { db, cleanup } = makeDb()
    try {
      // 范-r4 P1-2 follow-up: 测试 +08:00 offset 格式
      // "2026-05-13T23:00:00+08:00" 等价于 UTC "2026-05-13T15:00:00Z"
      // SQLite datetime() 解析 offset 后转为 UTC 形式比较
      // cutoff = subtractHours("2026-05-13T14:30:00Z", 24) = "2026-05-12T14:30:00.000Z"
      // → UTC 15:00 - cutoff 14:30 = 24.5h 后，应保留
      insertCall(db, {
        callId: "c-offset-fresh",
        sessionGroupId: "sg-1",
        status: "pending",
        deadlineAt: "2026-05-13T23:00:00+08:00", // UTC 15:00 (现在 14:30, 30 min 后到期)
      })
      // 等价 UTC 形式作 sanity check（应同等保留）
      insertCall(db, {
        callId: "c-utc-fresh",
        sessionGroupId: "sg-1",
        status: "pending",
        deadlineAt: "2026-05-13T15:00:00.000Z",
      })
      // +08:00 stale: "2026-05-08T17:00:00+08:00" = UTC "2026-05-08T09:00:00Z" (5 天前)
      insertCall(db, {
        callId: "c-offset-stale",
        sessionGroupId: "sg-1",
        status: "pending",
        deadlineAt: "2026-05-08T17:00:00+08:00",
      })
      const blockers = queryBlockerCalls(db, "sg-1", "2026-05-13T14:30:00Z")
      const ids = blockers.map((b) => b.callId)
      assert.ok(ids.includes("c-offset-fresh"), "+08:00 offset 30min 后到期 → fresh")
      assert.ok(ids.includes("c-utc-fresh"), "等价 UTC fresh sanity")
      assert.ok(!ids.includes("c-offset-stale"), "+08:00 offset 5 天前 → stale 过滤")
    } finally {
      cleanup()
    }
  })

  it("跨月 24h 兜底：5/1 00:00 cutoff 正确过滤 4 月 stale call", () => {
    const { db, cleanup } = makeDb()
    try {
      insertCall(db, {
        callId: "c-apr-30",
        sessionGroupId: "sg-1",
        status: "pending",
        deadlineAt: "2026-04-30T20:00:00Z",
      })
      insertCall(db, {
        callId: "c-may-2",
        sessionGroupId: "sg-1",
        status: "pending",
        deadlineAt: "2026-05-02T00:00:00Z",
      })
      // now = 2026-05-02 12:00, cutoff = 2026-05-01 12:00
      const blockers = queryBlockerCalls(db, "sg-1", "2026-05-02T12:00:00Z")
      const ids = blockers.map((b) => b.callId)
      assert.ok(!ids.includes("c-apr-30"), "4/30 deadline 字典序 < 5/1 cutoff，过滤")
      assert.ok(ids.includes("c-may-2"), "5/2 deadline 保留")
    } finally {
      cleanup()
    }
  })
})

// ─── 范-r3 P2-2 修：tombstone/active 双集合同步契约测试 ──────────────

describe("renderViewfinder · tombstone/active 双集合契约（范-r3 P2-2）", () => {
  it("同一 decision 同时出现在 tombstone + active → §6 去重", () => {
    // 用 ledger.markTombstone 标 active 决策后，getActive 仍含它（superseded_by IS NULL），
    // getTombstone 也含它 → renderer 必须去重不重复列
    const tombstoneSpec = makeDecision({
      id: 100,
      type: "reject",
      content: "不要回 V12",
      tombstone: true,
    })
    const activeSameId = makeDecision({
      id: 100, // 同 id
      type: "reject",
      content: "不要回 V12",
      tombstone: true,
    })
    const r = renderViewfinder(
      defaultInput({
        tombstoneDecisions: [tombstoneSpec],
        activeDecisions: [activeSameId],
      }),
    )
    const section6 = r.markdown.split("## 6. 不要再做")[1] ?? ""
    const occurrences = (section6.match(/不要回 V12/g) ?? []).length
    assert.equal(occurrences, 1, "同一决策不能在 §6 重复出现")
  })

  it("tombstone 集合含被 supersede 的决策（active 集合不含）→ §6 仍渲染", () => {
    // 模拟：ledger.getTombstoneDecisions 返"被 supersede 的 tombstone"（永存）
    // ledger.getActiveDecisions 返 active（不含 superseded）→ 两集合互斥但都该投影 §6
    const supersededTomb = {
      ...makeDecision({ id: 50, type: "reject", content: "拒方案 X", tombstone: true }),
      supersededBy: 99,
    }
    const r = renderViewfinder(
      defaultInput({
        tombstoneDecisions: [supersededTomb],
        activeDecisions: [],
      }),
    )
    const section6 = r.markdown.split("## 6. 不要再做")[1] ?? ""
    assert.match(section6, /拒方案 X/, "supersede 后 tombstone 仍永存 §6")
    assert.match(section6, /tombstone/, "标 tombstone 标识")
  })

  it("active 含 reject 但不 tombstone + tombstone 集合空 → §6 仅渲染 active", () => {
    const r = renderViewfinder(
      defaultInput({
        tombstoneDecisions: [],
        activeDecisions: [makeDecision({ id: 7, type: "reject", content: "跳过 review" })],
      }),
    )
    const section6 = r.markdown.split("## 6. 不要再做")[1] ?? ""
    assert.match(section6, /跳过 review/)
    assert.doesNotMatch(section6, /tombstone/, "非 tombstone 决策不标 tombstone")
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
