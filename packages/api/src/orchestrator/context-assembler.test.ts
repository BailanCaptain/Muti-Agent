import assert from "node:assert/strict"
import test from "node:test"
import { assemblePrompt } from "./context-assembler"
import { POLICY_FULL, POLICY_GUARDIAN } from "./context-policy"
import { VISION_GUARDIAN_PROMPT } from "../runtime/agent-prompts"

// ── Vision Guardian mode ────────────────────────────────────────────────

test("visionGuardianMode replaces system prompt with VISION_GUARDIAN_PROMPT", async () => {
  const result = await assemblePrompt({
    provider: "claude",
    threadId: "t1",
    sessionGroupId: "sg1",
    nativeSessionId: null,
    policy: POLICY_GUARDIAN,
    task: "[vision-guardian] 请验收 F001\n\n## AC\n- [ ] 用户能登录",
    roomSnapshot: [],
    sourceAlias: "范德彪",
    targetAlias: "黄仁勋",
    visionGuardianMode: true,
  }, null)

  assert.equal(result.systemPrompt, VISION_GUARDIAN_PROMPT)
})

test("visionGuardianMode passes task as-is without A2A wrapping", async () => {
  const task = "[vision-guardian] 请验收 F001\n\n## AC\n- [ ] 用户能登录"
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
    visionGuardianMode: true,
  }, null)

  // Content should be the raw task, not wrapped with [A2A 协作请求] headers
  assert.equal(result.content, task)
  assert.ok(!result.content.includes("[A2A 协作请求"))
  assert.ok(!result.content.includes("你是 黄仁勋"))
})

test("visionGuardianMode strips all context injection", async () => {
  const result = await assemblePrompt({
    provider: "claude",
    threadId: "t1",
    sessionGroupId: "sg1",
    nativeSessionId: null,
    policy: POLICY_GUARDIAN,
    task: "验收 F001",
    roomSnapshot: [
      { agentId: "黄仁勋", role: "assistant", content: "我完成了实现" },
      { agentId: "范德彪", role: "assistant", content: "收到" },
    ],
    sourceAlias: "范德彪",
    targetAlias: "黄仁勋",
    visionGuardianMode: true,
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
