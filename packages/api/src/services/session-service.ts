import type { Provider, ProviderCatalog, SessionGroupSummary, TimelineMessage } from "@multi-agent/shared";
import type { ProviderProfile } from "../runtime/provider-profiles";
import { SessionRepository } from "../storage/repositories";

type ProviderView = {
  threadId: string;
  alias: string;
  currentModel: string | null;
  quotaSummary: string;
  preview: string;
  running: boolean;
};

export class SessionService {
  constructor(
    private readonly repository: SessionRepository,
    private readonly providerProfiles: ProviderProfile[]
  ) {
    this.repository.reconcileLegacyDefaultModels({
      codex: {
        from: ["gpt-5-codex", "gpt-5", "o3"],
        to: this.providerProfiles.find((profile) => profile.provider === "codex")?.currentModel ?? null
      },
      claude: {
        from: ["claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-opus-4-1"],
        to: this.providerProfiles.find((profile) => profile.provider === "claude")?.currentModel ?? null
      },
      gemini: {
        from: ["gemini-2.5-pro", "gemini-2.5-flash"],
        to: this.providerProfiles.find((profile) => profile.provider === "gemini")?.currentModel ?? null
      }
    });
  }

  listSessionGroups(): SessionGroupSummary[] {
    return this.repository.listSessionGroups().map((group) => ({
      id: group.id,
      title: group.title,
      updatedAtLabel: new Date(group.updatedAt).toLocaleString("zh-CN"),
      previews: group.previews
    }));
  }

  listProviderCatalog(): ProviderCatalog[] {
    return this.providerProfiles.map((profile) => ({
      provider: profile.provider,
      alias: profile.alias,
      currentModel: profile.currentModel,
      modelSuggestions: profile.modelSuggestions
    }));
  }

  createSessionGroup() {
    const groupId = this.repository.createSessionGroup();
    this.repository.ensureDefaultThreads(
      groupId,
      Object.fromEntries(this.providerProfiles.map((profile) => [profile.provider, profile.currentModel])) as Record<
        Provider,
        string | null
      >
    );
    return groupId;
  }

  getActiveGroup(groupId: string, runningThreadIds: Set<string>) {
    const groups = this.repository.listSessionGroups();
    const summary = groups.find((group) => group.id === groupId);
    const threads = this.repository.listThreadsByGroup(groupId);

    const providers = Object.fromEntries(
      threads.map((thread) => [
        thread.provider,
        {
          threadId: thread.id,
          alias: thread.alias,
          currentModel: thread.currentModel,
          quotaSummary: "额度待接入",
          preview: summary?.previews.find((item) => item.provider === thread.provider)?.text ?? "",
          running: runningThreadIds.has(thread.id)
        }
      ])
    ) as Record<Provider, ProviderView>;

    const timeline = threads
      .flatMap((thread) =>
        this.repository.listMessages(thread.id).map(
          (message): TimelineMessage => ({
            id: message.id,
            provider: thread.provider,
            alias: thread.alias,
            role: message.role,
            content: message.role === "user" ? `@${thread.alias} ${message.content}` : message.content,
            model: thread.currentModel,
            createdAt: message.createdAt
          })
        )
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    return {
      id: groupId,
      title: summary?.title ?? "未命名会话",
      meta: `最近更新：${summary ? new Date(summary.updatedAt).toLocaleString("zh-CN") : "--"}，当前按三方会话组展示。`,
      timeline,
      providers
    };
  }

  findThread(threadId: string) {
    return this.repository.getThreadById(threadId) ?? null;
  }

  appendUserMessage(threadId: string, content: string) {
    return this.repository.appendMessage(threadId, "user", content);
  }

  appendAssistantMessage(threadId: string, content: string) {
    return this.repository.appendMessage(threadId, "assistant", content);
  }

  overwriteMessage(messageId: string, content: string) {
    this.repository.overwriteMessage(messageId, content);
  }

  listHistory(threadId: string) {
    return this.repository.listMessages(threadId).map((message) => ({
      role: message.role,
      content: message.content
    }));
  }

  updateThread(threadId: string, model: string | null, nativeSessionId: string | null) {
    this.repository.updateThread(threadId, {
      currentModel: model,
      nativeSessionId
    });
  }
}
