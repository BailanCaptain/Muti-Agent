import type { RecallScenario } from "./adaptive-recall-coordinator"

/**
 * F042 AC1 · direct_turn 召回三态。
 *   off    — 维持 F027 现状：direct_turn scenario_skip，永不召回
 *   shadow — 全召回链真跑 + 写 prompt_audit，但不注入 prompt（默认：先攒数据再放开注入）
 *   inject — 召回结果真注入（与 wake_up 同等待遇）
 * env: MULTI_AGENT_DIRECT_TURN_RECALL，boot 读一次；非法值 fail-safe 到 shadow。
 */
export type DirectTurnRecallMode = "off" | "shadow" | "inject"

export function parseDirectTurnRecallMode(raw: string | undefined): DirectTurnRecallMode {
  const v = raw?.trim().toLowerCase()
  if (v === "off" || v === "inject") return v
  return "shadow"
}

const BASE_TRIGGER_SCENARIOS: ReadonlyArray<RecallScenario> = ["wake_up", "a2a_handoff"]

/** off → F027 默认白名单；shadow/inject → 扩 direct_turn（拦截注入是 shadow 的事，白名单只管跑不跑链）。 */
export function resolveTriggerScenarios(mode: DirectTurnRecallMode): ReadonlyArray<RecallScenario> {
  return mode === "off" ? BASE_TRIGGER_SCENARIOS : [...BASE_TRIGGER_SCENARIOS, "direct_turn"]
}
