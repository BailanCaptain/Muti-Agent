#!/usr/bin/env node

const { PROVIDERS, normalizeProvider, runProviderTurn } = require('./lib/ai-runtime');

function printUsage() {
  console.log(`Usage:
  node minimal-ai.js <provider> [--resume=<session-id>] "<prompt>"

Providers:
  ${PROVIDERS.join('\n  ')}

Examples:
  node minimal-ai.js codex "你好"
  node minimal-ai.js claude "你好"
  node minimal-ai.js gemini "你好"
  node minimal-ai.js claude --resume=SESSION_ID "继续刚才的对话"
`);
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const provider = normalizeProvider(argv[0]);
  if (!provider) {
    console.error(`Unknown provider: ${argv[0]}`);
    printUsage();
    process.exit(1);
  }

  let nativeSessionId = null;
  const promptParts = [];

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg.startsWith('--resume=')) {
      nativeSessionId = arg.slice('--resume='.length).trim() || null;
      continue;
    }

    promptParts.push(arg);
  }

  const userMessage = promptParts.join(' ').trim();
  if (!userMessage) {
    console.error('Prompt is required.');
    printUsage();
    process.exit(1);
  }

  return { provider, nativeSessionId, userMessage };
}

async function main() {
  const { provider, nativeSessionId, userMessage } = parseArgs(process.argv.slice(2));

  try {
    const result = await runProviderTurn({
      provider,
      nativeSessionId,
      userMessage,
      history: [],
      onEvent(event) {
        if (event.type === 'assistant_delta') {
          process.stdout.write(event.delta);
        }
      },
    });

    if (result.nativeSessionId) {
      process.stdout.write(`\n\n[session] ${result.nativeSessionId}\n`);
      return;
    }

    process.stdout.write('\n');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

main();
