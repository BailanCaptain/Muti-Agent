type Tags = Record<string, string>

type CounterEntry = { name: string; tags: Tags; count: number }
type GaugeEntry = { name: string; tags: Tags; value: number; updatedAt: string }

function tagsMatch(entryTags: Tags, filterTags?: Tags): boolean {
  if (!filterTags) return true
  for (const [k, v] of Object.entries(filterTags)) {
    if (entryTags[k] !== v) return false
  }
  return true
}

export class MetricsService {
  private counters: CounterEntry[] = []
  private gauges: GaugeEntry[] = []

  increment(name: string, tags: Tags = {}) {
    const existing = this.counters.find(
      (c) => c.name === name && JSON.stringify(c.tags) === JSON.stringify(tags),
    )
    if (existing) {
      existing.count++
    } else {
      this.counters.push({ name, tags, count: 1 })
    }
  }

  gauge(name: string, value: number, tags: Tags = {}) {
    const existing = this.gauges.find(
      (g) => g.name === name && JSON.stringify(g.tags) === JSON.stringify(tags),
    )
    if (existing) {
      existing.value = value
      existing.updatedAt = new Date().toISOString()
    } else {
      this.gauges.push({ name, tags, value, updatedAt: new Date().toISOString() })
    }
  }

  getCount(name: string, filterTags?: Tags): number {
    return this.counters
      .filter((c) => c.name === name && tagsMatch(c.tags, filterTags))
      .reduce((sum, c) => sum + c.count, 0)
  }

  getLastGauge(name: string, filterTags?: Tags): number | null {
    const matching = this.gauges.filter(
      (g) => g.name === name && tagsMatch(g.tags, filterTags),
    )
    if (matching.length === 0) return null
    return matching[matching.length - 1].value
  }

  getSnapshot() {
    return {
      counters: [...this.counters],
      gauges: [...this.gauges],
    }
  }
}
