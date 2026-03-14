export const PROVIDERS = ["codex", "claude", "gemini"] as const;

export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_ALIASES: Record<Provider, string> = {
  codex: "范德彪",
  claude: "黄仁勋",
  gemini: "桂芬"
};
