import assert from "node:assert/strict"
import test from "node:test"
import { assembleDirectTurnPrompt, assemblePrompt } from "./context-assembler"
import type { ContextMessage } from "./context-snapshot"
import { POLICY_FULL, POLICY_GUARDIAN } from "./context-policy"
import { ACCEPTANCE_GUARDIAN_PROMPT } from "../runtime/agent-prompts"

// ── Guardian mode ───────────────────────────────────────────────────────

test("guardianMode replaces system prompt with ACCEPTANCE_GUARDIAN_PROMPT", async () => {
  const result = await assemblePrompt({
    provider: "claude",
    threadId: "t1",
    sessionGroupId: "sg1",
    nativeSessionId: null,
    policy: POLICY_GUARDIAN,
    task: "[acceptance-guardian] 请验收 F001\n\n## AC\n- [ ] 用户能登录",
    roomSnapshot: [],
    sourceAlias: "范德彪",
    targetAlias: "黄仁勋",
    guardianMode: true,
  }, null)

  assert.equal(result.systemPrompt, ACCEPTANCE_GUARDIAN_PROMPT)
})

test("guardianMode passes task as-is without A2A wrapping", async () => {
  const task = "[acceptance-guardian] 请验收 F001\n\n## AC\n- [ ] 用户能登录"
  const result = await assemblePrompt({
    provider: "claude",
    threadId: "t1",
    sessionGroupId: "sg1",
    nativeSessionId: null,
    policy: POLICY_GUARDIAN,
    task,
    roomSnapshot: [],
    sourceAlias: "范德彪",
    targetAlias: "黄仁勋",
    guardianMode: true,
  }, null)

  // Content should be the raw task, not wrapped with [A2A 协作请求] headers
  assert.equal(result.content, task)
  assert.ok(!result.content.includes("[A2A 协作请求"))
  assert.ok(!result.content.includes("你是 黄仁勋"))
})

test("guardianMode strips all context injection", async () => {
  const result = await assemblePrompt({
    provider: "claude",
    threadId: "t1",
    sessionGroupId: "sg1",
    nativeSessionId: null,
    policy: POLICY_GUARDIAN,
    task: "验收 F001",
    roomSnapshot: [
      { id: "msg-1", agentId: "黄仁勋", role: "assistant" as const, content: "我完成了实现", createdAt: "2026-01-01T00:00:00Z" },
      { id: "msg-2", agentId: "范德彪", role: "assistant" as const, content: "收到", createdAt: "2026-01-01T00:00:01Z" },
    ],
    sourceAlias: "范德彪",
    targetAlias: "黄仁勋",
    guardianMode: true,
  }, null)

  // No room context leaks
  assert.ok(!result.content.includes("我完成了实现"))
  assert.ok(!result.content.includes("近期对话"))
  assert.ok(!result.systemPrompt.includes("家规"))
  assert.ok(!result.systemPrompt.includes("名册"))
})

// ── Normal mode (no guardian) ───────────────────────────────────────────

test("normal mode uses AGENT_SYSTEM_PROMPTS and wraps content", async () => {
  const result = await assemblePrompt({
    provider: "claude",
    threadId: "t1",
    sessionGroupId: "sg1",
    nativeSessionId: null,
    policy: POLICY_FULL,
    task: "实现登录功能",
    roomSnapshot: [],
    sourceAlias: "user",
    targetAlias: "黄仁勋",
  }, null)

  // System prompt contains identity
  assert.ok(result.systemPrompt.includes("黄仁勋"))
  // Content is wrapped with A2A headers
  assert.ok(result.content.includes("[用户请求]"))
  assert.ok(result.content.includes("你是 黄仁勋"))
})

// ── POLICY_GUARDIAN shape ───────────────────────────────────────────────

test("POLICY_GUARDIAN has all context injection disabled", () => {
  assert.equal(POLICY_GUARDIAN.injectRollingSummary, false)
  assert.equal(POLICY_GUARDIAN.injectSelfHistory, false)
  assert.equal(POLICY_GUARDIAN.injectSharedHistory, false)
  assert.equal(POLICY_GUARDIAN.injectPreamble, false)
  assert.equal(POLICY_GUARDIAN.phase1Header, false)
})

// ── F004 / B005 regression: direct turn must inject room history ───────
//
// Before F004, assembleDirectTurnPrompt returned only a systemPrompt string
// and never embedded roomSnapshot — so when the user sent a direct @-mention
// turn with a non-null nativeSessionId, the agent went into "amnesia" because
// the whole room history was skipped (the runtime trusted CLI --resume to
// recover memory, which proved unreliable). This regression test locks in
// the new contract: assembleDirectTurnPrompt accepts a single input object
// (mirroring assemblePrompt) with roomSnapshot, and returns a {systemPrompt,
// content} pair whose content embeds the real history verbatim even when
// nativeSessionId is non-null.
test("B005 regression — assembleDirectTurnPrompt injects roomSnapshot into content even with non-null nativeSessionId", async () => {
  const roomSnapshot: ContextMessage[] = [
    {
      id: "msg-0",
      role: "user",
      agentId: "user",
      content: "我们要推进 F004，请先看一下 reference-code 里的最佳实践。",
      createdAt: "2026-04-11T00:00:00.000Z",
    },
    {
      id: "msg-1",
      role: "assistant",
      agentId: "黄仁勋",
      content: "收到，我已经读过 reference-code/ 下三份参考实现，准备开工。",
      createdAt: "2026-04-11T00:00:01.000Z",
    },
    {
      id: "msg-2",
      role: "user",
      agentId: "user",
      content: "好，继续推进 F004 的 TDD red phase。",
      createdAt: "2026-04-11T00:00:02.000Z",
    },
  ]

  const result = await assembleDirectTurnPrompt({
    provider: "claude",
    threadId: "t-f004",
    sessionGroupId: "sg-f004",
    nativeSessionId: "sess-abc",
    task: "继续推进",
    sourceAlias: "user",
    targetAlias: "黄仁勋",
    roomSnapshot,
  }, null)

  // Content must embed real history — no more skip-trap on non-null nativeSessionId.
  assert.match(result.content, /F004/)
  assert.match(result.content, /reference-code/)
  assert.match(result.content, /继续推进/)
})
