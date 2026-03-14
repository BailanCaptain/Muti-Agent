const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { Store } = require('./lib/store');
const {
  PROVIDERS,
  normalizeProvider,
  startProviderTurn,
  getProviderProfile,
  listProviderProfiles,
} = require('./lib/ai-runtime');
const { getProviderModelSuggestions } = require('./lib/model-catalog');
const { buildAllQuotaSnapshots } = require('./lib/quota-service');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const store = new Store(ROOT);
const PORT = Number(process.env.PORT || 3000);
const activeRuns = new Map();

function isQuotaMessage(message) {
  return /quota|rate limit|usage limit|too many requests|429|credit|allowance|exceeded|capacity/i.test(
    String(message || '')
  );
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function sendFile(response, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };

  const stream = fs.createReadStream(filePath);
  response.writeHead(200, {
    'Content-Type': contentTypes[extension] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  stream.pipe(response);
}

function notFound(response) {
  sendJson(response, 404, { error: 'Not found' });
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 1_000_000) {
        reject(new Error('Request body too large.'));
      }
    });

    request.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });

    request.on('error', reject);
  });
}

function writeStreamEvent(response, payload) {
  response.write(`${JSON.stringify(payload)}\n`);
}

async function handleCreateThread(request, response) {
  const body = await readJsonBody(request);
  const provider = normalizeProvider(body.provider);

  if (!provider) {
    sendJson(response, 400, { error: `provider must be one of: ${PROVIDERS.join(', ')}` });
    return;
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const profile = getProviderProfile(provider);
  const requestedModel = String(body.currentModel || '').trim() || null;
  const sessionGroupId = typeof body.sessionGroupId === 'string' ? body.sessionGroupId.trim() : '';
  const thread = await store.createThread(provider, title, {
    currentModel: requestedModel || (profile ? profile.currentModel : null),
    sessionGroupId: sessionGroupId || null,
  });

  if (sessionGroupId) {
    await store.attachThreadToSessionGroup(sessionGroupId, provider, thread.id);
  }

  sendJson(response, 201, { thread });
}

async function handleCreateSessionGroup(request, response) {
  const body = await readJsonBody(request);
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const sessionGroup = await store.createSessionGroup(title);
  sendJson(response, 201, { sessionGroup });
}

async function handleGetSessionGroup(response, groupId) {
  const sessionGroup = store.getSessionGroup(groupId);
  if (!sessionGroup) {
    notFound(response);
    return;
  }

  sendJson(response, 200, {
    sessionGroup,
    runningThreadIds: Object.values(sessionGroup.threadIds || {}).filter((threadId) => activeRuns.has(threadId)),
  });
}

async function handleGetThread(response, threadId) {
  const thread = store.getThread(threadId);
  if (!thread) {
    notFound(response);
    return;
  }

  sendJson(response, 200, { thread, running: activeRuns.has(threadId) });
}

async function handleUpdateThreadModel(request, response, threadId) {
  const thread = store.getThread(threadId);
  if (!thread) {
    notFound(response);
    return;
  }

  if (activeRuns.has(threadId)) {
    sendJson(response, 409, { error: 'This thread is running. Stop it before changing the model.' });
    return;
  }

  const body = await readJsonBody(request);
  const nextModel = String(body.model || '').trim() || null;
  const updatedThread = await store.updateThread(threadId, {
    currentModel: nextModel,
  });

  sendJson(response, 200, { thread: updatedThread });
}

async function finalizeRun(threadId) {
  activeRuns.delete(threadId);
}

async function handleSendMessage(request, response, threadId) {
  const thread = store.getThread(threadId);
  if (!thread) {
    notFound(response);
    return;
  }

  if (activeRuns.has(threadId)) {
    sendJson(response, 409, { error: 'This thread is already running.' });
    return;
  }

  const body = await readJsonBody(request);
  const content = String(body.content || '').trim();
  if (!content) {
    sendJson(response, 400, { error: 'content is required' });
    return;
  }

  await store.recordUsageEvent({
    provider: thread.provider,
    type: 'request',
    status: 'started',
    detail: content.slice(0, 160),
    meta: {
      threadId,
    },
  });

  const priorMessages = thread.messages.slice();
  const userMessage = await store.appendMessage(threadId, {
    role: 'user',
    content,
  });

  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });

  writeStreamEvent(response, { type: 'user_message', message: userMessage });

  let assistantText = '';
  let nativeSessionId = thread.nativeSessionId || null;
  let latestUsage = null;
  let latestQuotaSignal = null;
  let latestModel = thread.currentModel || null;
  const run = startProviderTurn({
    provider: thread.provider,
    nativeSessionId: thread.nativeSessionId || null,
    model: thread.currentModel || null,
    history: priorMessages,
    userMessage: content,
    onEvent(event) {
      if (event.type === 'assistant_delta') {
        assistantText += event.delta;
        writeStreamEvent(response, event);
        return;
      }

      if (event.type === 'session') {
        nativeSessionId = event.sessionId;
        writeStreamEvent(response, event);
        return;
      }

      if (event.type === 'usage') {
        latestUsage = event.usage;
        return;
      }

      if (event.type === 'quota_signal') {
        latestQuotaSignal = event.quotaSignal;
        return;
      }

      if (event.type === 'model') {
        latestModel = event.model;
      }
    },
  });

  activeRuns.set(threadId, run);

  try {
    const result = await run.promise;
    const finalContent = result.content || assistantText || (result.stopped ? '[stopped]' : '(empty response)');
    const assistantMessage = await store.appendMessage(threadId, {
      role: 'assistant',
      content: finalContent,
    });

    const updatedThread = await store.updateThread(threadId, {
      nativeSessionId: result.nativeSessionId || nativeSessionId,
      currentModel: result.currentModel || latestModel || thread.currentModel || null,
    });

    writeStreamEvent(response, {
      type: 'done',
      stopped: Boolean(result.stopped),
      thread: updatedThread,
      message: assistantMessage,
    });

    await store.recordUsageEvent({
      provider: thread.provider,
      type: result.stopped ? 'stop' : 'result',
      status: result.stopped ? 'stopped' : 'ok',
      detail: result.stopped ? '用户主动停止了本次生成。' : '本次请求已完成。',
      meta: {
        threadId,
        nativeSessionId: result.nativeSessionId || nativeSessionId || null,
        usage: result.usage || latestUsage,
        quotaSignal: result.quotaSignal || latestQuotaSignal,
      },
    });
  } catch (error) {
    await store.recordUsageEvent({
      provider: thread.provider,
      type: isQuotaMessage(error.message) ? 'limit' : 'request',
      status: isQuotaMessage(error.message) ? 'limited' : 'error',
      detail: error.message,
      meta: {
        threadId,
      },
    });

    writeStreamEvent(response, {
      type: 'error',
      message: error.message,
    });
  } finally {
    await finalizeRun(threadId);
    response.end();
  }
}

async function handleStopThread(response, threadId) {
  const run = activeRuns.get(threadId);
  if (!run) {
    sendJson(response, 409, { error: 'This thread is not running.' });
    return;
  }

  run.cancel();
  sendJson(response, 200, { ok: true });
}

function handleStatic(response, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
    notFound(response);
    return;
  }

  sendFile(response, filePath);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const pathname = url.pathname;

    if (request.method === 'GET' && pathname === '/api/health') {
      sendJson(response, 200, { ok: true, port: PORT });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/providers') {
      sendJson(response, 200, {
        providers: listProviderProfiles().map((profile) => ({
          ...profile,
          modelSuggestions: getProviderModelSuggestions(profile.provider),
        })),
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/quotas') {
      sendJson(response, 200, { quotas: buildAllQuotaSnapshots(store, PROVIDERS) });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/threads') {
      sendJson(response, 200, { threads: store.listThreads(), runningThreadIds: [...activeRuns.keys()] });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/session-groups') {
      sendJson(response, 200, { sessionGroups: store.listSessionGroups() });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/session-groups') {
      await handleCreateSessionGroup(request, response);
      return;
    }

    if (request.method === 'POST' && pathname === '/api/threads') {
      await handleCreateThread(request, response);
      return;
    }

    const sessionGroupMatch = pathname.match(/^\/api\/session-groups\/([^/]+)$/);
    if (request.method === 'GET' && sessionGroupMatch) {
      await handleGetSessionGroup(response, sessionGroupMatch[1]);
      return;
    }

    const threadMatch = pathname.match(/^\/api\/threads\/([^/]+)$/);
    if (request.method === 'GET' && threadMatch) {
      await handleGetThread(response, threadMatch[1]);
      return;
    }

    const messageMatch = pathname.match(/^\/api\/threads\/([^/]+)\/messages$/);
    if (request.method === 'POST' && messageMatch) {
      await handleSendMessage(request, response, messageMatch[1]);
      return;
    }

    const stopMatch = pathname.match(/^\/api\/threads\/([^/]+)\/stop$/);
    if (request.method === 'POST' && stopMatch) {
      await handleStopThread(response, stopMatch[1]);
      return;
    }

    const modelMatch = pathname.match(/^\/api\/threads\/([^/]+)\/model$/);
    if (request.method === 'POST' && modelMatch) {
      await handleUpdateThreadModel(request, response, modelMatch[1]);
      return;
    }

    if (request.method === 'GET') {
      handleStatic(response, pathname);
      return;
    }

    notFound(response);
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT to another value, for example:`);
    console.error(`  PowerShell: $env:PORT=3210; node server.js`);
    process.exit(1);
  }

  throw error;
});
