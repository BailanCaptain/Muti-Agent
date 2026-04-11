import type { Provider } from "@multi-agent/shared";

export type A2AChainEntry = {
  invocationId: string;
  threadId: string;
  provider: Provider;
  alias: string;
  parentInvocationId: string | null;
  rootMessageId: string;
  sessionGroupId: string;
  createdAt: number;
};

export class A2AChainRegistry {
  private readonly entries = new Map<string, A2AChainEntry>();

  register(entry: A2AChainEntry): void {
    this.entries.set(entry.invocationId, entry);
  }

  get(invocationId: string): A2AChainEntry | null {
    return this.entries.get(invocationId) ?? null;
  }

  getParent(invocationId: string): A2AChainEntry | null {
    const child = this.entries.get(invocationId);
    if (!child || !child.parentInvocationId) return null;
    return this.entries.get(child.parentInvocationId) ?? null;
  }

  release(invocationId: string): void {
    this.entries.delete(invocationId);
  }
}
