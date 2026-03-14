const { spawn } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const path = require('path');
const readline = require('readline');

const PROVIDERS = ['codex', 'claude', 'gemini'];
const PROVIDER_PERSONAS = {
  codex: { alias: '范德彪', fallbackModel: null },
  claude: { alias: '黄仁勋', fallbackModel: null },
  gemini: { alias: '桂芬', fallbackModel: null },
};

function normalizeProvider(value) {
  const input = String(value || '').toLowerCase();
  const aliases = {
    c: 'codex',
    codex: 'codex',
    cl: 'claude',
    claude: 'claude',
    g: 'gemini',
    gemini: 'gemini',
  };

  return aliases[input] || null;
}

function resolveNpmRoot() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming', 'npm'),
  ];

  return candidates.find((candidate) => candidate && existsSync(candidate)) || '';
}

function readTextFileSafe(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function getConfiguredCodexModel() {
  const configPath = path.join(process.env.USERPROFILE || '', '.codex', 'config.toml');
  const text = readTextFileSafe(configPath);
  const match = text.match(/^\s*model\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
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

function getProviderProfile(provider) {
  const normalized = normalizeProvider(provider);
  if (!normalized) {
    return null;
  }

  const persona = PROVIDER_PERSONAS[normalized];
  const configuredModel =
    normalized === 'codex'
      ? getConfiguredCodexModel()
      : normalized === 'claude'
        ? getConfiguredClaudeModel()
        : getConfiguredGeminiModel();

  return {
    provider: normalized,
    alias: persona.alias,
    currentModel: configuredModel || persona.fallbackModel || null,
  };
}

function listProviderProfiles() {
  return PROVIDERS.map((provider) => getProviderProfile(provider));
}

function resolveCodexCommand() {
  const npmRoot = resolveNpmRoot();
  const codexJs = npmRoot
    ? path.join(npmRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    : null;

  if (codexJs && existsSync(codexJs)) {
    return { command: process.execPath, prefixArgs: [codexJs] };
  }

  return { command: 'codex.cmd', prefixArgs: [], shell: true };
}

function resolveNodeScript(packageName, relativeScriptPath, extraNodeArgs = []) {
  const npmRoot = resolveNpmRoot();
  const scriptPath = npmRoot
    ? path.join(npmRoot, 'node_modules', packageName, ...relativeScriptPath)
    : '';

  if (scriptPath && existsSync(scriptPath)) {
    return {
      command: process.execPath,
      prefixArgs: [...extraNodeArgs, scriptPath],
      shell: false,
    };
  }

  return {
    command: path.basename(relativeScriptPath[relativeScriptPath.length - 1], '.js'),
    prefixArgs: [],
    shell: true,
  };
}

function buildHistoryPrompt(history, userMessage) {
  if (!Array.isArray(history) || history.length === 0) {
    return userMessage;
  }

  const recentHistory = history.slice(-12);
  const transcript = recentHistory
    .map((message) => {
      const role = message.role === 'assistant' ? 'Assistant' : 'User';
      return `${role}: ${message.content}`;
    })
    .join('\n\n');

  return [
    'Continue the conversation below.',
    'Keep the existing context and answer the final user message directly.',
    '',
    transcript,
    '',
    `User: ${userMessage}`,
  ].join('\n');
}

function buildCommand(provider, prompt, nativeSessionId, selectedModel) {
  if (provider === 'codex') {
    const resolved = resolveCodexCommand();
    const modelArgs = selectedModel ? ['-m', selectedModel] : [];
    const baseArgs = nativeSessionId
      ? ['exec', 'resume', '--skip-git-repo-check', '--json', nativeSessionId, prompt]
      : ['exec', '--skip-git-repo-check', '--json', prompt];

    return {
      command: resolved.command,
      args: [...resolved.prefixArgs, ...modelArgs, ...baseArgs],
      shell: Boolean(resolved.shell),
    };
  }

  if (provider === 'claude') {
    const resolved = resolveNodeScript('@anthropic-ai/claude-code', ['cli.js']);
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];

    if (selectedModel) {
      args.push('--model', selectedModel);
    }

    if (nativeSessionId) {
      args.push('--resume', nativeSessionId);
    }

    return {
      command: resolved.command,
      args: [...resolved.prefixArgs, ...args],
      shell: resolved.shell,
    };
  }

  if (provider === 'gemini') {
    const resolved = resolveNodeScript('@google/gemini-cli', ['dist', 'index.js'], ['--no-warnings=DEP0040']);
    const args = ['-p', prompt, '--output-format', 'stream-json'];

    if (selectedModel) {
      args.push('--model', selectedModel);
    }

    if (nativeSessionId) {
      args.push('--resume', nativeSessionId);
    }

    return {
      command: resolved.command,
      args: [...resolved.prefixArgs, ...args],
      shell: resolved.shell,
    };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

function findSessionId(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (typeof value.session_id === 'string' && value.session_id) {
    return value.session_id;
  }

  if (typeof value.sessionId === 'string' && value.sessionId) {
    return value.sessionId;
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const sessionId = findSessionId(child);
      if (sessionId) {
        return sessionId;
      }
    }
  }

  return null;
}

function findModelName(provider, event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  if (provider === 'claude') {
    if (typeof event.model === 'string' && event.model) {
      return event.model;
    }

    if (event.message && typeof event.message.model === 'string' && event.message.model) {
      return event.message.model;
    }
  }

  if (provider === 'gemini') {
    if (typeof event.model === 'string' && event.model) {
      return event.model;
    }
  }

  if (provider === 'codex') {
    return getConfiguredCodexModel();
  }

  return null;
}

function createEventParser(provider, onText) {
  return (event) => {
    if (provider === 'codex') {
      if (
        event.type === 'item.completed' &&
        event.item &&
        event.item.type === 'agent_message' &&
        typeof event.item.text === 'string'
      ) {
        onText(event.item.text);
      }

      if (event.type === 'error' || event.type === 'turn.failed') {
        throw new Error(event.message || JSON.stringify(event));
      }

      return;
    }

    if (provider === 'claude') {
      if (event.type === 'assistant' && Array.isArray(event.message && event.message.content)) {
        for (const item of event.message.content) {
          if (item && item.type === 'text' && item.text) {
            onText(item.text);
          }
        }
      }

      if (event.type === 'error') {
        throw new Error(event.message || JSON.stringify(event));
      }

      return;
    }

    if (
      event.type === 'message' &&
      event.role === 'assistant' &&
      typeof event.content === 'string'
    ) {
      onText(event.content);
    }

    if (event.type === 'error') {
      throw new Error(event.message || JSON.stringify(event));
    }
  };
}

function extractUsage(provider, event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  if (provider === 'codex' && event.type === 'turn.completed' && event.usage) {
    return {
      inputTokens: Number(event.usage.input_tokens || 0),
      outputTokens: Number(event.usage.output_tokens || 0),
      cachedInputTokens: Number(event.usage.cached_input_tokens || 0),
      totalTokens:
        Number(event.usage.input_tokens || 0) +
        Number(event.usage.output_tokens || 0) +
        Number(event.usage.cached_input_tokens || 0),
    };
  }

  if (provider === 'claude' && event.type === 'result' && event.usage) {
    return {
      inputTokens: Number(event.usage.input_tokens || 0),
      outputTokens: Number(event.usage.output_tokens || 0),
      cachedInputTokens:
        Number(event.usage.cache_read_input_tokens || 0) +
        Number(event.usage.cache_creation_input_tokens || 0),
      totalTokens:
        Number(event.usage.input_tokens || 0) +
        Number(event.usage.output_tokens || 0) +
        Number(event.usage.cache_read_input_tokens || 0) +
        Number(event.usage.cache_creation_input_tokens || 0),
      serviceTier: event.usage.service_tier || null,
    };
  }

  if (provider === 'gemini' && event.type === 'result' && event.stats) {
    return {
      inputTokens: Number(event.stats.input_tokens || event.stats.input || 0),
      outputTokens: Number(event.stats.output_tokens || 0),
      cachedInputTokens: Number(event.stats.cached || 0),
      totalTokens: Number(event.stats.total_tokens || 0),
    };
  }

  return null;
}

function extractQuotaSignal(provider, event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  if (provider === 'claude' && event.type === 'rate_limit_event' && event.rate_limit_info) {
    return {
      source: 'rate_limit_event',
      status: event.rate_limit_info.status || null,
      windowType: event.rate_limit_info.rateLimitType || null,
      resetsAt: event.rate_limit_info.resetsAt
        ? new Date(Number(event.rate_limit_info.resetsAt) * 1000).toISOString()
        : null,
      isUsingOverage: Boolean(event.rate_limit_info.isUsingOverage),
      overageStatus: event.rate_limit_info.overageStatus || null,
    };
  }

  return null;
}

function getMissingCommandMessage(provider) {
  if (provider === 'codex') {
    return 'Codex CLI not found. Install it with: npm install -g @openai/codex';
  }

  if (provider === 'claude') {
    return 'Claude CLI not found. Install the official Claude Code CLI first.';
  }

  return 'Gemini CLI not found. Install it with: npm install -g @google/gemini-cli';
}

function startProviderTurn(options) {
  const provider = normalizeProvider(options.provider);
  if (!provider) {
    throw new Error(`Unknown provider: ${options.provider}`);
  }

  const userMessage = String(options.userMessage || '').trim();
  if (!userMessage) {
    throw new Error('User message is required.');
  }

  const history = Array.isArray(options.history) ? options.history : [];
  const nativeSessionId = options.nativeSessionId || null;
  const selectedModel = String(options.model || '').trim() || null;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const prompt = nativeSessionId ? userMessage : buildHistoryPrompt(history, userMessage);
  const runtime = buildCommand(provider, prompt, nativeSessionId, selectedModel);

  let child;
  let cancelled = false;

  const promise = new Promise((resolve, reject) => {
    let assistantText = '';
    let capturedSessionId = nativeSessionId;
    let stderrOutput = '';
    let lastUsage = null;
    let lastQuotaSignal = null;
    let currentModel = selectedModel || getProviderProfile(provider)?.currentModel || null;
    let settled = false;

    const finish = (handler, value) => {
      if (settled) {
        return;
      }

      settled = true;
      handler(value);
    };

    child = spawn(runtime.command, runtime.args, {
      shell: Boolean(runtime.shell),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const parseEvent = createEventParser(provider, (text) => {
      assistantText += text;
      onEvent({ type: 'assistant_delta', delta: text });
    });

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      if (!line.trim()) {
        return;
      }

      try {
        const event = JSON.parse(line);
        const sessionId = findSessionId(event);
        const usage = extractUsage(provider, event);
        const quotaSignal = extractQuotaSignal(provider, event);
        const modelName = findModelName(provider, event);

        if (sessionId && sessionId !== capturedSessionId) {
          capturedSessionId = sessionId;
          onEvent({ type: 'session', sessionId });
        }

        if (modelName && modelName !== currentModel) {
          currentModel = modelName;
          onEvent({ type: 'model', model: modelName });
        }

        if (usage) {
          lastUsage = usage;
          onEvent({ type: 'usage', usage });
        }

        if (quotaSignal) {
          lastQuotaSignal = quotaSignal;
          onEvent({ type: 'quota_signal', quotaSignal });
        }

        parseEvent(event);
      } catch (error) {
        if (error instanceof SyntaxError) {
          assistantText += line;
          onEvent({ type: 'assistant_delta', delta: line });
          return;
        }

        finish(reject, error);
      }
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderrOutput += text;
      onEvent({ type: 'stderr', message: text });
    });

    child.on('error', (error) => {
      rl.close();

      if (error.code === 'ENOENT') {
        finish(reject, new Error(getMissingCommandMessage(provider)));
        return;
      }

      finish(reject, error);
    });

    child.on('close', (code) => {
      rl.close();

      if (cancelled) {
        finish(resolve, {
          provider,
          content: assistantText.trim(),
          nativeSessionId: capturedSessionId,
          rawStderr: stderrOutput.trim(),
          usage: lastUsage,
          quotaSignal: lastQuotaSignal,
          currentModel,
          stopped: true,
        });
        return;
      }

      if (code === 0) {
        finish(resolve, {
          provider,
          content: assistantText.trim(),
          nativeSessionId: capturedSessionId,
          rawStderr: stderrOutput.trim(),
          usage: lastUsage,
          quotaSignal: lastQuotaSignal,
          currentModel,
          stopped: false,
        });
        return;
      }

      const message = stderrOutput.trim() || `${provider} exited with code ${code}`;
      finish(reject, new Error(message));
    });
  });

  return {
    cancel() {
      cancelled = true;

      if (child && !child.killed) {
        child.kill();
      }
    },
    promise,
  };
}

function runProviderTurn(options) {
  const run = startProviderTurn(options);
  return run.promise;
}

module.exports = {
  PROVIDERS,
  PROVIDER_PERSONAS,
  getProviderProfile,
  listProviderProfiles,
  normalizeProvider,
  startProviderTurn,
  runProviderTurn,
};
