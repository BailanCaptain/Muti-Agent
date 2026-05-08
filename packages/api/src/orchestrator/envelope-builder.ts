/**
 * F026 ADR-004 · Envelope Builder
 *
 * 在消息出站的纳秒级构造 EnvelopeV1 两层结构。对 agent 层透明 —
 * 所有字段来自 call-registry / 上下文服务 / 规则推导，agent 一字未填。
 *
 * β 路径（buildBetaEnvelope）：日常 A2A 对话，task='conversation'，
 *   input.source_message = agent 原文整段；不抽取结构化字段。
 *
 * γ 路径（buildGammaEnvelope）：cross-role-handoff skill 触发的正式交接，
 *   skill 模板直接提供 task/input/expected_output/constraints。
 */

import {
  type DisplayMode,
  ENVELOPE_VERSION,
  type EnvelopeContextV1,
  type EnvelopeRenderV1,
  type EnvelopeV1,
} from "@multi-agent/shared"
import type { CallRegistry, CallRow } from "./call-registry"

const DEFAULT_CONTEXT: EnvelopeContextV1 = {
  burst: null,
  tombstone: null,
  rolling_summary: null,
}

function renderFor(call: CallRow): EnvelopeRenderV1 {
  const displayMode: DisplayMode = call.parentCallId ? "nested" : "inline"
  return { displayMode }
}

function loadCall(registry: CallRegistry, callId: string): CallRow {
  const call = registry.get(callId)
  if (!call) {
    throw new Error(`envelope-builder: call_id '${callId}' not found in registry`)
  }
  return call
}

export interface BuildBetaEnvelopeInput {
  callId: string
  registry: CallRegistry
  sourceMessage: string
  context?: EnvelopeContextV1
  displayMode?: DisplayMode
}

export function buildBetaEnvelope(input: BuildBetaEnvelopeInput): EnvelopeV1 {
  const call = loadCall(input.registry, input.callId)
  const context = input.context ?? DEFAULT_CONTEXT
  const render = input.displayMode ? { displayMode: input.displayMode } : renderFor(call)
  return {
    envelope_version: ENVELOPE_VERSION,
    protocol: {
      call_id: call.callId,
      parent_call_id: call.parentCallId,
      root_call_id: call.rootCallId,
      issuer_id: call.issuerId,
      convener_id: call.convenerId,
      on_behalf_of: call.onBehalfOf,
      reply_to: call.replyTo,
      deadline: call.deadlineAt,
    },
    task: {
      task: "conversation",
      input: { source_message: input.sourceMessage },
      expected_output: null,
      constraints: null,
      context,
      render,
    },
  }
}

export interface BuildGammaEnvelopeInput {
  callId: string
  registry: CallRegistry
  task: string // cross-role-handoff skill 模板提供
  input: Record<string, unknown>
  expectedOutput: string | null
  constraints: string[] | null
  context?: EnvelopeContextV1
  displayMode?: DisplayMode
}

export function buildGammaEnvelope(input: BuildGammaEnvelopeInput): EnvelopeV1 {
  if (input.task === "conversation") {
    throw new Error("envelope-builder: γ path cannot use task='conversation' (reserved for β)")
  }
  const call = loadCall(input.registry, input.callId)
  const context = input.context ?? DEFAULT_CONTEXT
  const render = input.displayMode ? { displayMode: input.displayMode } : renderFor(call)
  return {
    envelope_version: ENVELOPE_VERSION,
    protocol: {
      call_id: call.callId,
      parent_call_id: call.parentCallId,
      root_call_id: call.rootCallId,
      issuer_id: call.issuerId,
      convener_id: call.convenerId,
      on_behalf_of: call.onBehalfOf,
      reply_to: call.replyTo,
      deadline: call.deadlineAt,
    },
    task: {
      task: input.task,
      input: input.input,
      expected_output: input.expectedOutput,
      constraints: input.constraints,
      context,
      render,
    },
  }
}
