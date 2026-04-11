import type { Provider } from "@multi-agent/shared"
import type { NextDispatch } from "../skills/registry.js"
import { resolveReviewerProvider } from "./reviewer-resolver"

export type PlanForcedDispatchInput = {
  nextDispatch: NextDispatch
  sourceProvider: Provider
  sourceAlias: string
  llmContent: string
  /**
   * Maps the resolved target provider → alias string (e.g. "范德彪") by
   * looking up the thread in the current session group. Returns null when
   * no matching thread exists yet.
   */
  resolveTargetAlias: (targetProvider: Provider) => string | null
}

export type ForcedDispatchPlan = {
  targetProvider: Provider
  targetAlias: string
  syntheticContent: string
}

/**
 * Plan a forced @-dispatch when a skill's `next_dispatch` fires.
 *
 * Returns a synthetic content string (to be fed back through
 * `dispatch.enqueuePublicMentions` by the caller) or null if:
 *  - the target role cannot be resolved to a provider,
 *  - the target provider has no thread in the group,
 *  - the LLM already mentioned the resolved alias on a line-start (manual
 *    hand-off) — in which case the natural path will deliver it.
 */
export function planForcedDispatch(
  input: PlanForcedDispatchInput,
): ForcedDispatchPlan | null {
  const targetProvider = resolveReviewerProvider(
    input.sourceProvider,
    input.nextDispatch.target,
  )
  if (!targetProvider) return null

  const targetAlias = input.resolveTargetAlias(targetProvider)
  if (!targetAlias) return null

  if (alreadyMentionedAtLineStart(input.llmContent, targetAlias)) {
    return null
  }

  const substituted = input.nextDispatch.promptTemplate.replace(
    /%TARGET%/g,
    targetAlias,
  )
  const syntheticContent = substituted.trimStart().startsWith(`@${targetAlias}`)
    ? substituted
    : `@${targetAlias} ${substituted}`

  return {
    targetProvider,
    targetAlias,
    syntheticContent,
  }
}

function alreadyMentionedAtLineStart(content: string, alias: string): boolean {
  const needle = `@${alias}`
  return content
    .split(/\r?\n/)
    .some((line) => line.trimStart().startsWith(needle))
}
