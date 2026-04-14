import fs from "node:fs";
import path from "node:path";
import { PROVIDER_ALIASES, type Provider } from "@multi-agent/shared";

export type ProviderProfile = {
  provider: Provider;
  alias: string;
  currentModel: string | null;
  modelSuggestions: string[];
};

function getHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || "";
}

function readText(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))]
}

function detectCodexProfile(homeDir: string): ProviderProfile {
  const configPath = path.join(homeDir, ".codex", "config.toml");
  const modelsCachePath = path.join(homeDir, ".codex", "models_cache.json");
  const configText = readText(configPath);
  const currentModel = configText.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] ?? null;

  const cache = readJson<{ models?: Array<{ slug?: string; display_name?: string }> }>(modelsCachePath);
  const cacheModels =
    cache?.models?.flatMap((item) => [item.slug, item.display_name].filter(Boolean) as string[]) ?? [];

  return {
    provider: "codex",
    alias: PROVIDER_ALIASES.codex,
    currentModel,
    modelSuggestions: unique([currentModel, ...cacheModels])
  };
}

function collectClaudeModels(baseDir: string) {
  const projectDir = path.join(baseDir, "projects");
  const models: string[] = [];

  try {
    const projectEntries = fs.readdirSync(projectDir, { withFileTypes: true });
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory()) {
        continue;
      }

      const files = fs.readdirSync(path.join(projectDir, projectEntry.name));
      for (const fileName of files) {
        if (!fileName.endsWith(".jsonl")) {
          continue;
        }

        const text = readText(path.join(projectDir, projectEntry.name, fileName));
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) {
            continue;
          }

          try {
            const row = JSON.parse(line) as { message?: { model?: string } };
            if (row.message?.model) {
              models.push(row.message.model);
            }
          } catch {
          }
        }
      }
    }
  } catch {
    return [];
  }

  return models;
}

function detectClaudeProfile(homeDir: string): ProviderProfile {
  const baseDir = path.join(homeDir, ".claude");
  const historyModels = collectClaudeModels(baseDir);
  const currentModel = historyModels.at(-1) ?? null;

  return {
    provider: "claude",
    alias: PROVIDER_ALIASES.claude,
    currentModel,
    modelSuggestions: unique([currentModel, ...historyModels.slice(-12)])
  };
}

function collectGeminiModels(baseDir: string) {
  const tmpDir = path.join(baseDir, "tmp");
  const models: string[] = [];

  function walk(dirPath: string) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!entry.name.endsWith(".json")) {
        continue;
      }

      const text = readText(fullPath);
      for (const match of text.matchAll(/"model"\s*:\s*"([^"]+)"/g)) {
        if (match[1]) {
          models.push(match[1]);
        }
      }
    }
  }

  walk(tmpDir);
  return models;
}

function detectGeminiProfile(homeDir: string): ProviderProfile {
  const baseDir = path.join(homeDir, ".gemini");
  const historyModels = collectGeminiModels(baseDir);
  const currentModel = historyModels.at(-1) ?? null;

  return {
    provider: "gemini",
    alias: PROVIDER_ALIASES.gemini,
    currentModel,
    modelSuggestions: unique([currentModel, ...historyModels.slice(-12)])
  };
}

export function listProviderProfiles(): ProviderProfile[] {
  const homeDir = getHomeDir();

  return [
    detectCodexProfile(homeDir),
    detectClaudeProfile(homeDir),
    detectGeminiProfile(homeDir)
  ];
}
