export const PROVIDERS = ["codex", "claude", "gemini"] as const;

export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_ALIASES: Record<Provider, string> = {
  codex: "\u8303\u5fb7\u5f6a",
  claude: "\u9ec4\u4ec1\u52cb",
  gemini: "\u6842\u82ac"
};
