/**
 * F027 AC-P1-5 · multi-drop 接 live ingest E2E（preview correlate + commit record）
 *
 * 验证 crossCorrelateDrops 真接进 ingest 产线（之前只有算法+fixture，没接线）：
 *   1. 无历史 → preview 不出 multi_drop warning（isolated）
 *   2. record 一条历史 drop（模拟先前 commit）→ preview 高相似新 drop → 出 chained_suspect warning
 *   3. preview 算好的 embedding 存 store → commit 后 record 进 recent_drops（下次能关联）
 *   4. embedding service 抛错 → fail-soft，preview 不挂（无 warning）
 */

import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"
import { createDrizzleDb } from "../../db/drizzle-instance"
import { RecentDropsRepository } from "../../db/repositories/recent-drops-repository"
import { IngestPreviewService } from "./ingest-preview"
import { IngestCommitService } from "./ingest-commit"
import { PreviewStore } from "./preview-store"
import type { PreviewIngestBody } from "./contracts"
import type { UpdateWikiResponse, UpdateWikiService } from "../../wiki/update-wiki-service"
import type { WikiLeasesRepository } from "../../db/repositories/wiki-leases-repository"

// stub embedding：任意输入返回同一向量 → cosine=1.0 ≥ 0.7 → high_sim_diff_series
const SAME_VEC = [0.5, 0.5, 0.5, 0.5]
function stubEmbedding(returnVec: number[] | null = SAME_VEC) {
  return {
    generateEmbedding: async (_text: string): Promise<number[] | null> => returnVec,
  }
}

function body(overrides?: Partial<PreviewIngestBody>): PreviewIngestBody {
  return {
    sourcePath: "concepts/drop.md",
    content: "# Drop\n\nsome clean declarative knowledge content here for ingest.",
    mimeType: "text/markdown",
    targetType: "concept",
    ...overrides,
  } as PreviewIngestBody
}

describe("F027 AC-P1-5 · multi-drop 接 live ingest E2E", () => {
  let repo: RecentDropsRepository
  let store: PreviewStore

  beforeEach(() => {
    const { db } = createDrizzleDb(":memory:")
    repo = new RecentDropsRepository(db, () => "2026-05-31T00:00:00Z")
    store = new PreviewStore()
  })

  it("无历史 drop → preview 不出 multi_drop warning（isolated）", async () => {
    const svc = new IngestPreviewService({
      store,
      correlate: { embedding: stubEmbedding(), recentDrops: repo },
    })
    const res = await svc.preview(body())
    assert.ok(!res.warnings.some((w) => w.kind === "multi_drop"), "无历史 → 不报 multi_drop")
  })

  it("有高相似历史 drop（diff series）→ preview 出 chained_suspect warning", async () => {
    // 模拟先前已 commit 一条 drop
    repo.record({
      id: "prev-1",
      rawContent: "earlier dropped content",
      ingestedAt: Date.now() - 3600_000, // 1h 前，窗内
      contributedBy: "user-drop",
      embedding: SAME_VEC,
    })
    const svc = new IngestPreviewService({
      store,
      correlate: { embedding: stubEmbedding(), recentDrops: repo },
    })
    const res = await svc.preview(body())
    const md = res.warnings.find((w) => w.kind === "multi_drop")
    assert.ok(md, "应出 multi_drop warning")
    assert.match(md?.subkind ?? "", /chained_suspect/, "subkind 标 chained_suspect")
    assert.match(md?.message ?? "", /指令链/, "message 说明疑似指令链")
  })

  it("preview embedding 存 store → commit record 进 recent_drops（下次能关联）", async () => {
    const svc = new IngestPreviewService({
      store,
      correlate: { embedding: stubEmbedding(), recentDrops: repo },
    })
    const res = await svc.preview(body())
    const entry = store.peek(res.previewId)
    assert.equal(entry.reason, "ok")
    assert.deepEqual(entry.entry?.embedding, SAME_VEC, "preview 算好的 embedding 存进 store")
    assert.equal(entry.entry?.contributedBy, "user-drop")
    assert.ok(typeof entry.entry?.ingestedAt === "number", "ingestedAt 存进 store")
  })

  it("embedding 抛错 → fail-soft，preview 不挂、不出 multi_drop warning", async () => {
    const throwingEmbedding = {
      generateEmbedding: async (): Promise<number[] | null> => {
        throw new Error("embedding service down")
      },
    }
    const svc = new IngestPreviewService({
      store,
      correlate: { embedding: throwingEmbedding, recentDrops: repo },
    })
    const res = await svc.preview(body())
    assert.ok(res.previewId, "preview 仍返回（fail-soft）")
    assert.ok(!res.warnings.some((w) => w.kind === "multi_drop"), "关联失败不出 multi_drop")
  })

  it("未注入 correlate dep → 行为同现状（无 multi_drop，向后兼容）", async () => {
    const svc = new IngestPreviewService({ store })
    const res = await svc.preview(body())
    assert.ok(!res.warnings.some((w) => w.kind === "multi_drop"))
  })

  it("commit 成功 → record 进 recent_drops（用 preview 算好的 embedding，下次可关联）", () => {
    // store 放一条带关联元数据的 preview entry（模拟 preview 已算好 embedding）
    store.put({
      previewId: "pv-1",
      sourcePath: "concepts/x.md",
      sanitizedContent: "# X\n\ncontent",
      mimeType: "text/markdown",
      createdAt: "2026-05-31T00:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z",
      embedding: SAME_VEC,
      contributedBy: "user-drop",
      ingestedAt: 1_750_000_000_000,
    })
    const stubLease = {
      acquireLease: () => ({ fencingToken: "fence-1" }),
      releaseLease: () => {},
    } as unknown as WikiLeasesRepository
    const okResp: UpdateWikiResponse = { status: "ok", eventId: 42 } as UpdateWikiResponse
    const stubUpdateWiki = { updateWiki: () => okResp } as unknown as UpdateWikiService

    const commitSvc = new IngestCommitService({
      store,
      updateWiki: stubUpdateWiki,
      leases: stubLease,
      leaderTerm: () => "1",
      recentDrops: repo,
    })
    const result = commitSvc.commit({ previewId: "pv-1", callerAlias: "小孙" })
    assert.ok(result.ok, "commit 成功")

    // recent_drops 真写了一条，且 embedding/contributedBy 来自 preview
    const rows = repo.queryWindow(1_750_000_000_000, 7)
    assert.equal(rows.length, 1, "commit 后 recent_drops 有一条")
    assert.equal(rows[0].id, "pv-1")
    assert.deepEqual(rows[0].embedding, SAME_VEC, "用 preview 算好的 embedding（commit 不重 embed）")
    assert.equal(rows[0].contributedBy, "user-drop")
  })
})
