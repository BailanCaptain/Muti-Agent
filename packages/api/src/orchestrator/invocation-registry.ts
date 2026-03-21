import crypto from "node:crypto";

export type ActiveInvocation = {
  cancel: () => void;
};

export type InvocationIdentity = {
  invocationId: string;
  callbackToken: string;
  threadId: string;
  agentId: string;
  expiresAt: string;
};

type InvocationState<T extends ActiveInvocation> = InvocationIdentity & {
  run?: T;
  expiryTimer?: ReturnType<typeof globalThis.setTimeout>;
};

export class InvocationRegistry<T extends ActiveInvocation> {
  private readonly runs = new Map<string, T>();
  private readonly identities = new Map<string, InvocationState<T>>();

  constructor(private readonly ttlMs = 15 * 60 * 1000) {}

  createInvocation(threadId: string, agentId: string): InvocationIdentity {
    const identity: InvocationIdentity = {
      invocationId: crypto.randomUUID(),
      callbackToken: crypto.randomUUID(),
      threadId,
      agentId,
      expiresAt: new Date(Date.now() + this.ttlMs).toISOString()
    };

    const expiresInMs = Math.max(0, new Date(identity.expiresAt).getTime() - Date.now());
    const expiryTimer = globalThis.setTimeout(() => {
      this.invalidateInvocation(identity.invocationId);
    }, expiresInMs);
    expiryTimer.unref?.();

    this.identities.set(identity.invocationId, { ...identity, expiryTimer });
    return identity;
  }

  verifyInvocation(invocationId: string, callbackToken: string) {
    const invocation = this.identities.get(invocationId);
    if (!invocation) {
      return null;
    }

    if (invocation.callbackToken !== callbackToken) {
      return null;
    }

    if (new Date(invocation.expiresAt).getTime() <= Date.now()) {
      this.invalidateInvocation(invocationId);
      return null;
    }

    return {
      invocationId: invocation.invocationId,
      callbackToken: invocation.callbackToken,
      threadId: invocation.threadId,
      agentId: invocation.agentId,
      expiresAt: invocation.expiresAt
    };
  }

  attachRun(threadId: string, invocationId: string, run: T) {
    this.runs.set(threadId, run);
    const invocation = this.identities.get(invocationId);
    if (invocation) {
      invocation.run = run;
    }
  }

  detachRun(threadId: string) {
    const run = this.runs.get(threadId);
    this.runs.delete(threadId);
    if (!run) {
      return;
    }

    for (const invocation of this.identities.values()) {
      if (invocation.threadId === threadId && invocation.run === run) {
        invocation.run = undefined;
      }
    }
  }

  invalidateInvocation(invocationId: string) {
    const invocation = this.identities.get(invocationId);
    if (!invocation) {
      return;
    }

    if (invocation.expiryTimer) {
      clearTimeout(invocation.expiryTimer);
      invocation.expiryTimer = undefined;
    }

    this.identities.delete(invocationId);
    if (this.runs.get(invocation.threadId) === invocation.run) {
      this.runs.delete(invocation.threadId);
    }
  }

  get(threadId: string) {
    return this.runs.get(threadId);
  }

  has(threadId: string) {
    return this.runs.has(threadId);
  }

  keys() {
    return this.runs.keys();
  }

  values() {
    return this.runs.values();
  }
}
