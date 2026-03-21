import type { Provider } from "@multi-agent/shared";

export type MentionRouteResult = {
  provider: Provider | null;
};

export type MentionMatch = {
  provider: Provider;
  alias: string;
  index: number;
};

export type MentionMatchMode = "line-start" | "anywhere";

export function resolveMention(content: string, aliases: Record<Provider, string>) {
  const trimmed = content.trim();

  for (const provider of Object.keys(aliases) as Provider[]) {
    const alias = aliases[provider];
    const patterns = [`@${alias}`, `@${provider}`, `@${provider[0].toUpperCase()}${provider.slice(1)}`];

    if (patterns.some((pattern) => trimmed.toLowerCase().startsWith(pattern.toLowerCase()))) {
      return { provider } satisfies MentionRouteResult;
    }
  }

  return { provider: null } satisfies MentionRouteResult;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMentionPattern(candidate: string, mode: MentionMatchMode) {
  const escaped = escapeRegex(candidate);

  if (mode === "anywhere") {
    // User text may mention agents mid-sentence; avoid matching inside email/domain-like strings.
    return new RegExp(`(?<![\\w.-])@${escaped}(?=$|[\\s\`*_~:,.!?;()\\[\\]{}<>，。！？；：“”"'、])`, "gi");
  }

  // Agent-authored messages only trigger A2A on line-leading mentions.
  return new RegExp(`(?:^|\\n)[\\s\`*_~]*@${escaped}(?=$|[\\s:,.!?;()\\[\\]{}<>，。！？；：“”"'、])`, "gi");
}

export function resolveMentions(content: string, aliases: Record<Provider, string>, mode: MentionMatchMode = "line-start") {
  const matches: MentionMatch[] = [];

  for (const provider of Object.keys(aliases) as Provider[]) {
    const alias = aliases[provider];
    const patterns = [alias, provider, `${provider[0].toUpperCase()}${provider.slice(1)}`];

    for (const candidate of patterns) {
      const pattern = buildMentionPattern(candidate, mode);

      for (const match of content.matchAll(pattern)) {
        matches.push({
          provider,
          alias,
          index: match.index ?? -1
        });
      }
    }
  }

  return matches.sort((left, right) => left.index - right.index);
}
