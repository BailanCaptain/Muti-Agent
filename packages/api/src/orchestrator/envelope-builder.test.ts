import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { assertValidEnvelopeV1, isBetaTask, isGammaTask } from "@multi-agent/shared"
import { SqliteStore } from "../db/sqlite"
import { CallRegistry } from "./call-registry"
import { buildBetaEnvelope, buildGammaEnvelope } from "./envelope-builder"

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-env-builder-"))
  const store = new SqliteStore(path.join(dir, "db.sqlite"))
  const now = () => "2026-04-23T13:00:00.000Z"
  const registry = new CallRegistry({ db: store.db, now })
  return {
    registry,
    store,
    dir,
    now,
    close: () => {
      try {
        store.db.close()
      } catch {}
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    },
  }
}

test("F026 ADR-004 β: buildBetaEnvelope 返回合法 EnvelopeV1 · task='conversation'", () => {
  const h = harness()
  try {
    const callId = h.registry.openCall({
      issuerId: "黄仁勋",
      convenerId: "小孙",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })

    const env = buildBetaEnvelope({
      callId,
      registry: h.registry,
      sourceMessage: "@范德彪 帮小孙 review PR",
      context: { burst: null, tombstone: null, rolling_summary: null },
    })

    assertValidEnvelopeV1(env)
    assert.equal(env.envelope_version, "v1")
    assert.equal(env.protocol.call_id, callId)
    assert.equal(env.protocol.parent_call_id, null)
    assert.equal(env.protocol.root_call_id, callId)
    assert.equal(env.protocol.issuer_id, "黄仁勋")
    assert.equal(env.protocol.convener_id, "小孙")
    assert.ok(isBetaTask(env.task))
    if (isBetaTask(env.task)) {
      assert.equal(env.task.task, "conversation")
      assert.equal(env.task.input.source_message, "@范德彪 帮小孙 review PR")
      assert.equal(env.task.expected_output, null)
      assert.equal(env.task.constraints, null)
    }
  } finally {
    h.close()
  }
})

test("F026 ADR-004 β: displayMode='nested' when parent exists, 'inline' otherwise", () => {
  const h = harness()
  try {
    const root = h.registry.openCall({
      issuerId: "小孙",
      convenerId: "小孙",
      replyTo: "user:小孙",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })
    const child = h.registry.openCall({
      parentCallId: root,
      issuerId: "黄仁勋",
      convenerId: "小孙",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })
    const rootEnv = buildBetaEnvelope({ callId: root, registry: h.registry, sourceMessage: "hi" })
    const childEnv = buildBetaEnvelope({ callId: child, registry: h.registry, sourceMessage: "hi" })
    assert.equal(rootEnv.task.render.displayMode, "inline")
    assert.equal(childEnv.task.render.displayMode, "nested")
  } finally {
    h.close()
  }
})

test("F026 ADR-004 γ: buildGammaEnvelope 携带结构化 task/input/expected/constraints", () => {
  const h = harness()
  try {
    const callId = h.registry.openCall({
      issuerId: "黄仁勋",
      convenerId: "范德彪",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })
    const env = buildGammaEnvelope({
      callId,
      registry: h.registry,
      task: "review",
      input: { patch: "diff contents" },
      expectedOutput: "approve / request-changes + findings",
      constraints: ["30min deadline", "focus on P1"],
    })

    assertValidEnvelopeV1(env)
    assert.equal(env.envelope_version, "v1")
    assert.ok(isGammaTask(env.task))
    if (isGammaTask(env.task)) {
      assert.equal(env.task.task, "review")
      assert.deepEqual(env.task.input, { patch: "diff contents" })
      assert.equal(env.task.expected_output, "approve / request-changes + findings")
      assert.deepEqual(env.task.constraints, ["30min deadline", "focus on P1"])
    }
  } finally {
    h.close()
  }
})

test("F026 ADR-004 β: context 字段默认 null（Phase 3 生成器尚未挂）", () => {
  const h = harness()
  try {
    const callId = h.registry.openCall({
      issuerId: "A",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })
    const env = buildBetaEnvelope({ callId, registry: h.registry, sourceMessage: "hello" })
    assert.equal(env.task.context.burst, null)
    assert.equal(env.task.context.tombstone, null)
    assert.equal(env.task.context.rolling_summary, null)
  } finally {
    h.close()
  }
})

test("F026 ADR-004: 未知 callId 抛错（envelope 不能凭空创造）", () => {
  const h = harness()
  try {
    assert.throws(
      () =>
        buildBetaEnvelope({ callId: "does-not-exist", registry: h.registry, sourceMessage: "x" }),
      /not found|unknown/i,
    )
  } finally {
    h.close()
  }
})

test("F026 ADR-004 β: on_behalf_of 从 call-registry 透传", () => {
  const h = harness()
  try {
    const callId = h.registry.openCall({
      issuerId: "黄仁勋",
      convenerId: "小孙",
      onBehalfOf: "小孙",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })
    const env = buildBetaEnvelope({
      callId,
      registry: h.registry,
      sourceMessage: "@范德彪 帮小孙 review",
    })
    assert.equal(env.protocol.on_behalf_of, "小孙")
    assert.equal(env.protocol.convener_id, "小孙", "convener 豁免到 on_behalf_of")
  } finally {
    h.close()
  }
})
