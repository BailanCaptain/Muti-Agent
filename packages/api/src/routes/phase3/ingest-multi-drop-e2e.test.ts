/**
 * F027 AC-P1-5 · multi-drop 接 live ingest E2E（preview correlate + commit record）
 *
 * 验证 crossCorrelateDrops 真接进 ingest 产线（之前只有算法+fixture，没接线）：
 *   1. 无历史 → preview 不出 multi_drop warning（isolated）
 *   2. record 一条历史 drop（模拟先前 commit）→ preview 高相似新 drop → 出 chained_suspect warning
 *   3. preview 算好的 embedding 存 store → commit 后 record 进 recent_drops（下次能关联）
 *   4. embedding 抛错 → 仍跑确定性检测（keyword-chain）→ chained_suspect（codex P1-1 修）
 *   5. chained_suspect → commit 后端强制落 _quarantined/ 隔离（codex P1-2 修）
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

  // codex P1-1 修：embedding 失败不该跳过确定性检测（keyword-chain / reference-link）。
  // 历史 drop id 被 current 显式引用（reference_link）→ 即使 embedding 抛错（sim=0），
  // reference-link 确定性检测仍命中 → chained_suspect。修前 embedding 抛错会整体 return {} 绕过。
  // 用 reference_link 而非 keyword-chain：后者的 execute 模式与 sanitize jailbreak 红线重叠，
  // 触发 keyword-chain 的内容会先被 sanitize block 到不了关联（reference_link 是 benign 引用）。
  it("embedding 抛错 → 仍跑确定性检测：reference_link 命中 → chained_suspect", async () => {
    const throwingEmbedding = {
      generateEmbedding: async (): Promise<number[] | null> => {
        throw new Error("embedding service down")
      },
    }
    // 历史 drop（benign 正文，id = rag-paper-part-2，无 embedding）
    repo.record({
      id: "rag-paper-part-2",
      rawContent: "RAG 论文第二部分的正文内容",
      ingestedAt: Date.now() - 3600_000,
      contributedBy: "user-drop",
    })
    const svc = new IngestPreviewService({
      store,
      correlate: { embedding: throwingEmbedding, recentDrops: repo },
    })
    // current benign 文档但显式引用历史 drop id → reference_link 触发
    const res = await svc.preview(
      body({
        content:
          "# RAG 笔记\n\n这是关于检索增强生成的整理，参考 drop rag-paper-part-2 的内容继续展开论述。",
      }),
    )
    assert.ok(res.previewId, "preview 仍返回（embedding fail-soft 不阻断）")
    const md = res.warnings.find((w) => w.kind === "multi_drop")
    assert.ok(md, "embedding 挂了但 reference_link 确定性检测仍出 chained_suspect（修前会被绕过）")
    assert.match(md?.subkind ?? "", /chained_suspect/, "确定性检测命中 chained_suspect")
  })

  it("embedding 抛错 + 无历史 → preview 不挂、无 warning（fail-soft 不误报）", async () => {
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
    assert.ok(!res.warnings.some((w) => w.kind === "multi_drop"), "无历史 → 不误报")
  })

  // codex P1-2 修：chained_suspect → store verdict + commit 落 _quarantined/（后端强制隔离）
  it("chained_suspect → store chainedSuspect=true → commit 落 _quarantined/", () => {
    store.put({
      previewId: "pv-chain",
      sourcePath: "concepts/evil.md",
      sanitizedContent: "# Evil\n\ncontent",
      mimeType: "text/markdown",
      createdAt: "2026-05-31T00:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z",
      contributedBy: "user-drop",
      ingestedAt: 1_750_000_000_000,
      chainedSuspect: true,
    })
    let capturedPath = ""
    const stubLease = {
      acquireLease: () => ({ fencingToken: "f1" }),
      releaseLease: () => {},
    } as unknown as WikiLeasesRepository
    const stubUpdateWiki = {
      updateWiki: (input: { path: string }) => {
        capturedPath = input.path
        return { status: "ok", eventId: 1 } as UpdateWikiResponse
      },
    } as unknown as UpdateWikiService
    const commitSvc = new IngestCommitService({
      store,
      updateWiki: stubUpdateWiki,
      leases: stubLease,
      leaderTerm: () => "1",
    })
    const result = commitSvc.commit({ previewId: "pv-chain", callerAlias: "小孙" })
    assert.ok(result.ok, "commit 成功")
    assert.match(capturedPath, /_quarantined\//, "chained_suspect 后端强制落 _quarantined/")
    assert.doesNotMatch(capturedPath, /_auto\//, "不落正常 _auto/")
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
