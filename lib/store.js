const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.dataDir = path.join(rootDir, 'data');
    this.filePath = path.join(this.dataDir, 'store.json');
    this.writeQueue = Promise.resolve();
    this.state = this.loadState();
  }

  loadState() {
    fs.mkdirSync(this.dataDir, { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      const initialState = { threads: [], sessionGroups: [], usageEvents: [] };
      fs.writeFileSync(this.filePath, JSON.stringify(initialState, null, 2));
      return initialState;
    }

    const raw = fs.readFileSync(this.filePath, 'utf8');
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed.threads)) {
      parsed.threads = [];
    }

    if (!Array.isArray(parsed.sessionGroups)) {
      parsed.sessionGroups = [];
    }

    if (!Array.isArray(parsed.usageEvents)) {
      parsed.usageEvents = [];
    }

    return parsed;
  }

  persist() {
    this.writeQueue = this.writeQueue.then(() =>
      fs.promises.writeFile(this.filePath, JSON.stringify(this.state, null, 2))
    );

    return this.writeQueue;
  }

  listThreads() {
    return this.state.threads
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((thread) => ({
        id: thread.id,
        title: thread.title,
        provider: thread.provider,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        nativeSessionId: thread.nativeSessionId || null,
        currentModel: thread.currentModel || null,
        messageCount: thread.messages.length,
        lastMessagePreview: thread.messages.length
          ? thread.messages[thread.messages.length - 1].content.slice(0, 80)
          : '',
      }));
  }

  listSessionGroups() {
    return this.state.sessionGroups
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((group) => {
        const threads = Object.fromEntries(
          Object.entries(group.threadIds || {}).map(([provider, threadId]) => [provider, this.getThread(threadId)])
        );
        const previews = {};

        Object.entries(threads).forEach(([provider, thread]) => {
          previews[provider] = thread?.messages?.length
            ? thread.messages[thread.messages.length - 1].content.slice(0, 80)
            : '';
        });

        return {
          id: group.id,
          title: group.title,
          createdAt: group.createdAt,
          updatedAt: group.updatedAt,
          threadIds: this.clone(group.threadIds || {}),
          previews,
        };
      });
  }

  getSessionGroup(groupId) {
    const group = this.state.sessionGroups.find((item) => item.id === groupId);
    if (!group) {
      return null;
    }

    return {
      ...this.clone(group),
      threads: Object.fromEntries(
        Object.entries(group.threadIds || {}).map(([provider, threadId]) => [provider, this.getThread(threadId)])
      ),
    };
  }

  async createSessionGroup(title) {
    const now = new Date().toISOString();
    const group = {
      id: crypto.randomUUID(),
      title: title || `会话 ${now.slice(0, 16).replace('T', ' ')}`,
      createdAt: now,
      updatedAt: now,
      threadIds: {},
    };

    this.state.sessionGroups.push(group);
    await this.persist();
    return this.clone(group);
  }

  async attachThreadToSessionGroup(groupId, provider, threadId) {
    const group = this.state.sessionGroups.find((item) => item.id === groupId);
    if (!group) {
      return null;
    }

    group.threadIds[provider] = threadId;
    group.updatedAt = new Date().toISOString();
    await this.persist();
    return this.getSessionGroup(groupId);
  }

  createThread(provider, title, options = {}) {
    const now = new Date().toISOString();
    const thread = {
      id: crypto.randomUUID(),
      title: title || `${provider} ${now.slice(0, 16).replace('T', ' ')}`,
      provider,
      createdAt: now,
      updatedAt: now,
      sessionGroupId: options.sessionGroupId || null,
      nativeSessionId: null,
      currentModel: options.currentModel || null,
      messages: [],
    };

    this.state.threads.push(thread);
    return this.persist().then(() => this.clone(thread));
  }

  getThread(threadId) {
    const thread = this.state.threads.find((item) => item.id === threadId);
    return thread ? this.clone(thread) : null;
  }

  async appendMessage(threadId, message) {
    const thread = this.state.threads.find((item) => item.id === threadId);
    if (!thread) {
      return null;
    }

    const createdAt = message.createdAt || new Date().toISOString();
    const nextMessage = {
      id: crypto.randomUUID(),
      role: message.role,
      content: message.content,
      createdAt,
    };

    thread.messages.push(nextMessage);

    if (thread.messages.length === 1 && (!thread.title || thread.title.startsWith(thread.provider))) {
      thread.title = nextMessage.content.slice(0, 32) || thread.title;
    }

    thread.updatedAt = createdAt;
    if (thread.sessionGroupId) {
      await this.touchSessionGroup(thread.sessionGroupId, createdAt);
    }
    await this.persist();
    return this.clone(nextMessage);
  }

  async updateThread(threadId, updates) {
    const thread = this.state.threads.find((item) => item.id === threadId);
    if (!thread) {
      return null;
    }

    Object.assign(thread, updates);
    thread.updatedAt = updates.updatedAt || new Date().toISOString();
    if (thread.sessionGroupId) {
      await this.touchSessionGroup(thread.sessionGroupId, thread.updatedAt);
    }
    await this.persist();
    return this.clone(thread);
  }

  async touchSessionGroup(groupId, updatedAt = new Date().toISOString()) {
    const group = this.state.sessionGroups.find((item) => item.id === groupId);
    if (!group) {
      return null;
    }

    group.updatedAt = updatedAt;
    return this.clone(group);
  }

  async recordUsageEvent(event) {
    const nextEvent = {
      id: crypto.randomUUID(),
      provider: event.provider,
      type: event.type || 'request',
      status: event.status || 'ok',
      detail: event.detail || '',
      createdAt: event.createdAt || new Date().toISOString(),
      meta: event.meta && typeof event.meta === 'object' ? event.meta : {},
    };

    this.state.usageEvents.push(nextEvent);

    if (this.state.usageEvents.length > 5000) {
      this.state.usageEvents.splice(0, this.state.usageEvents.length - 5000);
    }

    await this.persist();
    return this.clone(nextEvent);
  }

  listUsageEvents(provider) {
    const events = provider
      ? this.state.usageEvents.filter((item) => item.provider === provider)
      : this.state.usageEvents;

    return events
      .slice()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((item) => this.clone(item));
  }

  clone(value) {
    return JSON.parse(JSON.stringify(value));
  }
}

module.exports = {
  Store,
};
