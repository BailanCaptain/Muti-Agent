const fs = require('fs');
const path = require('path');

const PROVIDER_MODEL_FALLBACKS = {
  codex: ['gpt-5.4', 'gpt-5-codex', 'gpt-5.1-codex-mini', 'o3'],
  claude: ['sonnet', 'opus', 'claude-sonnet-4-6', 'claude-opus-4-1'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-flash-preview'],
};

function readTextFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

function collectRegexMatches(text, regex) {
  const matches = [];
  if (!text) {
    return matches;
  }

  for (const match of text.matchAll(regex)) {
    if (match[1]) {
      matches.push(match[1]);
    } else if (match[0]) {
      matches.push(match[0]);
    }
  }

  return matches;
}

function getConfiguredCodexModel() {
  const configPath = path.join(process.env.USERPROFILE || '', '.codex', 'config.toml');
  const text = readTextFileSafe(configPath);
  const match = text.match(/^\s*model\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
}

function getConfiguredClaudeModel() {
  const settingsPath = path.join(process.env.USERPROFILE || '', '.claude', 'settings.json');
  const text = readTextFileSafe(settingsPath);
  if (!text) {
    return null;
  }

  try {
    const settings = JSON.parse(text);
    return settings.model || settings.defaultModel || null;
  } catch {
    return null;
  }
}

function getConfiguredGeminiModel() {
  const settingsPath = path.join(process.env.USERPROFILE || '', '.gemini', 'settings.json');
  const text = readTextFileSafe(settingsPath);
  if (!text) {
    return null;
  }

  try {
    const settings = JSON.parse(text);
    return settings.model || settings.selectedModel || null;
  } catch {
    return null;
  }
}

function getCodexModelSuggestions() {
  const cachePath = path.join(process.env.USERPROFILE || '', '.codex', 'models_cache.json');
  const text = readTextFileSafe(cachePath);
  if (!text) {
    return uniqueStrings([getConfiguredCodexModel(), ...PROVIDER_MODEL_FALLBACKS.codex]);
  }

  try {
    const parsed = JSON.parse(text);
    const models = Array.isArray(parsed.models) ? parsed.models : [];
    const slugs = models.map((item) => item && item.slug).filter(Boolean);
    return uniqueStrings([getConfiguredCodexModel(), ...slugs, ...PROVIDER_MODEL_FALLBACKS.codex]);
  } catch {
    return uniqueStrings([getConfiguredCodexModel(), ...PROVIDER_MODEL_FALLBACKS.codex]);
  }
}

function getClaudeModelSuggestions() {
  const settingsPath = path.join(process.env.USERPROFILE || '', '.claude', 'settings.json');
  const changelogPath = path.join(process.env.USERPROFILE || '', '.claude', 'cache', 'changelog.md');
  const settingsText = readTextFileSafe(settingsPath);
  const changelogText = readTextFileSafe(changelogPath);

  return uniqueStrings([
    getConfiguredClaudeModel(),
    ...collectRegexMatches(settingsText, /claude-[a-z0-9.-]+/gi),
    ...collectRegexMatches(changelogText, /claude-[a-z0-9.-]+/gi),
    ...PROVIDER_MODEL_FALLBACKS.claude,
  ]);
}

function getGeminiModelSuggestions() {
  const settingsPath = path.join(process.env.USERPROFILE || '', '.gemini', 'settings.json');
  const settingsText = readTextFileSafe(settingsPath);
  const historyRoots = [
    path.join(process.env.USERPROFILE || '', '.gemini', 'tmp', 'multi-agent', 'chats'),
    path.join(process.env.USERPROFILE || '', '.gemini', 'tmp', 'project', 'chats'),
  ];
  const historyMatches = [];

  for (const historyRoot of historyRoots) {
    try {
      if (!fs.existsSync(historyRoot)) {
        continue;
      }

      const names = fs.readdirSync(historyRoot).slice(-20);
      for (const name of names) {
        const text = readTextFileSafe(path.join(historyRoot, name));
        historyMatches.push(...collectRegexMatches(text, /gemini-[a-z0-9.-]+/gi));
      }
    } catch {
      // ignore local history issues
    }
  }

  return uniqueStrings([
    getConfiguredGeminiModel(),
    ...collectRegexMatches(settingsText, /gemini-[a-z0-9.-]+/gi),
    ...historyMatches,
    ...PROVIDER_MODEL_FALLBACKS.gemini,
  ]);
}

function getProviderModelSuggestions(provider) {
  if (provider === 'codex') {
    return getCodexModelSuggestions();
  }

  if (provider === 'claude') {
    return getClaudeModelSuggestions();
  }

  if (provider === 'gemini') {
    return getGeminiModelSuggestions();
  }

  return [];
}

module.exports = {
  getProviderModelSuggestions,
};
