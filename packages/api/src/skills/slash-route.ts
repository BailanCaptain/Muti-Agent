/**
 * F019 P4 (post-review): Explicit slash-command skill routing.
 *
 * The P4 deletion of prependSkillHint also removed the slash-command branch
 * (matchSlashCommand → "⚡ 加载 skill:" hint), leaving /guardian, /think,
 * /review, /debug, /feat, /plan, /merge etc. advertised by the manifest but
 * degraded to plain text at runtime. Codex P4 review [HIGH] flagged this as a
 * behavior regression.
 *
 * This helper restores ONLY the explicit-intent path — slash commands. It
 * deliberately does NOT re-introduce keyword-scan matching (that's the
 * regression F019 was built to kill). Slash syntax is user-typed intent; no
 * model heuristic, no content scan.
 *
 * Used by message-service.ts direct-turn flow. Keeps itself pure so it can be
 * unit-tested without MessageService harness.
 */

import type { SkillRegistry } from "./registry"

/**
 * Returns the one-line load-skill hint for an explicit slash command, or null
 * when the content doesn't start with a registered slash or no registry is
 * available. Pure — no side effects.
 */
export function resolveSlashSkillHint(
  content: string,
  registry: SkillRegistry | null | undefined,
): string | null {
  if (!registry) return null
  const matched = registry.matchSlashCommand(content)
  if (!matched) return null
  return `⚡ 加载 skill: ${matched.name} — 请按 skill 流程执行。`
}

/**
 * Prepend the slash-command hint (if any) to the user content with a blank
 * line separator. Used at the boundary where user text enters the CLI flow.
 * When no slash matches, returns the input unchanged — no behavior on plain
 * text, preserving the F019 P4 "no keyword scan" invariant.
 */
export function applySlashCommandHint(
  content: string,
  registry: SkillRegistry | null | undefined,
): string {
  const hint = resolveSlashSkillHint(content, registry)
  return hint ? `${hint}\n\n${content}` : content
}
