import { EventEmitter } from "node:events"

export type SettlementSignals = {
  hasActiveParallelGroup: (sessionGroupId: string) => boolean
  hasQueuedDispatches: (sessionGroupId: string) => boolean
  hasRunningTurn: (sessionGroupId: string) => boolean
}

export type SettlementDetectorOptions = {
  debounceMs?: number
}

export class SettlementDetector extends EventEmitter {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly continuationInFlight = new Map<string, Set<string>>()
  private readonly debounceMs: number

  constructor(
    private readonly signals: SettlementSignals,
    options: SettlementDetectorOptions = {},
  ) {
    super()
    this.debounceMs = options.debounceMs ?? 2000
  }

  markContinuationInFlight(sessionGroupId: string, invocationId: string): void {
    const set = this.continuationInFlight.get(sessionGroupId) ?? new Set<string>()
    set.add(invocationId)
    this.continuationInFlight.set(sessionGroupId, set)
  }

  clearContinuationInFlight(sessionGroupId: string, invocationId: string): void {
    const set = this.continuationInFlight.get(sessionGroupId)
    if (!set) return
    set.delete(invocationId)
    if (set.size === 0) {
      this.continuationInFlight.delete(sessionGroupId)
    }
  }

  hasContinuationInFlight(sessionGroupId: string): boolean {
    return (this.continuationInFlight.get(sessionGroupId)?.size ?? 0) > 0
  }

  notifyStateChange(sessionGroupId: string): void {
    this.cancel(sessionGroupId)

    if (!this.isSettledNow(sessionGroupId)) {
      return
    }

    const timer = setTimeout(() => {
      this.timers.delete(sessionGroupId)
      if (this.isSettledNow(sessionGroupId)) {
        this.emit("settle", { sessionGroupId })
      }
    }, this.debounceMs)

    this.timers.set(sessionGroupId, timer)
  }

  isSettledNow(sessionGroupId: string): boolean {
    return (
      !this.signals.hasActiveParallelGroup(sessionGroupId) &&
      !this.signals.hasQueuedDispatches(sessionGroupId) &&
      !this.signals.hasRunningTurn(sessionGroupId) &&
      !this.hasContinuationInFlight(sessionGroupId)
    )
  }

  cancel(sessionGroupId: string): void {
    const timer = this.timers.get(sessionGroupId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(sessionGroupId)
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    this.continuationInFlight.clear()
    this.removeAllListeners()
  }
}
