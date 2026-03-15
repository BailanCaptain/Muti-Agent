"use client";

import { create } from "zustand";
import {
  PROVIDER_ALIASES,
  PROVIDERS,
  type Provider,
  type ProviderCatalog,
  type SessionGroupSummary,
  type TimelineMessage,
  type InvocationStats
} from "@multi-agent/shared";

type ProviderCardState = {
  threadId: string;
  alias: string;
  currentModel: string | null;
  quotaSummary: string;
  preview: string;
  running: boolean;
};

type ActiveGroupPayload = {
  id: string;
  title: string;
  meta: string;
  timeline: TimelineMessage[];
  providers: Record<Provider, ProviderCardState>;
};

type SessionListItem = {
  id: string;
  title: string;
  updatedAtLabel: string;
  previews: Array<{ provider: Provider; alias: string; text: string }>;
};

type SendPayload = {
  threadId: string;
  provider: Provider;
  content: string;
  alias: string;
};

type ThreadStore = {
  providers: Record<Provider, ProviderCardState>;
  catalogs: Record<Provider, ProviderCatalog>;
  sessionGroups: SessionListItem[];
  activeGroupId: string | null;
  activeGroup: { id: string; title: string; meta: string } | null;
  timeline: TimelineMessage[];
  invocationStats: InvocationStats[];
  bootstrap: () => Promise<void>;
  createSessionGroup: () => Promise<void>;
  selectSessionGroup: (groupId: string) => Promise<void>;
  updateModel: (provider: Provider, model: string) => Promise<void>;
  stopThread: (provider: Provider) => Promise<void>;
  replaceSessionGroups: (groups: SessionGroupSummary[]) => void;
  replaceActiveGroup: (group: ActiveGroupPayload) => void;
  applyAssistantDelta: (messageId: string, delta: string) => void;
  appendTimelineMessage: (message: TimelineMessage) => void;
  buildSendPayload: (input: string) => SendPayload | null;
};

const emptyProviders = Object.fromEntries(
  PROVIDERS.map((provider) => [
    provider,
    {
      threadId: "",
      alias: PROVIDER_ALIASES[provider],
      currentModel: null,
      quotaSummary: "额度信息待接入",
      preview: "还没有消息",
      running: false
    }
  ])
) as Record<Provider, ProviderCardState>;

const emptyCatalogs = Object.fromEntries(
  PROVIDERS.map((provider) => [
    provider,
    {
      provider,
      alias: PROVIDER_ALIASES[provider],
      currentModel: null,
      modelSuggestions: []
    }
  ])
) as unknown as Record<Provider, ProviderCatalog>;

function normalizeSessionGroups(groups: SessionGroupSummary[]): SessionListItem[] {
  return groups.map((group) => ({
    id: group.id,
    title: group.title,
    updatedAtLabel: group.updatedAtLabel,
    previews: group.previews
  }));
}

function parseMention(input: string): Provider | null {
  const match = input.trim().match(/@([^\s]+)/);
  if (!match) {
    return null;
  }

  const alias = match[1].toLowerCase();
  if (alias === PROVIDER_ALIASES.codex.toLowerCase() || alias === "codex") {
    return "codex";
  }
  if (alias === PROVIDER_ALIASES.claude.toLowerCase() || alias === "claude" || alias === "claudecode") {
    return "claude";
  }
  if (alias === PROVIDER_ALIASES.gemini.toLowerCase() || alias === "gemini") {
    return "gemini";
  }

  return null;
}

function mergeTimeline(existing: TimelineMessage[], incoming: TimelineMessage[]) {
  const existingById = new Map(existing.map((message) => [message.id, message]));

  return incoming
    .map((message) => {
      const current = existingById.get(message.id);
      if (!current) {
        return message;
      }

      // `thread_snapshot` 里的 assistant 内容来自数据库，流式过程中它往往会落后于
      // 前端本地已经通过 assistant_delta 追加的内容。这里优先保留更长的那份文本，
      // 避免气泡被快照回滚成旧内容，最终表现成“最后一瞬间整段弹出来”。
      const content =
        current.role === message.role &&
        current.provider === message.provider &&
        current.content.length > message.content.length
          ? current.content
          : message.content;

      return {
        ...message,
        content
      };
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787";
  const response = await fetch(`${baseUrl}${path}`, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `请求失败: ${response.status}`);
  }

  return (await response.json()) as T;
}

export const useThreadStore = create<ThreadStore>((set, get) => ({
  providers: emptyProviders,
  catalogs: emptyCatalogs,
  sessionGroups: [],
  activeGroupId: null,
  activeGroup: null,
  timeline: [],
  invocationStats: [],
  bootstrap: async () => {
    // Bootstrap stitches together the static provider catalog and the latest session list before selecting a room.
    const [groupsPayload, providersPayload] = await Promise.all([
      fetchJson<{ sessionGroups: SessionGroupSummary[] }>("/api/bootstrap"),
      fetchJson<{ providers: ProviderCatalog[] }>("/api/providers")
    ]);

    set({
      catalogs: Object.fromEntries(
        providersPayload.providers.map((item) => [item.provider, item])
      ) as Record<Provider, ProviderCatalog>
    });
    get().replaceSessionGroups(groupsPayload.sessionGroups);

    if (groupsPayload.sessionGroups[0]) {
      await get().selectSessionGroup(groupsPayload.sessionGroups[0].id);
      return;
    }

    await get().createSessionGroup();
  },
  createSessionGroup: async () => {
    const payload = await fetchJson<{ groupId: string }>("/api/session-groups", {
      method: "POST"
    });
    const groupsPayload = await fetchJson<{ sessionGroups: SessionGroupSummary[] }>("/api/bootstrap");
    get().replaceSessionGroups(groupsPayload.sessionGroups);
    await get().selectSessionGroup(payload.groupId);
  },
  selectSessionGroup: async (groupId) => {
    const payload = await fetchJson<{ activeGroup: ActiveGroupPayload }>(`/api/session-groups/${groupId}`);
    set({ activeGroupId: groupId });
    get().replaceActiveGroup(payload.activeGroup);
  },
  updateModel: async (provider, model) => {
    const thread = get().providers[provider];
    if (!thread.threadId) {
      return;
    }

    const payload = await fetchJson<{ activeGroup: ActiveGroupPayload }>(`/api/threads/${thread.threadId}/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model })
    });

    get().replaceActiveGroup(payload.activeGroup);
  },
  stopThread: async (provider) => {
    const thread = get().providers[provider];
    if (!thread.threadId) {
      return;
    }

    await fetchJson(`/api/threads/${thread.threadId}/stop`, {
      method: "POST"
    });
  },
  replaceSessionGroups: (groups) => {
    set({ sessionGroups: normalizeSessionGroups(groups) });
  },
  replaceActiveGroup: (group) => {
    set((state) => ({
      activeGroup: { id: group.id, title: group.title, meta: group.meta },
      // Snapshots come from the database and can momentarily lag behind local deltas, so merge instead of replacing.
      timeline: mergeTimeline(state.timeline, group.timeline),
      providers: group.providers
    }));
  },
  appendTimelineMessage: (message) => {
    set((state) => {
      if (state.timeline.some((item) => item.id === message.id)) {
        return state;
      }

      return {
        timeline: [...state.timeline, message].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      };
    });
  },
  applyAssistantDelta: (messageId, delta) => {
    set((state) => ({
      timeline: state.timeline.map((message) =>
        message.id === messageId ? { ...message, content: `${message.content}${delta}` } : message
      )
    }));
  },
  buildSendPayload: (input) => {
    // The frontend sends the resolved provider/thread pair so the backend ws route can stay transport-focused.
    const provider = parseMention(input);
    if (!provider) {
      return null;
    }

    const content = input.replace(/@([^\s]+)/, "").trim();
    if (!content) {
      return null;
    }

    const thread = get().providers[provider];
    if (!thread.threadId) {
      return null;
    }

    return {
      threadId: thread.threadId,
      provider,
      content,
      alias: thread.alias
    };
  }
}));
