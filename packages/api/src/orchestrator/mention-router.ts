import type { Provider } from "@multi-agent/shared"

export type MentionRouteResult = {
  provider: Provider | null
}

export type MentionMatch = {
  provider: Provider
  alias: string
  index: number
}

export type MentionMatchMode = "line-start" | "anywhere"

export function resolveMention(content: string, aliases: Record<Provider, string>) {
  const trimmed = content.trim()

  for (const provider of Object.keys(aliases) as Provider[]) {
    const alias = aliases[provider]
    const patterns = [
      `@${alias}`,
      `@${provider}`,
      `@${provider[0].toUpperCase()}${provider.slice(1)}`,
    ]

    if (patterns.some((pattern) => trimmed.toLowerCase().startsWith(pattern.toLowerCase()))) {
      return { provider } satisfies MentionRouteResult
    }
  }

  return { provider: null } satisfies MentionRouteResult
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Shared terminator: characters that may legitimately follow an @alias.
// Includes Markdown emphasis chars (* _ ~) so that **@alias** and *@alias* are matched correctly.
const MENTION_TERMINATOR = String.raw`(?=$|[\s*_~:,.!?;()\[\]{}<>\uff0c\u3002\uff01\uff1f\uff1b\uff1a\u201c\u201d\u2018\u2019\u3001])`

function buildMentionPattern(candidate: string, mode: MentionMatchMode) {
  const escaped = escapeRegex(candidate)

  if (mode === "anywhere") {
    // User text may mention agents mid-sentence; avoid matching inside email/domain-like strings.
    return new RegExp(String.raw`(?<![\w.-])@` + escaped + MENTION_TERMINATOR, "gi")
  }

  // Agent-authored messages only trigger A2A on line-leading mentions.
  // Prefix allows whitespace and Markdown emphasis chars before the @.
  return new RegExp(String.raw`(?:^|\n)[\s*_~]*@` + escaped + MENTION_TERMINATOR, "gi")
}

export function resolveMentions(
  content: string,
  aliases: Record<Provider, string>,
  mode: MentionMatchMode = "line-start",
) {
  const matches: MentionMatch[] = []

  for (const provider of Object.keys(aliases) as Provider[]) {
    const alias = aliases[provider]
    const patterns = [alias, provider, `${provider[0].toUpperCase()}${provider.slice(1)}`]

    for (const candidate of patterns) {
      const pattern = buildMentionPattern(candidate, mode)

      for (const match of content.matchAll(pattern)) {
        matches.push({
          provider,
          alias,
          index: match.index ?? -1,
        })
      }
    }
  }

  return matches.sort((left, right) => left.index - right.index)
}
