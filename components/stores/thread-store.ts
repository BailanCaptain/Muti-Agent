"use client";

import { create } from "zustand";
import {
  PROVIDER_ALIASES,
  PROVIDERS,
  type Provider,
  type ProviderCatalog,
  type SessionGroupSummary,
  type TimelineMessage
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
  bootstrap: () => Promise<void>;
  createSessionGroup: () => Promise<void>;
  selectSessionGroup: (groupId: string) => Promise<void>;
  updateModel: (provider: Provider, model: string) => Promise<void>;
  stopThread: (provider: Provider) => Promise<void>;
  replaceSessionGroups: (groups: SessionGroupSummary[]) => void;
  replaceActiveGroup: (group: ActiveGroupPayload) => void;
  applyAssistantDelta: (messageId: string, delta: string) => void;
  buildSendPayload: (input: string) => SendPayload | null;
};

const emptyProviders = Object.fromEntries(
  PROVIDERS.map((provider) => [
    provider,
    {
      threadId: "",
      alias: PROVIDER_ALIASES[provider],
      currentModel: null,
      quotaSummary: "额度待同步",
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
  if (alias === "范德彪" || alias === "codex") {
    return "codex";
  }
  if (alias === "黄仁勋" || alias === "claude" || alias === "claudecode") {
    return "claude";
  }
  if (alias === "桂芬" || alias === "gemini") {
    return "gemini";
  }

  return null;
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
  bootstrap: async () => {
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
    set({
      activeGroup: { id: group.id, title: group.title, meta: group.meta },
      timeline: group.timeline,
      providers: group.providers
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
