/**
 * F026 Phase 2 · ADR-004 content-layer guard (detector)
 *
 * The Phase 1 diff-size guard (`check-adr-004-diff.sh`) is blind to
 * net-zero swaps. This detector extends the gate with a content scan for
 * the A2A protocol tokens that MUST NOT appear in the agent-prompt layer
 * (ADR-004): `Direct message from`, `a2aFrom`, `triggerMessage`.
 *
 * Why these three:
 * - "Direct message from …" is the F003-era prompt injection the parent
 *   agent used to read about being @-ed — the canonical ADR-004 violation.
 * - `a2aFrom` / `triggerMessage` are the identifier names clowder used for
 *   the equivalent fields; guarding both prevents copy-paste regressions.
 *
 * The detector is pure; callers scan file contents and fail the build
 * when a hit appears in any of the four guarded files.
 */

const FORBIDDEN_TOKENS: ReadonlyArray<string> = [
  "Direct message from",
  "a2aFrom",
  "triggerMessage",
]

export function findForbiddenAdr004Tokens(content: string): string[] {
  const lower = content.toLowerCase()
  const hits: string[] = []
  for (const token of FORBIDDEN_TOKENS) {
    if (lower.includes(token.toLowerCase())) {
      hits.push(token)
    }
  }
  return hits
}

export const ADR_004_FORBIDDEN_TOKENS = FORBIDDEN_TOKENS
