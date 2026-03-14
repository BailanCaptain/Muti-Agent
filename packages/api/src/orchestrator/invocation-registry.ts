import crypto from "node:crypto";

/** 能被 registry 持有的“运行句柄”。当前最少只要求能 cancel。 */
export type ActiveInvocation = {
  cancel: () => void;
};

/**
 * 一次 invocation 对外暴露的身份信息。
 * callback API 是否放行，就看这组信息是否匹配。
 */
export type InvocationIdentity = {
  /** 本次运行的唯一 ID。 */
  invocationId: string;
  /** callback API 的临时令牌。 */
  callbackToken: string;
  /** 本次运行属于哪个 thread。 */
  threadId: string;
  /** 当前运行中的 agent 身份。 */
  agentId: string;
  /** 这组身份的过期时间。 */
  expiresAt: string;
};

/**
 * registry 内部保存的 invocation 状态。
 * 它比对外暴露的身份多一个 run 句柄，用来支持 stop。
 */
type InvocationState<T extends ActiveInvocation> = InvocationIdentity & {
  /** 当前 thread 正在运行的真实句柄。 */
  run?: T;
};

export class InvocationRegistry<T extends ActiveInvocation> {
  /** threadId -> 当前仍在运行的句柄。用于 stop、running 判断。 */
  private readonly runs = new Map<string, T>();
  /** invocationId -> 当前 invocation 身份及其运行状态。 */
  private readonly identities = new Map<string, InvocationState<T>>();

  /** ttlMs 表示 invocation 身份能存活多久，默认 15 分钟。 */
  constructor(private readonly ttlMs = 15 * 60 * 1000) {}

  createInvocation(threadId: string, agentId: string): InvocationIdentity {
    const identity: InvocationIdentity = {
      invocationId: crypto.randomUUID(),
      callbackToken: crypto.randomUUID(),
      threadId,
      agentId,
      expiresAt: new Date(Date.now() + this.ttlMs).toISOString()
    };

    this.identities.set(identity.invocationId, { ...identity });
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

  invalidateInvocation(invocationId: string) {
    const invocation = this.identities.get(invocationId);
    if (!invocation) {
      return;
    }

    this.identities.delete(invocationId);
    if (this.runs.get(invocation.threadId) === invocation.run) {
      this.runs.delete(invocation.threadId);
    }
  }

  /** 主动把 invocation 立即设为过期。常用于运行结束后失效 token。 */
  expireInvocation(invocationId: string) {
    const invocation = this.identities.get(invocationId);
    if (!invocation) {
      return;
    }

    invocation.expiresAt = new Date().toISOString();
    this.invalidateInvocation(invocationId);
  }

  /** 通过 threadId 取当前正在运行的句柄。 */
  get(threadId: string) {
    return this.runs.get(threadId);
  }

  /** 这个 thread 当前是否有正在运行的 agent。 */
  has(threadId: string) {
    return this.runs.has(threadId);
  }

  delete(threadId: string) {
    this.runs.delete(threadId);
  }

  /** 返回所有“正在运行的 threadId”。 */
  keys() {
    return this.runs.keys();
  }
}
