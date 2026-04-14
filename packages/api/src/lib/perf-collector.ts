const DUMP_INTERVAL_MS = 30_000

class PerfCollector {
  private samples = new Map<string, number[]>()
  private timer: ReturnType<typeof setInterval> | null = null

  record(label: string, durationMs: number) {
    let arr = this.samples.get(label)
    if (!arr) {
      arr = []
      this.samples.set(label, arr)
    }
    arr.push(durationMs)
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.dump(), DUMP_INTERVAL_MS)
    this.timer.unref()
  }

  dump() {
    if (this.samples.size === 0) return
    console.log(`\n${"=".repeat(60)}`)
    console.log(`[perf-baseline] ${new Date().toISOString()}`)
    console.log(`${"=".repeat(60)}`)
    for (const [label, values] of this.samples) {
      const sorted = [...values].sort((a, b) => a - b)
      const n = sorted.length
      const p50 = sorted[Math.floor(n * 0.5)]
      const p90 = sorted[Math.floor(n * 0.9)]
      const p99 = sorted[Math.min(Math.floor(n * 0.99), n - 1)]
      const max = sorted[n - 1]
      console.log(
        `  ${label}: n=${n} P50=${p50.toFixed(1)}ms P90=${p90.toFixed(1)}ms P99=${p99.toFixed(1)}ms max=${max.toFixed(1)}ms`,
      )
    }
    console.log(`${"=".repeat(60)}\n`)
  }

  reset() {
    this.samples.clear()
  }
}

export const perfCollector = new PerfCollector()
perfCollector.start()
