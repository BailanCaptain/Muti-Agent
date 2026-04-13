export type EmbeddingRecord = {
  messageId: string
  threadId: string
  chunkText: string
  embedding: number[]
  createdAt: string
}

export type SearchResult = EmbeddingRecord & { score: number }

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (denom === 0) return 0
  return dot / denom
}

export function searchByEmbedding(
  queryEmbedding: number[],
  records: EmbeddingRecord[],
  topK: number,
  decayHalfLifeHours = 168,
  excludeMessageIds?: Set<string>,
): SearchResult[] {
  const now = Date.now()
  const scored: SearchResult[] = []

  for (const rec of records) {
    if (excludeMessageIds?.has(rec.messageId)) continue
    const sim = cosineSimilarity(queryEmbedding, rec.embedding)
    const ageHours = (now - new Date(rec.createdAt).getTime()) / (1000 * 60 * 60)
    const decay = Math.exp(-ageHours / decayHalfLifeHours)
    scored.push({ ...rec, score: sim * decay })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK)
}

export class EmbeddingService {
  private records: EmbeddingRecord[] = []
  private pipeline: any = null
  private loading = false

  async ensureModel(): Promise<boolean> {
    if (this.pipeline) return true
    if (this.loading) return false
    this.loading = true
    try {
      const { pipeline } = await import("@huggingface/transformers")
      this.pipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
      return true
    } catch {
      this.loading = false
      return false
    }
  }

  async generateEmbedding(text: string): Promise<number[] | null> {
    if (!await this.ensureModel()) return null
    try {
      const output = await this.pipeline(text, { pooling: "mean", normalize: true })
      return Array.from(output.data as Float32Array)
    } catch {
      return null
    }
  }

  addRecord(record: EmbeddingRecord) {
    this.records.push(record)
  }

  search(queryEmbedding: number[], topK: number, excludeMessageIds?: Set<string>): SearchResult[] {
    return searchByEmbedding(queryEmbedding, this.records, topK, 168, excludeMessageIds)
  }

  getRecordCount(): number {
    return this.records.length
  }
}
