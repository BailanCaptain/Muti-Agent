import crypto from "node:crypto"

export type ActiveInvocation = {
  cancel: () => void
}

export type InvocationIdentity = {
  invocationId: string
  callbackToken: string
  threadId: string
  agentId: string
  expiresAt: string
}

type InvocationState<T extends ActiveInvocation> = InvocationIdentity & {
  run?: T
  expiryTimer?: ReturnType<typeof globalThis.setTimeout>
}

export class InvocationRegistry<T extends ActiveInvocation> {
  private readonly runs = new Map<string, T>()
  private readonly identities = new Map<string, InvocationState<T>>()

  // 3h: callback token TTL 同时把 run 的最长执行时长兜住。设计上 token TTL 和 run 寿命
  // 耦合在一条 setTimeout 上（到点 invalidateInvocation → run.cancel()），15min 太短
  // 经常把正在干活的 agent 半截砍掉。正确解法是解耦（token 跟 run 生命周期走，run 另配
  // hard-cap），见 F026 P1 I6。当前 3h 先顶住。
  constructor(private readonly ttlMs = 3 * 60 * 60 * 1000) {}

  createInvocation(threadId: string, agentId: string): InvocationIdentity {
    const identity: InvocationIdentity = {
      invocationId: crypto.randomUUID(),
      callbackToken: crypto.randomUUID(),
      threadId,
      agentId,
      expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
    }

    const expiresInMs = Math.max(0, new Date(identity.expiresAt).getTime() - Date.now())
    const expiryTimer = globalThis.setTimeout(() => {
      this.invalidateInvocation(identity.invocationId)
    }, expiresInMs)
    expiryTimer.unref?.()

    this.identities.set(identity.invocationId, { ...identity, expiryTimer })
    return identity
  }

  verifyInvocation(invocationId: string, callbackToken: string) {
    const invocation = this.identities.get(invocationId)
    if (!invocation) {
      return null
    }

    if (invocation.callbackToken !== callbackToken) {
      return null
    }

    if (new Date(invocation.expiresAt).getTime() <= Date.now()) {
      this.invalidateInvocation(invocationId)
      return null
    }

    return {
      invocationId: invocation.invocationId,
      callbackToken: invocation.callbackToken,
      threadId: invocation.threadId,
      agentId: invocation.agentId,
      expiresAt: invocation.expiresAt,
    }
  }

  attachRun(threadId: string, invocationId: string, run: T) {
    this.runs.set(threadId, run)
    const invocation = this.identities.get(invocationId)
    if (invocation) {
      invocation.run = run
    }
  }

  detachRun(threadId: string) {
    const run = this.runs.get(threadId)
    this.runs.delete(threadId)
    if (!run) {
      return
    }

    for (const invocation of this.identities.values()) {
      if (invocation.threadId === threadId && invocation.run === run) {
        invocation.run = undefined
      }
    }
  }

  revokeInvocation(invocationId: string) {
    const invocation = this.identities.get(invocationId)
    if (!invocation) {
      return
    }

    if (invocation.expiryTimer) {
      clearTimeout(invocation.expiryTimer)
      invocation.expiryTimer = undefined
    }

    this.identities.delete(invocationId)
  }

  findInvocationIdsByThread(threadId: string) {
    const invocationIds: string[] = []
    for (const invocation of this.identities.values()) {
      if (invocation.threadId === threadId) {
        invocationIds.push(invocation.invocationId)
      }
    }
    return invocationIds
  }

  invalidateInvocation(invocationId: string) {
    const invocation = this.identities.get(invocationId)
    if (!invocation) {
      return
    }

    invocation.run?.cancel()
    this.revokeInvocation(invocationId)
    if (this.runs.get(invocation.threadId) === invocation.run) {
      this.runs.delete(invocation.threadId)
    }
  }

  get(threadId: string) {
    return this.runs.get(threadId)
  }

  has(threadId: string) {
    return this.runs.has(threadId)
  }

  keys() {
    return this.runs.keys()
  }

  values() {
    return this.runs.values()
  }
}
