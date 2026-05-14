/**
 * F027 P12 · Decision Extractor 测试
 * 真相源：docs/plans/V16.5-final.md chap 11 行 1238-1253
 *
 * 覆盖：
 *   - 关键词宽召 R-201 5/8 真实数据 → 宽召率 ≥ 60%（vs 之前 21% 严判）
 *   - 短指令 join 上一条 assistant 消息
 *   - matchKeyword 类型分桶（spec/pivot/commit/reject）
 *   - parseJudgmentJson 容忍 markdown fence + 失败抛
 *   - runExtractor 三集合分流（resolved/non-decision/unresolved）+ 限并发
 *   - Haiku 失败标 unresolved 不阻塞
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  HaikuDecisionJudge,
  type HaikuLike,
  type MessageInput,
  buildJudgePrompt,
  extractBroadCandidates,
  parseJudgmentJson,
  runExtractor,
} from "./decision-extractor"
import type { BroadCandidate, CandidateJudgment, DecisionJudgeProvider } from "./types"

function msg(
  id: string,
  role: "user" | "assistant",
  content: string,
  alias = "小孙",
  createdAt = "2026-05-08T07:00:00Z",
): MessageInput {
  return { messageId: id, threadId: "t1", authorAlias: alias, role, content, createdAt }
}

// ─── 关键词宽召 ──────────────────────────────────────────────────────────

describe("extractBroadCandidates · R-201 真实数据", () => {
  it("R-201 5/8 21 条 user 消息宽召率 ≥ 60%", () => {
    // 真实 R-201 user messages（按时间升序）
    const realMessages: MessageInput[] = [
      msg("u-1", "user", "@黄仁勋 先拉下房间记忆 不要失忆 F026我们做完了，我们现在进merger-gate"),
      msg("a-1", "assistant", "先并行拉房间记忆 + 自己 memory + 看 worktree git 状态..."),
      msg("u-2", "user", "@黄仁勋 先看1把 1是什么"),
      msg("a-2", "assistant", "聚焦阻塞 1。要判断 stash@{0} 是不是真的可以永久弃用..."),
      msg("u-3", "user", "@黄仁勋 a这个不影响我们现有的已经开发的功能吧?"),
      msg("a-3", "assistant", "合理担心。我去实证 4 件事再答..."),
      msg("u-4", "user", "@黄仁勋 go"),
      msg("a-4", "assistant", "执行 + 验证。## ✅ 阻塞 1 收尾..."),
      msg("u-5", "user", "@黄仁勋 2我验证过了 3我已经review不用管 4是什么情况"),
      msg("a-5", "assistant", "收到 — 2 我去补勾..."),
      msg("u-6", "user", "@黄仁勋 go 4也删掉不留了"),
      msg("a-6", "assistant", "执行清扫 + 补勾..."),
      msg("u-7", "user", "@黄仁勋 这ADR是啥 先给我看看"),
      msg("a-7", "assistant", "先 rehydrate——看 worktree 状态..."),
      msg("u-8", "user", "@黄仁勋 不是 这三个跟我们现在的实现有什么关系"),
      msg("a-8", "assistant", "明白——做一份 ADR 设计 vs 实际代码对账..."),
      msg(
        "u-9",
        "user",
        "@黄仁勋 改ADR 不改实现！ 以后想改在改在起相应的feature 这个feature拖得太久了 今天必须闭环",
      ),
      msg("a-9", "assistant", "收到——改 ADR 不改实现..."),
      msg("u-10", "user", "@黄仁勋 什么体感"),
      msg("a-10", "assistant", "## 体感..."),
      msg("u-11", "user", "@黄仁勋 已经验过了"),
      msg("a-11", "assistant", "按 long-thread 规矩先 rehydrate..."),
      msg(
        "u-12",
        "user",
        "@黄仁勋 按你推荐的来，记得看看会不会和dev有冲突，dev最近也合了几笔新代码 然后F026的第一个commit是什么 你要告诉我 我要确保你别漏了",
      ),
      msg("a-12", "assistant", "按推荐走..."),
      msg("u-13", "user", "@黄仁勋 没有冲突那go吧"),
      msg("a-13", "assistant", "看到 worktree 里有 4 个文件 UU..."),
      msg("u-14", "user", "@黄仁勋 已经合并完了吗？有需要我决策过目你拿不准的吗?"),
      msg("a-14", "assistant", "## 答：还没合 · 卡在两件事..."),
      msg(
        "u-15",
        "user",
        "@黄仁勋 什么玩意 你先拉一下房间消息，看看我们之前在干嘛！！！我们不是在merger，然后我说dev合了几笔代码你在处理东西吗",
      ),
      msg("a-15", "assistant", "收到。我搞错状态了..."),
      msg("u-16", "user", "@黄仁勋 A"),
      msg("a-16", "assistant", "收到，按 A 走..."),
      msg("u-17", "user", "@黄仁勋 A"),
      msg("a-17", "assistant", "收到。我先并行核 visionVersion..."),
      msg("u-18", "user", "@黄仁勋 go"),
      msg("a-18", "assistant", "收到 `go`..."),
      msg("u-19", "user", "@黄仁勋 把多余得worktree preview都给干掉"),
      msg("a-19", "assistant", "收到。先 rehydrate 现状..."),
      msg("u-20", "user", "@黄仁勋 都干掉 剩余的worktrees"),
      msg("a-20", "assistant", "等一下——F012 是 active feature worktree..."),
      msg("u-21", "user", "@黄仁勋 直接删 这些做完都没用了 本来就应该删掉"),
    ]
    const candidates = extractBroadCandidates(realMessages)
    const userMsgCount = realMessages.filter((m) => m.role === "user").length
    assert.equal(userMsgCount, 21)

    // 宽召率必须 ≥ 60%（之前严判 21% — 现在宽召覆盖短指令）
    // 命中：u-1（做完了/进 X）、u-3（不影响）、u-4（go）、u-5（不用管）、u-6（go/删掉）、
    //       u-9（必须闭环/改 X 不改 X）、u-11（已经验过了）、u-12（按你推荐）、
    //       u-13（go 吧）、u-16（A）、u-17（A）、u-18（go）、u-19（干掉）、
    //       u-20（干掉）、u-21（删/做完了）
    const hitRate = candidates.length / userMsgCount
    assert.ok(
      hitRate >= 0.6,
      `宽召率 ${(hitRate * 100).toFixed(0)}% < 60% (got ${candidates.length}/${userMsgCount})`,
    )

    // 必须命中关键决策（u-9: 改 ADR 不改实现 / u-21: 删 / u-1: F026 做完）
    const ids = candidates.map((c) => c.messageId)
    assert.ok(ids.includes("u-9"), "必须命中 u-9 改 ADR 不改实现（pivot 强信号）")
    assert.ok(ids.includes("u-1"), "必须命中 u-1 F026 做完进 merger-gate（commit 强信号）")
  })

  it("短指令 'go' 必须 join 上一条 assistant 消息", () => {
    const messages: MessageInput[] = [
      msg("a-1", "assistant", "## 答：我推荐合 F026 进 dev。要走吗？"),
      msg("u-1", "user", "@黄仁勋 go"),
    ]
    const candidates = extractBroadCandidates(messages)
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].prevAssistantId, "a-1")
    assert.match(candidates[0].prevAssistantContent ?? "", /推荐合 F026/)
  })

  it("第一条 user 消息无前一条 assistant → prevAssistantContent=null", () => {
    const messages: MessageInput[] = [msg("u-1", "user", "@黄仁勋 go")]
    const candidates = extractBroadCandidates(messages)
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].prevAssistantContent, null)
  })

  it("system / tool 消息默认跳过", () => {
    const messages: MessageInput[] = [
      { ...msg("s-1", "user", "go"), role: "system" } as MessageInput,
      { ...msg("t-1", "user", "go"), role: "tool" } as MessageInput,
      msg("u-1", "user", "go"),
    ]
    const candidates = extractBroadCandidates(messages)
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].messageId, "u-1")
  })

  it("纯询问消息不命中任何关键词", () => {
    const messages: MessageInput[] = [msg("u-1", "user", "@黄仁勋 这ADR是啥")]
    const candidates = extractBroadCandidates(messages)
    assert.equal(candidates.length, 0, "纯询问'这是啥'不应命中任何决策关键词")
  })
})

// ─── parseJudgmentJson ────────────────────────────────────────────────

describe("parseJudgmentJson · 容忍/拒绝", () => {
  const fakeCand: BroadCandidate = {
    messageId: "u-1",
    authorAlias: "小孙",
    createdAt: "2026-05-08T07:00:00Z",
    content: "go",
    matchedKeyword: "commit:go",
    prevAssistantContent: "推荐合 F026",
    prevAssistantId: "a-1",
  }

  it("Haiku 标准 JSON → parsed", () => {
    const raw =
      '{"is_decision": true, "type": "commit", "content": "批准合 F026 进 dev", "confidence": 0.9}'
    const j = parseJudgmentJson(raw, fakeCand)
    assert.equal(j.isDecision, true)
    assert.equal(j.type, "commit")
    assert.equal(j.content, "批准合 F026 进 dev")
    assert.equal(j.confidence, 0.9)
  })

  it("markdown ```json fence 包裹 → 自动剥", () => {
    const raw =
      '```json\n{"is_decision": true, "type": "spec", "content": "选 A", "confidence": 0.85}\n```'
    const j = parseJudgmentJson(raw, fakeCand)
    assert.equal(j.isDecision, true)
    assert.equal(j.type, "spec")
  })

  it("is_decision=false → 返 isDecision=false + reason", () => {
    const raw = '{"is_decision": false, "reason": "上下文不足"}'
    const j = parseJudgmentJson(raw, fakeCand)
    assert.equal(j.isDecision, false)
    assert.equal(j.reason, "上下文不足")
  })

  it("非法 type → 抛 parse-failed", () => {
    const raw = '{"is_decision": true, "type": "unknown", "content": "x"}'
    assert.throws(() => parseJudgmentJson(raw, fakeCand), /parse-failed/)
  })

  it("非 JSON → 抛 parse-failed", () => {
    assert.throws(() => parseJudgmentJson("hello world", fakeCand), /parse-failed/)
  })

  it("content 缺失 → fallback 用 candidate.content", () => {
    const raw = '{"is_decision": true, "type": "commit"}'
    const j = parseJudgmentJson(raw, fakeCand)
    assert.equal(j.isDecision, true)
    assert.ok(j.content && j.content.length > 0, "content 必须有 fallback")
  })
})

// ─── HaikuDecisionJudge ───────────────────────────────────────────────

describe("HaikuDecisionJudge · stub HaikuLike", () => {
  it("Haiku ok=true → judgment 解析", async () => {
    const stub: HaikuLike = {
      async runPrompt() {
        return {
          ok: true,
          text: '{"is_decision": true, "type": "commit", "content": "批准合 F026"}',
          durationMs: 10,
        }
      },
    }
    const judge = new HaikuDecisionJudge(stub)
    const j = await judge.judge({
      candidate: {
        messageId: "u-1",
        authorAlias: "小孙",
        createdAt: "2026-05-08T07:00:00Z",
        content: "go",
        matchedKeyword: "commit:go",
        prevAssistantContent: "合 F026？",
        prevAssistantId: "a-1",
      },
    })
    assert.equal(j.isDecision, true)
    assert.equal(j.type, "commit")
  })

  it("Haiku ok=false → 抛 haiku-failed", async () => {
    const stub: HaikuLike = {
      async runPrompt() {
        return { ok: false, text: "", error: "timeout", durationMs: 20000 }
      },
    }
    const judge = new HaikuDecisionJudge(stub)
    await assert.rejects(
      judge.judge({
        candidate: {
          messageId: "u-1",
          authorAlias: "小孙",
          createdAt: "2026-05-08T07:00:00Z",
          content: "go",
          matchedKeyword: "commit:go",
          prevAssistantContent: null,
          prevAssistantId: null,
        },
      }),
      /haiku-failed/,
    )
  })
})

// ─── runExtractor 编排 ────────────────────────────────────────────────

describe("runExtractor · 三集合分流", () => {
  it("decision / non-decision / unresolved 三集合分别落到正确桶", async () => {
    const stubJudge: DecisionJudgeProvider = {
      async judge({ candidate }) {
        if (candidate.messageId === "u-1") {
          return { isDecision: true, type: "commit", content: "批准 X" }
        }
        if (candidate.messageId === "u-2") {
          return { isDecision: false, reason: "是询问不是决策" }
        }
        // u-3 抛错
        throw new Error("haiku-failed: timeout")
      },
    }
    const candidates: BroadCandidate[] = [
      {
        messageId: "u-1",
        authorAlias: "小孙",
        createdAt: "t1",
        content: "go",
        matchedKeyword: "commit:go",
        prevAssistantContent: null,
        prevAssistantId: null,
      },
      {
        messageId: "u-2",
        authorAlias: "小孙",
        createdAt: "t2",
        content: "什么玩意",
        matchedKeyword: "spec:必须",
        prevAssistantContent: null,
        prevAssistantId: null,
      },
      {
        messageId: "u-3",
        authorAlias: "小孙",
        createdAt: "t3",
        content: "A",
        matchedKeyword: "spec:选 X",
        prevAssistantContent: null,
        prevAssistantId: null,
      },
    ]
    const run = await runExtractor(stubJudge, candidates, { maxConcurrency: 2 })
    assert.equal(run.resolvedDecisions.length, 1)
    assert.equal(run.resolvedDecisions[0].candidate.messageId, "u-1")
    assert.equal(run.resolvedNonDecisions.length, 1)
    assert.equal(run.resolvedNonDecisions[0].candidate.messageId, "u-2")
    assert.equal(run.unresolved.length, 1)
    assert.equal(run.unresolved[0].candidate.messageId, "u-3")
    assert.match(run.unresolved[0].error, /haiku-failed/)
  })

  it("空 candidates → 空三集合，不调 judge", async () => {
    let judgeCallCount = 0
    const stubJudge: DecisionJudgeProvider = {
      async judge() {
        judgeCallCount++
        return { isDecision: true, type: "commit" }
      },
    }
    const run = await runExtractor(stubJudge, [])
    assert.equal(judgeCallCount, 0)
    assert.equal(run.broadCandidates.length, 0)
    assert.equal(run.resolvedDecisions.length, 0)
  })

  it("限并发 maxConcurrency=2 不阻塞", async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const stubJudge: DecisionJudgeProvider = {
      async judge() {
        concurrent++
        if (concurrent > maxConcurrent) maxConcurrent = concurrent
        await new Promise((r) => setTimeout(r, 30))
        concurrent--
        return { isDecision: true, type: "commit" }
      },
    }
    const candidates: BroadCandidate[] = Array.from({ length: 10 }, (_, i) => ({
      messageId: `u-${i}`,
      authorAlias: "小孙",
      createdAt: "t",
      content: "go",
      matchedKeyword: "commit:go",
      prevAssistantContent: null,
      prevAssistantId: null,
    }))
    await runExtractor(stubJudge, candidates, { maxConcurrency: 2 })
    assert.ok(maxConcurrent <= 2, `并发上限被打破 (max=${maxConcurrent})`)
  })
})

// ─── buildJudgePrompt ────────────────────────────────────────────────

describe("P4 C-auto-2: supersedes_decision_ids 解析 + 防 hallucination", () => {
  const fakeCand: BroadCandidate = {
    messageId: "u-1",
    authorAlias: "小孙",
    createdAt: "t",
    content: "F026 已合 dev",
    matchedKeyword: "commit:已合",
    prevAssistantContent: null,
    prevAssistantId: null,
  }

  it("activeCommits 内的 id 被保留", () => {
    const raw =
      '{"is_decision": true, "type": "commit", "content": "F026 已合", "supersedes_decision_ids": [2, 5]}'
    const j = parseJudgmentJson(raw, fakeCand, [
      { decisionId: 2, content: "进 merger-gate", decidedAt: "t1" },
      { decisionId: 5, content: "验证 stash", decidedAt: "t2" },
    ])
    assert.deepEqual(j.supersedesDecisionIds, [2, 5])
  })

  it("LLM 返不存在的 id → 过滤掉（防 hallucination）", () => {
    const raw =
      '{"is_decision": true, "type": "commit", "content": "x", "supersedes_decision_ids": [2, 999, 5]}'
    const j = parseJudgmentJson(raw, fakeCand, [
      { decisionId: 2, content: "x", decidedAt: "t" },
      { decisionId: 5, content: "y", decidedAt: "t" },
    ])
    assert.deepEqual(j.supersedesDecisionIds, [2, 5], "999 不存在被过滤")
  })

  it("activeCommits 未传 → supersedes 全部丢弃（LLM 不该凭空生成）", () => {
    const raw =
      '{"is_decision": true, "type": "commit", "content": "x", "supersedes_decision_ids": [2, 5]}'
    const j = parseJudgmentJson(raw, fakeCand)
    assert.equal(j.supersedesDecisionIds, undefined)
  })

  it("activeCommits 传空数组 → supersedes 全部丢弃", () => {
    const raw =
      '{"is_decision": true, "type": "commit", "content": "x", "supersedes_decision_ids": [2, 5]}'
    const j = parseJudgmentJson(raw, fakeCand, [])
    assert.equal(j.supersedesDecisionIds, undefined)
  })

  it("LLM 没返 supersedes_decision_ids → undefined（不强制要求）", () => {
    const raw = '{"is_decision": true, "type": "commit", "content": "F026 已合"}'
    const j = parseJudgmentJson(raw, fakeCand, [{ decisionId: 2, content: "x", decidedAt: "t" }])
    assert.equal(j.supersedesDecisionIds, undefined)
  })

  it("非数字 id 被过滤（防类型混淆）", () => {
    const raw =
      '{"is_decision": true, "type": "commit", "content": "x", "supersedes_decision_ids": [2, "5", 3.5, -1, null]}'
    const j = parseJudgmentJson(raw, fakeCand, [
      { decisionId: 2, content: "x", decidedAt: "t" },
      { decisionId: 5, content: "y", decidedAt: "t" },
    ])
    assert.deepEqual(j.supersedesDecisionIds, [2], "只 2 是正整数且在 activeCommits 内")
  })

  it("buildJudgePrompt 含 active commit 列表块", () => {
    const p = buildJudgePrompt(fakeCand, {
      activeCommits: [
        { decisionId: 2, content: "进 merger-gate", decidedAt: "2026-05-08T06:07:00Z" },
        { decisionId: 5, content: "验证 stash", decidedAt: "2026-05-08T06:23:00Z" },
      ],
    })
    assert.match(p, /\[当前 active commit 决策列表\]/)
    assert.match(p, /D-2.*进 merger-gate/)
    assert.match(p, /D-5.*验证 stash/)
    assert.match(p, /supersedes_decision_ids/, "prompt 含 supersedes_decision_ids schema 字段")
  })

  it("buildJudgePrompt 无 activeCommits → 块显式标'空'", () => {
    const p = buildJudgePrompt(fakeCand, { activeCommits: [] })
    assert.match(p, /\[当前 active commit 决策列表\] 空/)
  })

  it("buildJudgePrompt 不传 activeCommits → 默认为空", () => {
    const p = buildJudgePrompt(fakeCand)
    assert.match(p, /\[当前 active commit 决策列表\] 空/)
  })
})

describe("buildJudgePrompt", () => {
  it("含上下文时拼上一条 assistant", () => {
    const c: BroadCandidate = {
      messageId: "u-1",
      authorAlias: "小孙",
      createdAt: "t",
      content: "go",
      matchedKeyword: "commit:go",
      prevAssistantContent: "我推荐合 F026",
      prevAssistantId: "a-1",
    }
    const p = buildJudgePrompt(c)
    assert.match(p, /\[上一条 assistant 消息\]/)
    assert.match(p, /我推荐合 F026/)
    assert.match(p, /\[user 消息\]/)
    assert.match(p, /go/)
  })

  it("无上下文时显式标'无上一条 assistant'", () => {
    const c: BroadCandidate = {
      messageId: "u-1",
      authorAlias: "小孙",
      createdAt: "t",
      content: "go",
      matchedKeyword: "commit:go",
      prevAssistantContent: null,
      prevAssistantId: null,
    }
    const p = buildJudgePrompt(c)
    assert.match(p, /无上一条 assistant/)
  })
})
