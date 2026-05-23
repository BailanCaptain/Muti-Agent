/**
 * F027 Phase 3 P20 · PreviewStore tests — Week 2 Day 9-10 (AC-P3-10)
 */

import assert from "node:assert/strict"
import test from "node:test"
import { PreviewStore, type PreviewStoreEntry } from "./preview-store"

function makeEntry(
  id: string,
  expiresAt: string,
  sourcePath = "concepts/foo.md",
): PreviewStoreEntry {
  return {
    previewId: id,
    sourcePath,
    sanitizedContent: `# ${id} content`,
    mimeType: "text/markdown",
    createdAt: "2026-05-21T08:00:00.000Z",
    expiresAt,
  }
}

test("Day 9-10 · PreviewStore · put → take ok → entry returned + removed", () => {
  const store = new PreviewStore()
  store.put(makeEntry("pv-1", "2030-01-01T00:00:00.000Z"))
  assert.equal(store.size(), 1)
  const r1 = store.take("pv-1")
  assert.equal(r1.reason, "ok")
  assert.equal(r1.entry?.previewId, "pv-1")
  assert.equal(store.size(), 0, "take 后从 store 删除（一次性消费）")
  // 重复 take 不存在
  const r2 = store.take("pv-1")
  assert.equal(r2.reason, "not_found")
  assert.equal(r2.entry, null)
})

test("Day 9-10 · PreviewStore · take 不存在 → reason=not_found", () => {
  const store = new PreviewStore()
  const r = store.take("never-existed")
  assert.equal(r.reason, "not_found")
  assert.equal(r.entry, null)
})

test("Day 9-10 · PreviewStore · take 过期 → reason=expired + 顺手删除", () => {
  const fixed = new Date("2026-05-21T10:00:00.000Z")
  const store = new PreviewStore({ clock: () => fixed })
  store.put(makeEntry("pv-expired", "2026-05-21T09:00:00.000Z")) // 1h ago
  assert.equal(store.size(), 1)
  const r = store.take("pv-expired")
  assert.equal(r.reason, "expired")
  assert.equal(r.entry, null)
  assert.equal(store.size(), 0, "expired entry take 后也被剔除")
})

test("Day 9-10 · PreviewStore · prune 清理过期 entries 返回数", () => {
  const fixed = new Date("2026-05-21T10:00:00.000Z")
  const store = new PreviewStore({ clock: () => fixed })
  store.put(makeEntry("active-1", "2030-01-01T00:00:00.000Z"))
  store.put(makeEntry("active-2", "2030-01-01T00:00:00.000Z"))
  store.put(makeEntry("expired-1", "2026-05-21T09:00:00.000Z"))
  store.put(makeEntry("expired-2", "2026-05-21T09:30:00.000Z"))
  assert.equal(store.size(), 4)
  const removed = store.prune()
  assert.equal(removed, 2)
  assert.equal(store.size(), 2, "active entries 保留")
})

test("Day 9-10 · PreviewStore · 重复 previewId put 覆盖", () => {
  const store = new PreviewStore()
  store.put(makeEntry("pv-dup", "2030-01-01T00:00:00.000Z", "first.md"))
  store.put(makeEntry("pv-dup", "2030-01-01T00:00:00.000Z", "second.md"))
  assert.equal(store.size(), 1)
  const r = store.take("pv-dup")
  assert.equal(r.entry?.sourcePath, "second.md")
})

test("Day 9-10 · PreviewStore · 边界：expiresAt == now → expired (≤ 比较)", () => {
  const fixed = new Date("2026-05-21T10:00:00.000Z")
  const store = new PreviewStore({ clock: () => fixed })
  store.put(makeEntry("pv-edge", "2026-05-21T10:00:00.000Z"))
  const r = store.take("pv-edge")
  assert.equal(r.reason, "expired", "expiresAt <= now 视为过期")
})

// ─── Week 2 r2 (范-r1 P3): peek / consume 拆分 ──────────────────────

test("r2 P3 · PreviewStore · peek 不删除 entry，可重复读", () => {
  const store = new PreviewStore()
  store.put(makeEntry("pv-peek", "2030-01-01T00:00:00.000Z"))
  const r1 = store.peek("pv-peek")
  assert.equal(r1.reason, "ok")
  assert.equal(store.size(), 1, "peek 不消费")
  const r2 = store.peek("pv-peek")
  assert.equal(r2.reason, "ok", "重复 peek 仍 ok")
  assert.equal(store.size(), 1)
})

test("r2 P3 · PreviewStore · consume 真删除返回 true / 重复 consume idempotent 返 false", () => {
  const store = new PreviewStore()
  store.put(makeEntry("pv-c", "2030-01-01T00:00:00.000Z"))
  assert.equal(store.consume("pv-c"), true)
  assert.equal(store.size(), 0)
  assert.equal(store.consume("pv-c"), false, "已被 consume 再 consume idempotent 返 false")
})

test("r2 P3 · PreviewStore · peek 过期顺手剔除 entry（防内存泄漏）", () => {
  const fixed = new Date("2026-05-21T10:00:00.000Z")
  const store = new PreviewStore({ clock: () => fixed })
  store.put(makeEntry("pv-expired", "2026-05-21T09:00:00.000Z"))
  const r = store.peek("pv-expired")
  assert.equal(r.reason, "expired")
  assert.equal(store.size(), 0, "过期 entry peek 时顺手剔除")
})

test("r2 P3 · PreviewStore · take 仍 backward compatible (peek + consume)", () => {
  const store = new PreviewStore()
  store.put(makeEntry("pv-t", "2030-01-01T00:00:00.000Z"))
  const r = store.take("pv-t")
  assert.equal(r.reason, "ok")
  assert.equal(store.size(), 0, "take 仍消费（DEPRECATED 但保留语义）")
})
