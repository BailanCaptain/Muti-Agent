/**
 * F027 AC-P1-5 · RecentDropsRepository 单测
 *   - record + queryWindow roundtrip（含 embedding JSON 序列化/反序列化）
 *   - 7 天窗口过滤（窗内取、窗外滤）
 *   - embedding 缺失/损坏 → undefined（不抛）
 *   - record 重复 id → 覆盖
 *   - pruneOlderThan
 */

import assert from "node:assert/strict"
import { describe, it, beforeEach } from "node:test"
import { createDrizzleDb } from "../drizzle-instance"
import { RecentDropsRepository } from "./recent-drops-repository"

function makeDb() {
  const { db } = createDrizzleDb(":memory:")
  return db
}

const DAY = 86_400_000

describe("RecentDropsRepository", () => {
  let repo: RecentDropsRepository
  const now = 1_750_000_000_000 // 固定 ingestedAt 基准

  beforeEach(() => {
    repo = new RecentDropsRepository(makeDb(), () => "2026-05-31T00:00:00Z")
  })

  it("record + queryWindow roundtrip（含 embedding）", () => {
    repo.record({
      id: "d1",
      rawContent: "RAG paper part 1",
      ingestedAt: now,
      contributedBy: "小孙",
      seriesId: "series-A",
      embedding: [0.1, 0.2, 0.3],
    })
    const rows = repo.queryWindow(now, 7)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, "d1")
    assert.equal(rows[0].rawContent, "RAG paper part 1")
    assert.equal(rows[0].contributedBy, "小孙")
    assert.equal(rows[0].seriesId, "series-A")
    assert.deepEqual(rows[0].embedding, [0.1, 0.2, 0.3])
  })

  it("7 天窗口：窗内取、窗外滤", () => {
    repo.record({ id: "in", rawContent: "x", ingestedAt: now - 6 * DAY, contributedBy: "a" })
    repo.record({ id: "edge", rawContent: "x", ingestedAt: now - 7 * DAY, contributedBy: "a" })
    repo.record({ id: "out", rawContent: "x", ingestedAt: now - 8 * DAY, contributedBy: "a" })
    const ids = repo
      .queryWindow(now, 7)
      .map((d) => d.id)
      .sort()
    assert.deepEqual(ids, ["edge", "in"], "8 天前的 out 被滤，6/7 天的留")
  })

  it("embedding 缺失 → undefined（不抛）", () => {
    repo.record({ id: "d2", rawContent: "no embed", ingestedAt: now, contributedBy: "a" })
    const rows = repo.queryWindow(now, 7)
    assert.equal(rows[0].embedding, undefined)
    assert.equal(rows[0].seriesId, undefined)
  })

  it("record 重复 id → 覆盖（onConflictDoUpdate）", () => {
    repo.record({ id: "dup", rawContent: "v1", ingestedAt: now, contributedBy: "a" })
    repo.record({ id: "dup", rawContent: "v2", ingestedAt: now, contributedBy: "a" })
    const rows = repo.queryWindow(now, 7)
    assert.equal(rows.length, 1, "同 id 不重复行")
    assert.equal(rows[0].rawContent, "v2", "后写覆盖")
  })

  it("pruneOlderThan 清超窗 drop", () => {
    repo.record({ id: "old", rawContent: "x", ingestedAt: now - 10 * DAY, contributedBy: "a" })
    repo.record({ id: "new", rawContent: "x", ingestedAt: now, contributedBy: "a" })
    const removed = repo.pruneOlderThan(now - 7 * DAY)
    assert.equal(removed, 1)
    const ids = repo.queryWindow(now, 30).map((d) => d.id)
    assert.deepEqual(ids, ["new"])
  })

  // codex P3-4 修：pruneOlderThan 用 `<` 严格小于，不删窗口边界行（queryWindow 含 >= windowStart）
  it("pruneOlderThan 边界：恰在 cutoff 的行不删（< 不是 <=）", () => {
    const cutoff = now - 7 * DAY
    repo.record({ id: "edge", rawContent: "x", ingestedAt: cutoff, contributedBy: "a" })
    const removed = repo.pruneOlderThan(cutoff)
    assert.equal(removed, 0, "恰在 cutoff 的行保留（与 queryWindow >= 边界一致）")
    assert.deepEqual(
      repo.queryWindow(now, 7).map((d) => d.id),
      ["edge"],
      "边界行仍在 7 天窗内",
    )
  })


  // codex P3-4 修：pruneOlderThan 用 `<` 严格小于，不删窗口边界行（queryWindow 含 >= windowStart）
  it("pruneOlderThan 边界：恰在 cutoff 的行不删（< 不是 <=）", () => {
    const cutoff = now - 7 * DAY
    repo.record({ id: "edge", rawContent: "x", ingestedAt: cutoff, contributedBy: "a" })
    const removed = repo.pruneOlderThan(cutoff)
    assert.equal(removed, 0, "恰在 cutoff 的行保留（与 queryWindow >= 边界一致）")
    assert.deepEqual(
      repo.queryWindow(now, 7).map((d) => d.id),
      ["edge"],
      "边界行仍在 7 天窗内",
    )
  })
})
