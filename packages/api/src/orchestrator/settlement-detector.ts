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
  private readonly debounceMs: number

  constructor(
    private readonly signals: SettlementSignals,
    options: SettlementDetectorOptions = {},
  ) {
    super()
    this.debounceMs = options.debounceMs ?? 2000
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
      !this.signals.hasRunningTurn(sessionGroupId)
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
    this.removeAllListeners()
  }
}
