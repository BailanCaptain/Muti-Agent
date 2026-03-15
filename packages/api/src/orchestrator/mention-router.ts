import type { Provider } from "@multi-agent/shared";

export type MentionRouteResult = {
  provider: Provider | null;
};

export type MentionMatch = {
  provider: Provider;
  alias: string;
  index: number;
};

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

export function resolveMentions(content: string, aliases: Record<Provider, string>) {
  const matches: MentionMatch[] = [];

  for (const provider of Object.keys(aliases) as Provider[]) {
    const alias = aliases[provider];
    const patterns = [alias, provider, `${provider[0].toUpperCase()}${provider.slice(1)}`];

    for (const candidate of patterns) {
      // Only match @mention at the start of a line, allowing optional
      // whitespace and markdown formatting chars (backticks, bold, italic).
      const pattern = new RegExp(`(?:^|\\n)[\\s\`*_~]*@${escapeRegex(candidate)}`, "gi");

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
