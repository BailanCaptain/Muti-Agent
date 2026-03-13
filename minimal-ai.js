#!/usr/bin/env node

const { spawn } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');
const readline = require('readline');

const argv = process.argv.slice(2);

function printUsage() {
  console.log(`Usage:
  node minimal-ai.js <provider> [--resume|--resume=<id|latest>] "<prompt>"

Providers:
  codex
  claude
  gemini

Examples:
  node minimal-ai.js codex "你好"
  node minimal-ai.js claude "你好"
  node minimal-ai.js gemini "你好"
  node minimal-ai.js codex --resume "继续刚才的话题"
  node minimal-ai.js claude --resume=SESSION_ID "继续刚才的对话"
  node minimal-ai.js gemini --resume=latest "继续"
`);
}

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

function parseArgs(args) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const provider = normalizeProvider(args[0]);
  if (!provider) {
    console.error(`Unknown provider: ${args[0]}`);
    printUsage();
    process.exit(1);
  }

  let resume = null;
  const promptParts = [];

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--resume') {
      resume = 'latest';
      continue;
    }

    if (arg.startsWith('--resume=')) {
      const value = arg.slice('--resume='.length).trim();
      resume = value || 'latest';
      continue;
    }

    promptParts.push(arg);
  }

  const prompt = promptParts.join(' ').trim();
  if (!prompt) {
    console.error('Prompt is required.');
    printUsage();
    process.exit(1);
  }

  return { provider, prompt, resume };
}

function resolveNpmRoot() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming', 'npm'),
  ];

  return candidates.find((candidate) => candidate && existsSync(candidate)) || '';
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

function buildCommand(provider, prompt, resume) {
  if (provider === 'codex') {
    const resolved = resolveCodexCommand();
    const baseArgs = resume && resume !== 'latest'
      ? ['exec', 'resume', '--skip-git-repo-check', '--json', resume, prompt]
      : resume
        ? ['exec', 'resume', '--last', '--skip-git-repo-check', '--json', prompt]
        : ['exec', '--skip-git-repo-check', '--json', prompt];

    return {
      command: resolved.command,
      args: [...resolved.prefixArgs, ...baseArgs],
      shell: Boolean(resolved.shell),
    };
  }

  if (provider === 'claude') {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];

    if (resume && resume !== 'latest') {
      args.push('--resume', resume);
    } else if (resume) {
      args.push('--continue');
    }

    return {
      command: 'claude',
      args,
      shell: true,
    };
  }

  if (provider === 'gemini') {
    const args = ['-p', prompt, '--output-format', 'stream-json'];

    if (resume && resume !== 'latest') {
      args.push('--resume', resume);
    } else if (resume) {
      args.push('--resume');
    }

    return {
      command: 'gemini',
      args,
      shell: true,
    };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

function handleCodexEvent(event) {
  if (
    event.type === 'item.completed' &&
    event.item &&
    event.item.type === 'agent_message' &&
    typeof event.item.text === 'string'
  ) {
    process.stdout.write(event.item.text + '\n');
    return;
  }

  if (event.type === 'error') {
    console.error('Codex error:', event.message || JSON.stringify(event));
    return;
  }

  if (event.type === 'turn.failed') {
    console.error('Codex turn failed:', JSON.stringify(event));
  }
}

function handleClaudeEvent(event) {
  if (event.type === 'assistant' && Array.isArray(event.message && event.message.content)) {
    for (const item of event.message.content) {
      if (item && item.type === 'text' && item.text) {
        process.stdout.write(item.text);
      }
    }
    return;
  }

  if (event.type === 'error') {
    console.error('Claude error:', event.message || JSON.stringify(event));
  }
}

function handleGeminiEvent(event) {
  if (
    event.type === 'message' &&
    event.role === 'assistant' &&
    typeof event.content === 'string'
  ) {
    process.stdout.write(event.content);
    return;
  }

  if (event.type === 'error') {
    console.error('Gemini error:', event.message || JSON.stringify(event));
  }
}

function handleEvent(provider, event) {
  if (provider === 'codex') {
    handleCodexEvent(event);
    return;
  }

  if (provider === 'claude') {
    handleClaudeEvent(event);
    return;
  }

  if (provider === 'gemini') {
    handleGeminiEvent(event);
  }
}

function printMissingCommandHelp(provider, err) {
  console.error(`Failed to start ${provider}:`, err.message);

  if (err.code !== 'ENOENT') {
    return;
  }

  if (provider === 'codex') {
    console.error('Install or repair it with: npm install -g @openai/codex');
    return;
  }

  if (provider === 'claude') {
    console.error('Install or repair it with the official Claude CLI package.');
    return;
  }

  if (provider === 'gemini') {
    console.error('Install or repair it with: npm install -g @google/gemini-cli');
  }
}

const { provider, prompt, resume } = parseArgs(argv);
const runtime = buildCommand(provider, prompt, resume);

console.log(`> ${runtime.command} ${runtime.args.join(' ')}\n`);

const child = spawn(runtime.command, runtime.args, {
  shell: Boolean(runtime.shell),
  stdio: ['ignore', 'pipe', 'pipe'],
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
    handleEvent(provider, event);
  } catch {
    console.log(line);
  }
});

child.stderr.on('data', (data) => {
  const text = data.toString();
  if (text.trim()) {
    process.stderr.write(text);
  }
});

child.on('close', (code) => {
  rl.close();
  console.log(`\n${provider} exited with code: ${code}`);
  process.exit(code ?? 1);
});

child.on('error', (err) => {
  rl.close();
  printMissingCommandHelp(provider, err);
  process.exit(1);
});
