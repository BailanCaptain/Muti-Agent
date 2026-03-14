const PROVIDERS = ['codex', 'claude', 'gemini'];
const QUOTA_REFRESH_MS = 20_000;

const state = {
  health: null,
  providerProfiles: {},
  quotas: {},
  sessionGroups: [],
  activeSessionGroupId: null,
  currentThreads: {},
  running: {},
};

const elements = {
  providerCards: document.querySelector('#provider-cards'),
  sessionList: document.querySelector('#session-list'),
  timeline: document.querySelector('#timeline'),
  mentionBar: document.querySelector('#mention-bar'),
  composer: document.querySelector('#composer'),
  composerInput: document.querySelector('#composer-input'),
  stopAllButton: document.querySelector('#stop-all-button'),
  newSessionButton: document.querySelector('#new-session-button'),
  refreshButton: document.querySelector('#refresh-button'),
  globalStatus: document.querySelector('#global-status'),
  healthBadge: document.querySelector('#health-badge'),
  activeSessionTitle: document.querySelector('#active-session-title'),
  activeSessionMeta: document.querySelector('#active-session-meta'),
  providerCardTemplate: document.querySelector('#provider-card-template'),
  sessionItemTemplate: document.querySelector('#session-item-template'),
  messageTemplate: document.querySelector('#message-template'),
};

const providerElements = new Map();
let activeModelMenuProvider = null;

const FALLBACK_MODEL_SUGGESTIONS = {
  codex: ['gpt-5', 'gpt-5-codex', 'o3'],
  claude: ['claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-opus-4-1'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
};

function setGlobalStatus(text) {
  elements.globalStatus.textContent = text;
}

function formatDateTime(value) {
  if (!value) {
    return '--';
  }

  const date = new Date(value);
  return `${date.toLocaleDateString('zh-CN')} ${date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

function fetchJson(url, options) {
  return fetch(url, options).then(async (response) => {
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || '请求失败');
    }

    return payload;
  });
}

function getProfile(provider) {
  return (
    state.providerProfiles[provider] || {
      provider,
      alias: provider,
      currentModel: null,
      modelSuggestions: [],
    }
  );
}

function getActiveSessionGroup() {
  return state.sessionGroups.find((item) => item.id === state.activeSessionGroupId) || null;
}

function getCurrentThread(provider) {
  return state.currentThreads[provider] || null;
}

function getModelSuggestions(provider) {
  const dynamic = getProfile(provider).modelSuggestions || [];
  if (dynamic.length) {
    return dynamic;
  }

  return FALLBACK_MODEL_SUGGESTIONS[provider] || [];
}

function isProviderRunning(provider) {
  return Boolean(state.running[provider]);
}

function isAnyRunning() {
  return PROVIDERS.some((provider) => isProviderRunning(provider));
}

function createMentionAliases() {
  const map = new Map();

  PROVIDERS.forEach((provider) => {
    const profile = getProfile(provider);
    const aliases = [
      provider,
      profile.alias,
      provider === 'codex' ? '范德彪' : null,
      provider === 'claude' ? '黄仁勋' : null,
      provider === 'gemini' ? '桂芬' : null,
      provider === 'claude' ? 'claudecode' : null,
    ].filter(Boolean);

    aliases.forEach((item) => map.set(String(item).toLowerCase(), provider));
  });

  return map;
}

function parseMentionInput(text) {
  const raw = String(text || '').trim();
  const match = raw.match(/@([^\s]+)/);
  if (!match) {
    return { provider: null, content: raw };
  }

  return {
    provider: createMentionAliases().get(match[1].toLowerCase()) || null,
    content: raw.replace(match[0], '').trim(),
  };
}

function buildUnifiedMessages() {
  const messages = [];

  PROVIDERS.forEach((provider) => {
    const thread = getCurrentThread(provider);
    if (!thread) {
      return;
    }

    const profile = getProfile(provider);
    const model = thread.currentModel || profile.currentModel || null;

    thread.messages.forEach((message) => {
      messages.push({
        id: `${provider}-${message.id}`,
        provider,
        role: message.role,
        alias: profile.alias,
        model,
        content: message.role === 'user' ? `@${profile.alias} ${message.content}` : message.content,
        createdAt: message.createdAt,
      });
    });
  });

  messages.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  return messages;
}

function makeMessageElement(message) {
  const node = elements.messageTemplate.content.firstElementChild.cloneNode(true);
  const meta = node.querySelector('.message-meta');
  const bubble = node.querySelector('.message-bubble');
  const content = node.querySelector('.message-content');

  node.classList.add(message.role);
  bubble.dataset.provider = message.provider;
  meta.textContent =
    message.role === 'assistant'
      ? `${message.alias}${message.model ? ` · ${message.model}` : ''}`
      : `你 -> ${message.alias}`;
  content.textContent = message.content;

  return node;
}

function renderTimeline() {
  const messages = buildUnifiedMessages();
  elements.timeline.innerHTML = '';

  if (!messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '当前会话还没有消息，输入 @范德彪 / @黄仁勋 / @桂芬 开始。';
    elements.timeline.appendChild(empty);
    return;
  }

  messages.forEach((message) => {
    elements.timeline.appendChild(makeMessageElement(message));
  });

  elements.timeline.scrollTop = elements.timeline.scrollHeight;
}

function createQuotaSummary(provider) {
  const quota = state.quotas[provider];
  if (!quota) {
    return '额度读取中';
  }

  const remaining = quota.remaining?.available ? quota.remaining.value : '--';
  const requests5h = quota.totals?.requestCount5h ?? 0;
  return `剩余 ${remaining} · 5小时 ${requests5h}`;
}

function renderModelMenu(provider) {
  const refs = providerElements.get(provider);
  if (!refs) {
    return;
  }

  const query = refs.modelInput.value.trim().toLowerCase();
  const all = [...new Set(getModelSuggestions(provider))];
  const matched = query ? all.filter((item) => item.toLowerCase().includes(query)) : all;
  const suggestions = matched.length ? matched : refs.modelInput.value.trim() ? [refs.modelInput.value.trim()] : [];

  refs.modelMenu.innerHTML = '';

  if (!suggestions.length || activeModelMenuProvider !== provider) {
    refs.modelMenu.hidden = true;
    return;
  }

  suggestions.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'provider-model-option';
    button.textContent = item;
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      refs.modelInput.value = item;
      refs.modelMenu.hidden = true;
      refs.modelInput.focus();
    });
    refs.modelMenu.appendChild(button);
  });

  refs.modelMenu.hidden = false;
}

function closeModelMenu(provider) {
  const refs = providerElements.get(provider);
  if (!refs) {
    return;
  }

  refs.modelMenu.hidden = true;
  refs.modelMenu.innerHTML = '';
  if (activeModelMenuProvider === provider) {
    activeModelMenuProvider = null;
  }
}

function renderProviderCard(provider) {
  const refs = providerElements.get(provider);
  if (!refs) {
    return;
  }

  const profile = getProfile(provider);
  const thread = getCurrentThread(provider);
  const model = thread?.currentModel || profile.currentModel || null;
  const running = isProviderRunning(provider);
  const latestMessage = thread?.messages?.[thread.messages.length - 1]?.content || '还没有消息';

  refs.card.dataset.provider = provider;
  refs.avatar.textContent = profile.alias.slice(0, 2);
  refs.name.textContent = profile.alias;
  refs.model.textContent = model || '未设置模型';
  refs.provider.textContent = provider === 'claude' ? 'Claude Code' : provider;
  refs.preview.textContent = latestMessage.replace(/\s+/g, ' ').slice(0, 44);
  refs.quota.textContent = createQuotaSummary(provider);
  refs.status.textContent = running ? '生成中' : '空闲';
  refs.status.dataset.running = running ? 'yes' : 'no';
  refs.modelInput.value = model || '';
  refs.modelInput.placeholder = getModelSuggestions(provider)[0] || '输入模型名';
  refs.stopButton.disabled = !running;
}

function renderProviderCards() {
  PROVIDERS.forEach((provider) => renderProviderCard(provider));
}

function renderMentionBar() {
  elements.mentionBar.innerHTML = '';
  PROVIDERS.forEach((provider) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ghost-button mention-chip';
    chip.textContent = `@${getProfile(provider).alias}`;
    chip.addEventListener('click', () => insertMention(provider));
    elements.mentionBar.appendChild(chip);
  });
}

function renderSessionList() {
  elements.sessionList.innerHTML = '';

  state.sessionGroups.forEach((group) => {
    const node = elements.sessionItemTemplate.content.firstElementChild.cloneNode(true);
    const title = node.querySelector('.session-item-title');
    const meta = node.querySelector('.session-item-meta');
    const previews = node.querySelector('.session-item-previews');

    node.dataset.active = group.id === state.activeSessionGroupId ? 'yes' : 'no';
    title.textContent = group.title || '未命名会话';
    meta.textContent = `${formatDateTime(group.updatedAt)} · ${Object.keys(group.threadIds || {}).length} 个角色`;

    PROVIDERS.forEach((provider) => {
      const line = document.createElement('div');
      line.className = `session-preview ${provider}`;
      line.textContent = `${getProfile(provider).alias}：${group.previews?.[provider] || '还没有消息'}`;
      previews.appendChild(line);
    });

    node.addEventListener('click', () => {
      void loadSessionGroup(group.id);
    });

    elements.sessionList.appendChild(node);
  });
}

function renderActiveSessionHeader() {
  const group = getActiveSessionGroup();
  if (!group) {
    elements.activeSessionTitle.textContent = '当前会话';
    elements.activeSessionMeta.textContent = '还没有选中会话';
    return;
  }

  elements.activeSessionTitle.textContent = group.title || '未命名会话';
  elements.activeSessionMeta.textContent = `创建于 ${formatDateTime(group.createdAt)}，最近更新 ${formatDateTime(group.updatedAt)}`;
}

function renderAll() {
  renderProviderCards();
  renderMentionBar();
  renderSessionList();
  renderActiveSessionHeader();
  renderTimeline();
  elements.stopAllButton.disabled = !isAnyRunning();
  elements.healthBadge.textContent = state.health ? `服务在线 · ${state.health.port}` : '服务离线';
}

function insertMention(provider) {
  const alias = getProfile(provider).alias;
  const prefix = `@${alias} `;
  const current = elements.composerInput.value;
  if (!current.includes(prefix)) {
    elements.composerInput.value = `${prefix}${current}`.trimStart();
  }
  elements.composerInput.focus();
}

function createProviderCards() {
  PROVIDERS.forEach((provider) => {
    const card = elements.providerCardTemplate.content.firstElementChild.cloneNode(true);
    const refs = {
      card,
      avatar: card.querySelector('.provider-avatar'),
      name: card.querySelector('.provider-name'),
      provider: card.querySelector('.provider-label'),
      model: card.querySelector('.provider-model-value'),
      preview: card.querySelector('.provider-preview'),
      quota: card.querySelector('.provider-quota'),
      status: card.querySelector('.provider-status'),
      modelInput: card.querySelector('.provider-model-input'),
      modelMenu: card.querySelector('.provider-model-menu'),
      saveButton: card.querySelector('.provider-save-button'),
      refreshButton: card.querySelector('.provider-refresh-button'),
      mentionButton: card.querySelector('.provider-mention-button'),
      stopButton: card.querySelector('.provider-stop-button'),
    };

    refs.modelInput.addEventListener('focus', () => {
      activeModelMenuProvider = provider;
      renderModelMenu(provider);
    });
    refs.modelInput.addEventListener('input', () => {
      activeModelMenuProvider = provider;
      renderModelMenu(provider);
    });
    refs.modelInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void saveThreadModel(provider);
      }
      if (event.key === 'Escape') {
        closeModelMenu(provider);
      }
    });
    refs.modelInput.addEventListener('blur', () => {
      window.setTimeout(() => closeModelMenu(provider), 120);
    });

    refs.saveButton.addEventListener('click', () => {
      void saveThreadModel(provider);
    });
    refs.refreshButton.addEventListener('click', () => {
      void refreshProviderModels(provider);
    });
    refs.mentionButton.addEventListener('click', () => {
      insertMention(provider);
    });
    refs.stopButton.addEventListener('click', () => {
      void stopProvider(provider);
    });

    providerElements.set(provider, refs);
    elements.providerCards.appendChild(card);
  });
}

async function fetchHealth() {
  state.health = await fetchJson('/api/health');
}

async function fetchProviderProfiles() {
  const payload = await fetchJson('/api/providers');
  state.providerProfiles = Object.fromEntries((payload.providers || []).map((item) => [item.provider, item]));
}

async function fetchQuotas() {
  const payload = await fetchJson('/api/quotas');
  state.quotas = payload.quotas || {};
}

async function fetchSessionGroups() {
  const payload = await fetchJson('/api/session-groups');
  state.sessionGroups = payload.sessionGroups || [];
}

async function createFreshSessionGroup() {
  const createGroupPayload = await fetchJson('/api/session-groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: `三方会话 ${new Date().toLocaleString('zh-CN')}`,
    }),
  });

  const sessionGroup = createGroupPayload.sessionGroup;

  for (const provider of PROVIDERS) {
    const profile = getProfile(provider);
    const payload = await fetchJson('/api/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        sessionGroupId: sessionGroup.id,
        title: `${profile.alias} ${new Date().toISOString().slice(11, 19)}`,
        currentModel: getCurrentThread(provider)?.currentModel || profile.currentModel || null,
      }),
    });

    state.currentThreads[provider] = payload.thread;
    state.running[provider] = false;
  }

  await fetchSessionGroups();
  state.activeSessionGroupId = sessionGroup.id;
  await loadSessionGroup(sessionGroup.id);
  setGlobalStatus('已新建一组新的三方会话，旧历史会保留在左侧。');
}

async function loadSessionGroup(groupId) {
  const payload = await fetchJson(`/api/session-groups/${groupId}`);
  const group = payload.sessionGroup;

  state.activeSessionGroupId = group.id;
  state.currentThreads = {};
  state.running = {};

  PROVIDERS.forEach((provider) => {
    state.currentThreads[provider] = group.threads?.[provider] || null;
  });

  (payload.runningThreadIds || []).forEach((threadId) => {
    const matchedProvider = PROVIDERS.find((provider) => state.currentThreads[provider]?.id === threadId);
    if (matchedProvider) {
      state.running[matchedProvider] = true;
    }
  });

  renderAll();
}

async function ensureInitialSession() {
  await fetchSessionGroups();

  if (!state.sessionGroups.length) {
    await createFreshSessionGroup();
    return;
  }

  await loadSessionGroup(state.sessionGroups[0].id);
}

async function saveThreadModel(provider) {
  const thread = getCurrentThread(provider);
  const refs = providerElements.get(provider);
  if (!thread || !refs) {
    return;
  }

  if (isProviderRunning(provider)) {
    setGlobalStatus(`请先停止 ${getProfile(provider).alias}，再切换模型。`);
    return;
  }

  const payload = await fetchJson(`/api/threads/${thread.id}/model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: refs.modelInput.value.trim() }),
  });

  state.currentThreads[provider] = payload.thread;
  await fetchSessionGroups();
  renderAll();
  setGlobalStatus(`${getProfile(provider).alias} 的模型已更新。`);
}

async function refreshProviderModels(provider) {
  await fetchProviderProfiles();
  renderProviderCard(provider);
  setGlobalStatus(`${getProfile(provider).alias} 的模型候选已刷新。`);
}

function optimisticAppend(provider, role, content) {
  const thread = getCurrentThread(provider);
  if (!thread) {
    return null;
  }

  const message = {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
  };
  thread.messages.push(message);
  thread.updatedAt = message.createdAt;
  return message;
}

async function sendToProvider(provider, rawContent) {
  const thread = getCurrentThread(provider);
  if (!thread || isProviderRunning(provider)) {
    return;
  }

  const profile = getProfile(provider);
  optimisticAppend(provider, 'user', rawContent);
  const assistantDraft = optimisticAppend(provider, 'assistant', '');
  state.running[provider] = true;
  renderAll();

  try {
    const response = await fetch(`/api/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: rawContent }),
    });

    if (!response.ok || !response.body) {
      const payload = await response.json();
      throw new Error(payload.error || '发送失败');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        const event = JSON.parse(line);

        if (event.type === 'assistant_delta') {
          assistantDraft.content += event.delta;
          renderTimeline();
          continue;
        }

        if (event.type === 'done') {
          state.currentThreads[provider] = event.thread;
          state.running[provider] = false;
          await Promise.all([fetchProviderProfiles(), fetchQuotas(), fetchSessionGroups()]);
          renderAll();
          setGlobalStatus(`${profile.alias} 回复完成。`);
          continue;
        }

        if (event.type === 'error') {
          assistantDraft.content = `请求失败：${event.message}`;
          state.running[provider] = false;
          await Promise.all([fetchQuotas(), fetchSessionGroups()]);
          renderAll();
          setGlobalStatus(`${profile.alias} 请求失败。`);
        }
      }
    }
  } catch (error) {
    if (assistantDraft) {
      assistantDraft.content = `请求失败：${error.message}`;
    }
    state.running[provider] = false;
    await Promise.all([fetchQuotas(), fetchSessionGroups()]);
    renderAll();
    setGlobalStatus(`${profile.alias} 请求失败。`);
  }
}

async function stopProvider(provider) {
  const thread = getCurrentThread(provider);
  if (!thread || !isProviderRunning(provider)) {
    return;
  }

  await fetchJson(`/api/threads/${thread.id}/stop`, { method: 'POST' });
  setGlobalStatus(`正在停止 ${getProfile(provider).alias}...`);
}

async function stopAll() {
  await Promise.all(PROVIDERS.map((provider) => stopProvider(provider)));
}

async function refreshEverything() {
  await Promise.all([fetchHealth(), fetchProviderProfiles(), fetchQuotas(), fetchSessionGroups()]);

  if (!state.activeSessionGroupId && state.sessionGroups[0]) {
    await loadSessionGroup(state.sessionGroups[0].id);
    return;
  }

  if (state.activeSessionGroupId) {
    await loadSessionGroup(state.activeSessionGroupId);
    return;
  }

  renderAll();
}

elements.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const raw = elements.composerInput.value.trim();
  if (!raw) {
    return;
  }

  const parsed = parseMentionInput(raw);
  if (!parsed.provider) {
    setGlobalStatus('请在消息前输入 @范德彪、@黄仁勋 或 @桂芬。');
    return;
  }

  if (!parsed.content) {
    setGlobalStatus('请在 @名字 后面输入要发送的内容。');
    return;
  }

  elements.composerInput.value = '';
  setGlobalStatus(`正在发送给 ${getProfile(parsed.provider).alias}...`);
  await sendToProvider(parsed.provider, parsed.content);
});

elements.composerInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

elements.stopAllButton.addEventListener('click', () => {
  void stopAll();
});

elements.newSessionButton.addEventListener('click', () => {
  void createFreshSessionGroup();
});

elements.refreshButton.addEventListener('click', () => {
  void refreshEverything();
});

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }

  PROVIDERS.forEach((provider) => {
    const refs = providerElements.get(provider);
    if (!refs) {
      return;
    }

    if (!refs.card.contains(event.target)) {
      closeModelMenu(provider);
    }
  });
});

async function bootstrap() {
  createProviderCards();
  await Promise.all([fetchHealth(), fetchProviderProfiles(), fetchQuotas()]);
  await ensureInitialSession();
  renderAll();
  setGlobalStatus('历史会话会保留在左侧，顶部卡片只负责当前这组会话的三位角色。');

  window.setInterval(() => {
    void Promise.all([fetchProviderProfiles(), fetchQuotas(), fetchSessionGroups()]).then(() => {
      if (state.activeSessionGroupId) {
        renderProviderCards();
        renderSessionList();
      }
    });
  }, QUOTA_REFRESH_MS);
}

bootstrap().catch((error) => {
  setGlobalStatus(error.message);
});
