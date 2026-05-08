/**
 * F026 A2A Envelope v1 — ADR-002/003/004 契约（Round 2）
 *
 * 两层结构：protocol（Call Tree 身份 · ADR-002）+ task（β/γ 双路径 · ADR-004）
 * 对 agent 层透明（I11）：agent 不填也不读这些字段 —— 只有 router/前端 代码消费
 */

export const ENVELOPE_VERSION = "v1" as const
export type EnvelopeVersion = typeof ENVELOPE_VERSION

export type DisplayMode = "inline" | "nested" | "background"
const DISPLAY_MODES: readonly DisplayMode[] = ["inline", "nested", "background"]

export interface EnvelopeProtocolV1 {
  call_id: string
  parent_call_id: string | null
  root_call_id: string
  issuer_id: string
  convener_id: string
  on_behalf_of: string | null
  reply_to: string
  deadline: string // ISO-8601
}

export interface EnvelopeContextV1 {
  burst: string[] | null
  tombstone: string[] | null
  rolling_summary: string | null
}

export interface EnvelopeRenderV1 {
  displayMode: DisplayMode
}

// β (ADR-004 附录 A) · 日常 A2A 对话 — 原文直达，不抽取结构化
export interface EnvelopeTaskBetaV1 {
  task: "conversation"
  input: { source_message: string }
  expected_output: null
  constraints: null
  context: EnvelopeContextV1
  render: EnvelopeRenderV1
}

// γ · 正式交接（cross-role-handoff skill 模板填充）
export interface EnvelopeTaskGammaV1 {
  task: string // 非 "conversation"
  input: Record<string, unknown>
  expected_output: string | null
  constraints: string[] | null
  context: EnvelopeContextV1
  render: EnvelopeRenderV1
}

export type EnvelopeTaskV1 = EnvelopeTaskBetaV1 | EnvelopeTaskGammaV1

export interface EnvelopeV1 {
  envelope_version: EnvelopeVersion
  protocol: EnvelopeProtocolV1
  task: EnvelopeTaskV1
}

export function isBetaTask(task: EnvelopeTaskV1): task is EnvelopeTaskBetaV1 {
  return task.task === "conversation"
}

export function isGammaTask(task: EnvelopeTaskV1): task is EnvelopeTaskGammaV1 {
  return task.task !== "conversation"
}

function requireString(path: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `F026 Envelope invalid: ${path} must be non-empty string (got ${JSON.stringify(value)})`,
    )
  }
  return value
}

function requireStringOrNull(path: string, value: unknown): string | null {
  if (value === null) return null
  return requireString(path, value)
}

/**
 * Runtime shape assertion. Throws if the object is not a valid EnvelopeV1.
 * Intentionally explicit (no zod dep) — Envelope is a hot-path structure
 * and error messages must pinpoint which field failed for router debugging.
 */
export function assertValidEnvelopeV1(value: unknown): asserts value is EnvelopeV1 {
  if (typeof value !== "object" || value === null) {
    throw new Error("F026 Envelope invalid: expected object")
  }
  const env = value as Record<string, unknown>

  if (env.envelope_version !== ENVELOPE_VERSION) {
    throw new Error(
      `F026 Envelope invalid: envelope_version must be "${ENVELOPE_VERSION}" (got ${JSON.stringify(env.envelope_version)})`,
    )
  }

  const protocol = env.protocol as Record<string, unknown> | undefined
  if (!protocol || typeof protocol !== "object") {
    throw new Error("F026 Envelope invalid: protocol must be object")
  }
  requireString("protocol.call_id", protocol.call_id)
  requireStringOrNull("protocol.parent_call_id", protocol.parent_call_id)
  requireString("protocol.root_call_id", protocol.root_call_id)
  requireString("protocol.issuer_id", protocol.issuer_id)
  requireString("protocol.convener_id", protocol.convener_id)
  requireStringOrNull("protocol.on_behalf_of", protocol.on_behalf_of)
  requireString("protocol.reply_to", protocol.reply_to)
  const deadline = requireString("protocol.deadline", protocol.deadline)
  if (Number.isNaN(Date.parse(deadline))) {
    throw new Error(
      `F026 Envelope invalid: protocol.deadline must be ISO-8601 parseable (got ${JSON.stringify(deadline)})`,
    )
  }

  const task = env.task as Record<string, unknown> | undefined
  if (!task || typeof task !== "object") {
    throw new Error("F026 Envelope invalid: task must be object")
  }

  const taskName = task.task
  if (typeof taskName !== "string" || taskName.length === 0) {
    throw new Error("F026 Envelope invalid: task.task must be non-empty string")
  }

  const input = task.input
  if (typeof input !== "object" || input === null) {
    throw new Error("F026 Envelope invalid: task.input must be object")
  }
  if (taskName === "conversation") {
    const sourceMessage = (input as Record<string, unknown>).source_message
    if (typeof sourceMessage !== "string" || sourceMessage.length === 0) {
      throw new Error(
        "F026 Envelope invalid (β): task.input.source_message must be non-empty string",
      )
    }
    if (task.expected_output !== null) {
      throw new Error("F026 Envelope invalid (β): task.expected_output must be null")
    }
    if (task.constraints !== null) {
      throw new Error("F026 Envelope invalid (β): task.constraints must be null")
    }
  }

  const context = task.context as Record<string, unknown> | undefined
  if (!context || typeof context !== "object") {
    throw new Error("F026 Envelope invalid: task.context must be object")
  }
  if (context.burst !== null && !Array.isArray(context.burst)) {
    throw new Error("F026 Envelope invalid: task.context.burst must be string[] | null")
  }
  if (context.tombstone !== null && !Array.isArray(context.tombstone)) {
    throw new Error("F026 Envelope invalid: task.context.tombstone must be string[] | null")
  }
  if (context.rolling_summary !== null && typeof context.rolling_summary !== "string") {
    throw new Error("F026 Envelope invalid: task.context.rolling_summary must be string | null")
  }

  const render = task.render as Record<string, unknown> | undefined
  if (!render || typeof render !== "object") {
    throw new Error("F026 Envelope invalid: task.render must be object")
  }
  if (!DISPLAY_MODES.includes(render.displayMode as DisplayMode)) {
    throw new Error(
      `F026 Envelope invalid: task.render.displayMode must be one of ${JSON.stringify(DISPLAY_MODES)} (got ${JSON.stringify(render.displayMode)})`,
    )
  }
}
