import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  type EnvelopeTaskBetaV1,
  type EnvelopeTaskGammaV1,
  type EnvelopeV1,
  assertValidEnvelopeV1,
  isBetaTask,
  isGammaTask,
} from "./a2a-envelope"

const baseProtocol = {
  call_id: "call-1",
  parent_call_id: null,
  root_call_id: "call-1",
  issuer_id: "黄仁勋",
  convener_id: "小孙",
  on_behalf_of: null,
  reply_to: "agent:黄仁勋",
  deadline: "2026-04-23T14:00:00.000Z",
}

const baseContext = {
  burst: null,
  tombstone: null,
  rolling_summary: null,
}

const betaTask: EnvelopeTaskBetaV1 = {
  task: "conversation",
  input: { source_message: "@范德彪 帮小孙 review 一下" },
  expected_output: null,
  constraints: null,
  context: baseContext,
  render: { displayMode: "inline" },
}

const gammaTask: EnvelopeTaskGammaV1 = {
  task: "review",
  input: { patch: "..." },
  expected_output: "approve / request-changes + findings",
  constraints: ["30min deadline"],
  context: baseContext,
  render: { displayMode: "nested" },
}

test("F026 I8: valid β envelope passes assertValidEnvelopeV1", () => {
  const env: EnvelopeV1 = { envelope_version: "v1", protocol: baseProtocol, task: betaTask }
  assertValidEnvelopeV1(env)
})

test("F026 I8: valid γ envelope passes assertValidEnvelopeV1", () => {
  const env: EnvelopeV1 = { envelope_version: "v1", protocol: baseProtocol, task: gammaTask }
  assertValidEnvelopeV1(env)
})

test("F026 I8: missing envelope_version throws", () => {
  const bad = { protocol: baseProtocol, task: betaTask } as unknown as EnvelopeV1
  assert.throws(() => assertValidEnvelopeV1(bad), /envelope_version/)
})

test("F026 I8: envelope_version !== 'v1' throws", () => {
  const bad = {
    envelope_version: "v2",
    protocol: baseProtocol,
    task: betaTask,
  } as unknown as EnvelopeV1
  assert.throws(() => assertValidEnvelopeV1(bad), /envelope_version/)
})

test("F026 I8: missing protocol field throws", () => {
  const bad = {
    envelope_version: "v1",
    protocol: { ...baseProtocol, call_id: undefined },
    task: betaTask,
  } as unknown as EnvelopeV1
  assert.throws(() => assertValidEnvelopeV1(bad), /protocol\.call_id/)
})

test("F026 I8 / ADR-004 β: β task.input must contain source_message", () => {
  const bad = {
    envelope_version: "v1",
    protocol: baseProtocol,
    task: { ...betaTask, input: {} },
  } as unknown as EnvelopeV1
  assert.throws(() => assertValidEnvelopeV1(bad), /source_message/)
})

test("F026 I8: illegal displayMode throws", () => {
  const bad = {
    envelope_version: "v1",
    protocol: baseProtocol,
    task: { ...betaTask, render: { displayMode: "popup" } },
  } as unknown as EnvelopeV1
  assert.throws(() => assertValidEnvelopeV1(bad), /displayMode/)
})

test("F026 ADR-004: isBetaTask discriminates task='conversation'", () => {
  assert.equal(isBetaTask(betaTask), true)
  assert.equal(isBetaTask(gammaTask), false)
})

test("F026 ADR-004: isGammaTask discriminates task!='conversation'", () => {
  assert.equal(isGammaTask(gammaTask), true)
  assert.equal(isGammaTask(betaTask), false)
})

test("F026 I8: deadline must be ISO-parseable string", () => {
  const bad = {
    envelope_version: "v1",
    protocol: { ...baseProtocol, deadline: "not-a-date" },
    task: betaTask,
  } as unknown as EnvelopeV1
  assert.throws(() => assertValidEnvelopeV1(bad), /deadline/)
})

test("F026 I10: convener_id must be non-empty string", () => {
  const bad = {
    envelope_version: "v1",
    protocol: { ...baseProtocol, convener_id: "" },
    task: betaTask,
  } as unknown as EnvelopeV1
  assert.throws(() => assertValidEnvelopeV1(bad), /convener_id/)
})
