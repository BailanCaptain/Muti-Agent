import type { DecisionOption, DecisionRequest } from "@multi-agent/shared"

// F033 · MCP kind → 内部 DecisionRequest kind 映射的唯一真相。
// MCP 面：select / multi_select / confirm（不传 = legacy multi_choice + multiSelect 透传）。
// fan_in_selector 不在此面上（F002 A2A fan-in 专用，只有内部调用方）。

export type DecisionCallbackKindInput = {
  kind?: string
  options?: DecisionOption[]
  multiSelect?: boolean
}

export type ResolvedDecisionParams = {
  kind: Extract<DecisionRequest["kind"], "multi_choice" | "inline_confirmation">
  options: DecisionOption[]
  multiSelect: boolean
}

export type ResolveDecisionResult =
  | { ok: true; value: ResolvedDecisionParams }
  | { ok: false; error: string }

const CONFIRM_DEFAULT_OPTIONS: DecisionOption[] = [
  { id: "confirm", label: "确认" },
  { id: "cancel", label: "取消" },
]

export function resolveDecisionParams(input: DecisionCallbackKindInput): ResolveDecisionResult {
  const kind = input.kind

  if (kind === "confirm") {
    const options = input.options?.length ? input.options : CONFIRM_DEFAULT_OPTIONS
    if (options.length < 2) {
      return { ok: false, error: "confirm 自带 options 时至少需要 2 个（确认/取消语义）。" }
    }
    return { ok: true, value: { kind: "inline_confirmation", options, multiSelect: false } }
  }

  if (kind === undefined || kind === "select" || kind === "multi_select") {
    if (!input.options || input.options.length < 2) {
      return { ok: false, error: "至少需要 2 个选项。" }
    }
    const multiSelect =
      kind === "multi_select" ? true : kind === "select" ? false : (input.multiSelect ?? false)
    return { ok: true, value: { kind: "multi_choice", options: input.options, multiSelect } }
  }

  // fail-closed：未知 kind 不静默降级成 select，直接拒绝
  return { ok: false, error: `未知 kind: ${kind}（支持 select / multi_select / confirm）。` }
}
