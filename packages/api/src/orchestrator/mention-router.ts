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

/**
 * Provider → @mention 别名（单名严格匹配）。
 * 只有这一个名字能路由，不接受 provider 代号作为 fallback。
 */
export type ProviderAliases = Record<Provider, string>

export function resolveMention(content: string, aliases: ProviderAliases) {
  const trimmed = content.trim().toLowerCase()

  for (const provider of Object.keys(aliases) as Provider[]) {
    const alias = aliases[provider]
    const pattern = alias.startsWith("@") ? alias : `@${alias}`
    if (trimmed.startsWith(pattern.toLowerCase())) {
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
  // Candidates may or may not already start with "@" — strip it for regex assembly.
  const bare = candidate.startsWith("@") ? candidate.slice(1) : candidate
  const escaped = escapeRegex(bare)

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
  aliases: ProviderAliases,
  mode: MentionMatchMode = "line-start",
) {
  const matches: MentionMatch[] = []

  for (const provider of Object.keys(aliases) as Provider[]) {
    const alias = aliases[provider]
    const bare = alias.startsWith("@") ? alias.slice(1) : alias
    const pattern = buildMentionPattern(alias, mode)

    for (const match of content.matchAll(pattern)) {
      matches.push({
        provider,
        alias: bare,
        index: match.index ?? -1,
      })
    }
  }

  return matches.sort((left, right) => left.index - right.index)
}
