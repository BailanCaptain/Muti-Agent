/**
 * F027 P12 · Viewfinder renderer 测试
 * 真相源：docs/plans/V16.5-final.md chap 11 行 1255-1294 + 1296-1337
 *
 * 覆盖：
 *   - 6 段全部渲染 + frontmatter
 *   - §1 优先级：tombstone spec > active spec > session_groups.title fallback
 *   - §2 commit 决策驱动的"已完成"列表（小孙 walkthrough 反馈：messages 关键词扫无时间语义）
 *   - §3 取最新 commit 决策
 *   - §4 含 B024 24h 防御 SQL 过滤
 *   - §5 [decision_id, msg_id] 证据链
 *   - §6 严格只 tombstone=1（AC-P2-7 拍 A）；active reject 归 §5 不进 §6
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
    status: "active",
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
    // F027 v3 G3 修: 字段值从 "RoomCompiler (rule-based template)" 改为
    // "rule-based-template" + 注释 (V16.5 chap 11 · 设计层固定单路径)
    assert.match(r.markdown, /generated_by: rule-based-template/)
    assert.match(r.markdown, /V16\.5 chap 11/)
    assert.match(r.markdown, /不调 LLM/)
    assert.match(r.markdown, /# R-201 Viewfinder/)
    assert.match(r.markdown, /## 1\. 当前主题/)
    assert.match(r.markdown, /## 2\. 当前进度/)
    assert.match(r.markdown, /## 3\. 下一步 \+ 谁做/)
    assert.match(r.markdown, /## 4\. 等谁 \/ blocker/)
    assert.match(r.markdown, /## 5\. 关键决策/)
    assert.match(r.markdown, /## 6\. 不要再做/)
  })

  // AC-P2-9（小孙 2026-05-31 拍 A）：§1 优先 feature/bug 文档 H1 标题（带前缀），零 LLM
  it("§1 featureTopic 优先于 spec 决策（feature/bug H1 标题）", () => {
    const r = renderViewfinder(
      defaultInput({
        featureTopic: "F027 — 统一记忆架构（V16.5 整套）",
        tombstoneDecisions: [
          makeDecision({ id: 1, type: "spec", content: "某 tombstone spec", tombstone: true }),
        ],
        activeDecisions: [makeDecision({ id: 2, type: "spec", content: "某 active spec" })],
      }),
    )
    const section1 = r.markdown.split("## 1. 当前主题")[1]?.split("##")[0] ?? ""
    assert.match(section1, /F027 — 统一记忆架构/, "§1 取 feature H1 标题")
    assert.doesNotMatch(section1, /tombstone spec|active spec/, "featureTopic 命中 → 不退决策")
  })

  it("§1 bug 房：featureTopic = bug H1（带 B-id 前缀）", () => {
    const r = renderViewfinder(
      defaultInput({ featureTopic: "B024 · a2a sweep 漏扫僵尸 call（取景器 §4 卡死源）" }),
    )
    const section1 = r.markdown.split("## 1. 当前主题")[1]?.split("##")[0] ?? ""
    assert.match(section1, /B024 · a2a sweep 漏扫僵尸 call/, "§1 取 bug H1 标题")
  })

  it("§1 无 featureTopic（纯闲聊房）→ 退 spec 决策 / 房间标题 fallback", () => {
    const r = renderViewfinder(
      defaultInput({
        featureTopic: null,
        activeDecisions: [makeDecision({ id: 9, type: "spec", content: "闲聊里定的 spec" })],
      }),
    )
    const section1 = r.markdown.split("## 1. 当前主题")[1]?.split("##")[0] ?? ""
    assert.match(section1, /闲聊里定的 spec/, "无 featureTopic → 退 active spec")
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

  it("§2 取最近 5 条 active commit 决策拼'已完成'列表", () => {
    const r = renderViewfinder(
      defaultInput({
        activeDecisions: [
          makeDecision({ id: 12, type: "commit", content: "干掉孤儿 worktree", decidedAt: "t12" }),
          makeDecision({ id: 11, type: "reject", content: "不要再 X", decidedAt: "t11" }),
          makeDecision({ id: 10, type: "commit", content: "清理 preview 进程", decidedAt: "t10" }),
          makeDecision({ id: 9, type: "commit", content: "F026 进 merger-gate", decidedAt: "t9" }),
        ],
      }),
    )
    const section2 = r.markdown.split("## 2. 当前进度")[1]?.split("##")[0] ?? ""
    assert.match(section2, /已完成/, "§2 头部含'已完成'标记")
    assert.match(section2, /干掉孤儿 worktree/, "含最新 commit")
    assert.match(section2, /清理 preview 进程/)
    assert.match(section2, /F026 进 merger-gate/)
    assert.doesNotMatch(section2, /不要再 X/, "§2 不含 reject 类决策")
  })

  it("§2 无 commit 类决策 → fallback 文案", () => {
    const r = renderViewfinder(
      defaultInput({
        activeDecisions: [makeDecision({ id: 1, type: "spec", content: "立项 X" })],
      }),
    )
    assert.match(r.markdown, /暂无 commit 类决策入 ledger/)
  })

  it("§2 commit 多于 5 条 → 仅取最新 5 条", () => {
    const r = renderViewfinder(
      defaultInput({
        activeDecisions: Array.from({ length: 10 }, (_, i) =>
          makeDecision({
            id: 10 - i,
            type: "commit",
            content: `commit ${10 - i}`,
            decidedAt: `t${10 - i}`,
          }),
        ),
      }),
    )
    const section2 = r.markdown.split("## 2. 当前进度")[1]?.split("##")[0] ?? ""
    assert.match(section2, /commit 10/)
    assert.match(section2, /commit 6/, "第 5 条（10/9/8/7/6）保留")
    assert.doesNotMatch(section2, /commit 5/, "第 6 条之后不显示")
  })

  // §3 站会式（小孙 2026-05-31 拍 A）：第一条未勾 AC；commit 不进 §3
  it("§3 取 featureProgress 第一条未勾 AC（commit 不进 §3）", () => {
    const r = renderViewfinder(
      defaultInput({
        activeDecisions: [
          makeDecision({ id: 11, type: "commit", content: "进 merger-gate", decidedAt: "t11" }),
        ],
        featureProgress: {
          featureId: "F027",
          total: 39,
          done: 22,
          pct: 56,
          firstUndoneAC: { id: "AC-P3-1", title: "StatusPanel 拖宽" },
        },
      }),
    )
    const section3 = r.markdown.split("## 3. 下一步")[1]?.split("##")[0] ?? ""
    assert.match(section3, /AC-P3-1/)
    assert.match(section3, /StatusPanel 拖宽/)
    assert.doesNotMatch(section3, /进 merger-gate/, "commit 不进 §3")
  })

  it("§3 featureProgress 全勾完 → ✅ 全部 N 条已勾", () => {
    const r = renderViewfinder(
      defaultInput({
        featureProgress: { featureId: "F027", total: 39, done: 39, pct: 100, firstUndoneAC: null },
      }),
    )
    const section3 = r.markdown.split("## 3. 下一步")[1]?.split("##")[0] ?? ""
    assert.match(section3, /全部 39 条 AC 已勾完/)
  })

  it("§3 无 featureProgress → 退最新 spec/pivot 方向（不取 commit）", () => {
    const r = renderViewfinder(
      defaultInput({
        activeDecisions: [
          makeDecision({ id: 11, type: "commit", content: "进 merger-gate", decidedAt: "t11" }),
          makeDecision({ id: 9, type: "spec", content: "立项 Y", decidedAt: "t9" }),
        ],
      }),
    )
    const section3 = r.markdown.split("## 3. 下一步")[1]?.split("##")[0] ?? ""
    assert.match(section3, /立项 Y/, "退最新 spec 方向")
    assert.doesNotMatch(section3, /进 merger-gate/, "仍不取 commit")
  })

  it("§3 无 featureProgress 无方向决策 → 待定", () => {
    const r = renderViewfinder(
      defaultInput({
        activeDecisions: [
          makeDecision({ id: 11, type: "commit", content: "进 merger-gate", decidedAt: "t11" }),
        ],
      }),
    )
    const section3 = r.markdown.split("## 3. 下一步")[1]?.split("##")[0] ?? ""
    assert.match(section3, /下一步待定/)
  })

  // §2 站会式进度行（小孙 2026-05-31 拍 A）：% 只数 checkbox，commit 当 in-flight + 漂移
  it("§2 站会进度行：done/total (pct%)", () => {
    const r = renderViewfinder(
      defaultInput({
        featureProgress: {
          featureId: "F027",
          total: 39,
          done: 22,
          pct: 56,
          firstUndoneAC: { id: "AC-P3-1", title: "StatusPanel 拖宽" },
        },
      }),
    )
    const section2 = r.markdown.split("## 2. 当前进度")[1]?.split("##")[0] ?? ""
    assert.match(section2, /22\/39 AC \(56%\)/)
  })

  it("§2 in-flight：最新 commit AC tag → 正在做（不计入 %）", () => {
    const r = renderViewfinder(
      defaultInput({
        featureProgress: {
          featureId: "F027",
          total: 39,
          done: 22,
          pct: 56,
          firstUndoneAC: { id: "AC-P3-1", title: "StatusPanel 拖宽" },
        },
        phaseInfo: {
          featureId: "F027",
          phase: 3,
          acs: ["AC-P3-1"],
          commitShortSha: "c9ce5a1",
          commitSubject: "feat(F027): AC-P3-1 resize handle",
        },
      }),
    )
    const section2 = r.markdown.split("## 2. 当前进度")[1]?.split("##")[0] ?? ""
    assert.match(section2, /正在做: AC-P3-1/)
    assert.match(section2, /c9ce5a1/)
  })

  it("§2 漂移交叉验证：最新 commit AC ≠ 清单第一条未勾", () => {
    const r = renderViewfinder(
      defaultInput({
        featureProgress: {
          featureId: "F027",
          total: 39,
          done: 22,
          pct: 56,
          firstUndoneAC: { id: "AC-P3-2", title: "5-tab 容器" },
        },
        phaseInfo: {
          featureId: "F027",
          phase: 3,
          acs: ["AC-P3-5"],
          commitShortSha: "abc1234",
          commitSubject: "feat(F027): AC-P3-5",
        },
      }),
    )
    const section2 = r.markdown.split("## 2. 当前进度")[1]?.split("##")[0] ?? ""
    assert.match(section2, /漂移/)
    assert.match(section2, /AC-P3-5/)
    assert.match(section2, /AC-P3-2/)
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

  // AC-P2-8（小孙 2026-05-31 拍）：§5 加权排序 pivot>spec>reject>commit
  it("§5 加权排序 — pivot>spec>reject>commit（AC-P2-8 fixture）", () => {
    const r = renderViewfinder(
      defaultInput({
        // fixture: pivot×1 + spec×2 + reject×1 + commit×5（乱序输入，验排序 + 截断）
        activeDecisions: [
          makeDecision({ id: 50, type: "commit", content: "C1" }),
          makeDecision({ id: 49, type: "commit", content: "C2" }),
          makeDecision({ id: 48, type: "reject", content: "R1" }),
          makeDecision({ id: 47, type: "spec", content: "S1" }),
          makeDecision({ id: 46, type: "commit", content: "C3" }),
          makeDecision({ id: 45, type: "pivot", content: "P1" }),
          makeDecision({ id: 44, type: "spec", content: "S2" }),
          makeDecision({ id: 43, type: "commit", content: "C4" }),
          makeDecision({ id: 42, type: "commit", content: "C5" }),
        ],
      }),
    )
    const section5 = r.markdown.split("## 5. 关键决策")[1]?.split("## 6")[0] ?? ""
    const lines = section5.split("\n").filter((l) => l.trim().startsWith("- "))
    assert.equal(lines.length, 5, "§5 上限 5 条")
    // 期望 top5：P1(pivot) > S1,S2(spec, 原序) > R1(reject) > C1(commit, 原序首个)
    const contents = lines.map((l) => /: (\S+)$/.exec(l)?.[1] ?? "")
    assert.deepEqual(
      contents,
      ["P1", "S1", "S2", "R1", "C1"],
      `§5 应按 pivot>spec>reject>commit 排序，actual: ${contents.join(",")}`,
    )
  })

  // AC-P2-7（小孙 2026-05-31 拍 A）：§6 严格只 tombstone=1；active reject 不进 §6（仍在 §5）
  it("§6 只渲染 tombstone=1；active reject 不进 §6（仍在 §5）", () => {
    const r = renderViewfinder(
      defaultInput({
        tombstoneDecisions: [
          makeDecision({ id: 5, type: "reject", content: "不要回 V12", tombstone: true }),
        ],
        activeDecisions: [makeDecision({ id: 6, type: "reject", content: "跳过 review" })],
      }),
    )
    const section6 = r.markdown.split("## 6. 不要再做")[1] ?? ""
    assert.match(section6, /不要回 V12.*tombstone/, "§6 含 tombstone 红线")
    assert.doesNotMatch(section6, /跳过 review/, "§6 不含 active reject（非永久红线）")
    // active reject 不丢：仍在 §5 关键决策
    const section5 = r.markdown.split("## 5. 关键决策")[1]?.split("## 6")[0] ?? ""
    assert.match(section5, /跳过 review/, "active reject 移至 §5 不丢信息")
  })

  it("§6 无 tombstone → fallback 文案", () => {
    const r = renderViewfinder(defaultInput())
    assert.match(r.markdown, /暂无 tombstone 永久红线决策/)
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

  it("范-r5: offset 必须 UTC 归一化（字典序与 UTC 结果相反的判别 case）", () => {
    const { db, cleanup } = makeDb()
    try {
      // 范-r5 抓到 r4 缺判别力：原 offset case (+08:00 fresh/stale) 在字典序下也同结果，
      // 不能证明 datetime() 做了 UTC 归一化。本 test 设计字典序判结果 vs UTC 判结果**相反**
      // 的 case，只有真做 UTC 归一化才能 pass。
      //
      // now = 2026-05-13T14:30:00Z, cutoff(24h ago) = 2026-05-12T14:30:00.000Z
      //
      // case A: '2026-05-12T20:00:00+08:00' = UTC '2026-05-12T12:00:00Z'
      //   字典序对 cutoff: 前 11 字符相同, '20' > '14' → 字典序 > cutoff → 字典序判 FRESH
      //   datetime() UTC: 12:00 < 14:30 → UTC < cutoff → datetime 判 STALE ← 真相
      //   预期: 过滤掉 (stale) — 只有 datetime() 在生效才能 pass
      insertCall(db, {
        callId: "c-pos-offset-actually-stale",
        sessionGroupId: "sg-1",
        status: "pending",
        deadlineAt: "2026-05-12T20:00:00+08:00",
      })
      // case B: '2026-05-12T05:00:00-10:00' = UTC '2026-05-12T15:00:00Z'
      //   字典序对 cutoff: 前 11 字符相同, '05' < '14' → 字典序 < cutoff → 字典序判 STALE
      //   datetime() UTC: 15:00 > 14:30 → UTC > cutoff → datetime 判 FRESH ← 真相
      //   预期: 保留 (fresh) — 只有 datetime() 在生效才能 pass
      //   范-r6 修：原 case B 用 '-08:00 + 5/13' 字典序也 > cutoff，没判别力；
      //     改 '-10:00 + 5/12' 真做到字典序 < UTC，与 case A 形成双向判别
      insertCall(db, {
        callId: "c-neg-offset-actually-fresh",
        sessionGroupId: "sg-1",
        status: "pending",
        deadlineAt: "2026-05-12T05:00:00-10:00",
      })
      const blockers = queryBlockerCalls(db, "sg-1", "2026-05-13T14:30:00Z")
      const ids = blockers.map((b) => b.callId)
      assert.ok(
        !ids.includes("c-pos-offset-actually-stale"),
        "+08:00 offset 字典序看像 fresh 但 UTC 真相是 stale → 必须过滤（datetime() 必生效）",
      )
      assert.ok(
        ids.includes("c-neg-offset-actually-fresh"),
        "-10:00 offset 字典序看像 stale 但 UTC 真相是 fresh → 必须保留（datetime() 必生效）",
      )
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

  // AC-P2-7（小孙 2026-05-31 拍 A）：active reject 非永久红线 → 不进 §6，移至 §5
  it("active 含 reject 但不 tombstone + tombstone 集合空 → §6 fallback（active reject 归 §5）", () => {
    const r = renderViewfinder(
      defaultInput({
        tombstoneDecisions: [],
        activeDecisions: [makeDecision({ id: 7, type: "reject", content: "跳过 review" })],
      }),
    )
    const section6 = r.markdown.split("## 6. 不要再做")[1] ?? ""
    assert.match(section6, /暂无 tombstone 永久红线决策/, "§6 无 tombstone → fallback")
    assert.doesNotMatch(section6, /跳过 review/, "active reject 不进 §6")
    const section5 = r.markdown.split("## 5. 关键决策")[1]?.split("## 6")[0] ?? ""
    assert.match(section5, /跳过 review/, "active reject 在 §5 呈现")
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

// ─── P12.b 二轮打磨（小孙 2026-05-22 拍 5 段） ─────────────────────────

describe("P12.b §4 a2a + decision-unresolved 合并（c1 内联）", () => {
  it("coverage.unresolvedMessageIds → §4 渲染 '等 @小孙 confirm: msg_<id>' 行", () => {
    const r = renderViewfinder(
      defaultInput({
        coverage: makeCoverage({
          status: "warn",
          coverage: 0.5,
          resolved: 5,
          broad: 10,
          unresolved: 5,
          unresolvedMessageIds: ["msg-abc"],
          reason: "coverage 50% < 95%",
        }),
        recentMessages: [
          {
            messageId: "msg-abc",
            authorAlias: "黄仁勋",
            role: "assistant",
            content: "看到这篇 RAG paper，跟 F018 思路类似，要不要 ingest？",
            createdAt: "t",
          },
        ],
      }),
    )
    const section4 = r.markdown.split("## 4. 等谁")[1]?.split("##")[0] ?? ""
    assert.match(section4, /等 @小孙 confirm: msg_msg-abc by 黄仁勋/, "decision-unresolved 行")
    assert.match(section4, /RAG paper/, "excerpt 内容")
  })

  it("a2a + unresolved 双源混合 — 都列在 §4", () => {
    const r = renderViewfinder(
      defaultInput({
        blockerCalls: [
          {
            callId: "call-abc12345",
            issuerId: "范德彪",
            status: "pending",
            deadlineAt: "2026-05-13T15:30:00Z",
          },
        ],
        coverage: makeCoverage({
          status: "warn",
          coverage: 0.5,
          resolved: 5,
          broad: 10,
          unresolved: 5,
          unresolvedMessageIds: ["msg-x"],
        }),
        recentMessages: [
          {
            messageId: "msg-x",
            authorAlias: "桂芬",
            role: "assistant",
            content: "preview 应该加签名吗",
            createdAt: "t",
          },
        ],
      }),
    )
    const section4 = r.markdown.split("## 4. 等谁")[1]?.split("##")[0] ?? ""
    assert.match(section4, /等 范德彪.*pending/, "a2a 行")
    assert.match(section4, /等 @小孙 confirm: msg_msg-x by 桂芬/, "decision 行")
  })

  it("excerpt 截 60 字符 + 换行替空格", () => {
    const longContent = `${"很长的内容".repeat(20)}\n第二行内容`
    const r = renderViewfinder(
      defaultInput({
        coverage: makeCoverage({
          status: "warn",
          coverage: 0.5,
          resolved: 5,
          broad: 10,
          unresolved: 5,
          unresolvedMessageIds: ["msg-long"],
        }),
        recentMessages: [
          {
            messageId: "msg-long",
            authorAlias: "黄仁勋",
            role: "assistant",
            content: longContent,
            createdAt: "t",
          },
        ],
      }),
    )
    const section4 = r.markdown.split("## 4. 等谁")[1]?.split("##")[0] ?? ""
    assert.match(section4, /…/, "截断标记")
    assert.doesNotMatch(section4, /\n第二行/, "换行被替成空格")
  })

  it("unresolvedMessageIds 含 id 但 recentMessages 无对应 → excerpt unavailable", () => {
    const r = renderViewfinder(
      defaultInput({
        coverage: makeCoverage({
          status: "warn",
          coverage: 0.5,
          resolved: 5,
          broad: 10,
          unresolved: 5,
          unresolvedMessageIds: ["msg-missing"],
        }),
        recentMessages: [], // 空 — 无法找 excerpt
      }),
    )
    const section4 = r.markdown.split("## 4. 等谁")[1]?.split("##")[0] ?? ""
    assert.match(
      section4,
      /等 @小孙 confirm: msg_msg-missing by unknown/,
      "author=unknown fallback",
    )
    assert.match(section4, /excerpt unavailable/, "excerpt fallback")
  })

  it("空 a2a + 空 unresolved → '无 blocker' 文案", () => {
    const r = renderViewfinder(defaultInput())
    const section4 = r.markdown.split("## 4. 等谁")[1]?.split("##")[0] ?? ""
    assert.match(section4, /无 blocker/)
  })
})

describe("P12.b §6 tombstone 三合一格式", () => {
  it("tombstone 标记拼进 ref 方括号 — 单方括号格式", () => {
    const r = renderViewfinder(
      defaultInput({
        tombstoneDecisions: [
          makeDecision({
            id: 5,
            type: "reject",
            content: "不要回到 V12 一气呵成的拆法",
            msgId: "msg-180",
            tombstone: true,
          }),
        ],
      }),
    )
    const section6 = r.markdown.split("## 6. 不要再做")[1] ?? ""
    assert.match(
      section6,
      /D-5 \[msg_msg-180, 小孙, tombstone\]/,
      "三合一 D-X [msg, decidedBy, tombstone] 单方括号",
    )
    assert.doesNotMatch(
      section6,
      /\[msg_msg-180, 小孙\] \[tombstone\]/,
      "不再有双方括号叠加 ` [msg, by] [tombstone]`",
    )
  })

  // AC-P2-7（小孙 2026-05-31 拍 A）：active reject 不进 §6（移至 §5），故 §6 不含它
  it("active reject 非 tombstone → 不进 §6（归 §5，不带 tombstone 标记）", () => {
    const r = renderViewfinder(
      defaultInput({
        activeDecisions: [
          makeDecision({ id: 7, type: "reject", content: "跳过 review", msgId: "msg-300" }),
        ],
      }),
    )
    const section6 = r.markdown.split("## 6. 不要再做")[1] ?? ""
    assert.doesNotMatch(section6, /D-7/, "active reject 不进 §6")
    const section5 = r.markdown.split("## 5. 关键决策")[1]?.split("## 6")[0] ?? ""
    assert.match(section5, /D-7 \[msg_msg-300, 小孙\]/, "active reject 在 §5，无 tombstone 标记")
    assert.doesNotMatch(section5, /tombstone/, "active 无 tombstone 字面")
  })
})

describe("P12.b §2 phaseInfo 注入 / fallback (方案 Y)", () => {
  it("phaseInfo 注入 → 顶部 phase 坐标行 + 下方已完成列表", () => {
    const r = renderViewfinder(
      defaultInput({
        phaseInfo: {
          featureId: "F027",
          phase: 3,
          week: 2,
          day: 10,
          acs: ["AC-P3-10"],
          commitShortSha: "694fcc1",
          commitSubject:
            "feat(F027-P20): Phase 3 Week 2 Day 9-10 — ingest commit endpoint (AC-P3-10)",
        },
        activeDecisions: [
          makeDecision({ id: 22, type: "commit", content: "ingest commit endpoint 落地" }),
        ],
      }),
    )
    const section2 = r.markdown.split("## 2. 当前进度")[1]?.split("##")[0] ?? ""
    assert.match(section2, /F027 Phase 3 Week 2 Day 10 · AC-P3-10 \(commit 694fcc1\)/, "坐标行")
    assert.match(section2, /已完成/, "下方接列表")
    assert.match(section2, /ingest commit endpoint 落地/, "commit decision")
  })

  it("phaseInfo=null → fallback (A) 仅已完成列表（保留当前 9a1c7b3 实施）", () => {
    const r = renderViewfinder(
      defaultInput({
        phaseInfo: null,
        activeDecisions: [makeDecision({ id: 1, type: "commit", content: "F026 进 merger-gate" })],
      }),
    )
    const section2 = r.markdown.split("## 2. 当前进度")[1]?.split("##")[0] ?? ""
    assert.doesNotMatch(section2, /Phase \d/, "无坐标行")
    assert.match(section2, /已完成/, "fallback 列表")
    assert.match(section2, /F026 进 merger-gate/)
  })

  it("phaseInfo 注入 + 无 commit 决策 → 只显示坐标行（无列表 + 无 fallback 文案）", () => {
    const r = renderViewfinder(
      defaultInput({
        phaseInfo: {
          featureId: "F027",
          phase: 3,
          week: 3,
          day: 11,
          commitShortSha: "abc1234",
          commitSubject: "feat(F027-P20): Phase 3 Week 3 Day 11 — StatusPanel 拖宽",
        },
        activeDecisions: [],
      }),
    )
    const section2 = r.markdown.split("## 2. 当前进度")[1]?.split("##")[0] ?? ""
    assert.match(section2, /F027 Phase 3 Week 3 Day 11/, "坐标行")
    assert.doesNotMatch(section2, /暂无 commit/, "有坐标行时不输出 fallback 文案")
    assert.doesNotMatch(section2, /已完成/, "无 commit 决策无列表")
  })

  it("phaseInfo 部分字段 (无 week/day/acs) → 优雅渲染只显示有的字段", () => {
    const r = renderViewfinder(
      defaultInput({
        phaseInfo: {
          featureId: "B023",
          commitShortSha: "xyz9876",
          commitSubject: "fix(B023): runtime resilience",
        },
      }),
    )
    const section2 = r.markdown.split("## 2. 当前进度")[1]?.split("##")[0] ?? ""
    assert.match(section2, /B023 \(commit xyz9876\)/, "只显示 featureId + commit")
    assert.doesNotMatch(section2, /Phase|Week|Day/, "无 phase/week/day 字段不渲染")
  })
})
