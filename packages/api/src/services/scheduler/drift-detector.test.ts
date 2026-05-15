/**
 * F027 P19.11 · DriftDetector 测试 — AC-P2-13
 *
 * 覆盖：
 *   - 3 类 trigger fixture（new_lesson / model_upgrade / handoff_failure）
 *     → 各开对应 update draft
 *   - buildUpdateDraft: targetArea / title / body 按 kind 正确
 *   - openUpdateDraft 回调被调 + throw → 落 failed 不打断
 *   - dry-run（无 opener）→ draftsOpened 仍记录
 *   - 空 trigger → 空 result
 */

import assert from "node:assert/strict"
import test from "node:test"
import {
  DriftDetector,
  type DriftTrigger,
  type DriftUpdateDraft,
  buildUpdateDraft,
} from "./drift-detector"

// ── buildUpdateDraft 3 kind ─────────────────────────────────────────────

test("DriftDetector · buildUpdateDraft new_lesson → agent top_risks", () => {
  const draft = buildUpdateDraft({
    kind: "new_lesson",
    ref: "LL-031",
    detail: "新增 LL-031 关于 flake 测试",
  })
  assert.equal(draft.targetArea, "agent top_risks")
  assert.match(draft.title, /LL-031/)
  assert.match(draft.body, /top_risks/)
  assert.match(draft.body, /LL-031/)
})

test("DriftDetector · buildUpdateDraft model_upgrade → capability_digest", () => {
  const draft = buildUpdateDraft({
    kind: "model_upgrade",
    ref: "claude-opus-4-7",
    detail: "Opus 4.6 → 4.7",
  })
  assert.equal(draft.targetArea, "capability_digest")
  assert.match(draft.title, /claude-opus-4-7/)
  assert.match(draft.body, /capability_digest/)
})

test("DriftDetector · buildUpdateDraft handoff_failure → handoff retrospect", () => {
  const draft = buildUpdateDraft({
    kind: "handoff_failure",
    ref: "handoff-abc123",
    detail: "范→桂 handoff 上下文丢失",
  })
  assert.equal(draft.targetArea, "handoff retrospect")
  assert.match(draft.title, /handoff-abc123/)
  assert.match(draft.body, /retrospect/)
})

// ── AC-P2-13: 3 类 trigger → 3 draft ───────────────────────────────────

test("DriftDetector · AC-P2-13: 3 类 trigger fixture → 各开对应 update draft", async () => {
  const triggers: DriftTrigger[] = [
    { kind: "new_lesson", ref: "LL-031", detail: "新 lesson" },
    { kind: "model_upgrade", ref: "claude-opus-4-7", detail: "模型升级" },
    { kind: "handoff_failure", ref: "handoff-xyz", detail: "handoff 失败" },
  ]
  const opened: DriftUpdateDraft[] = []
  const detector = new DriftDetector({
    scanTriggers: async () => triggers,
    openUpdateDraft: async (d) => {
      opened.push(d)
    },
  })
  const result = await detector.run()

  assert.equal(result.triggers.length, 3)
  assert.equal(result.draftsOpened.length, 3)
  assert.equal(result.failed.length, 0)
  assert.equal(opened.length, 3)
  assert.deepEqual(
    opened.map((d) => d.targetArea).sort(),
    ["agent top_risks", "capability_digest", "handoff retrospect"],
  )
})

test("DriftDetector · 空 trigger → 空 result", async () => {
  const detector = new DriftDetector({ scanTriggers: async () => [] })
  const result = await detector.run()
  assert.equal(result.triggers.length, 0)
  assert.equal(result.draftsOpened.length, 0)
  assert.equal(result.failed.length, 0)
  assert.match(result.scannedAt, /^\d{4}-\d{2}-\d{2}T/)
})

// ── openUpdateDraft 回调 ───────────────────────────────────────────────

test("DriftDetector · dry-run（无 openUpdateDraft）→ draftsOpened 仍记录", async () => {
  const detector = new DriftDetector({
    scanTriggers: async () => [{ kind: "new_lesson", ref: "LL-01", detail: "x" }],
  })
  const result = await detector.run()
  assert.equal(result.draftsOpened.length, 1, "dry-run 仍记录应开的 draft")
})

test("DriftDetector · openUpdateDraft throw → 落 failed，不打断其他 trigger", async () => {
  const triggers: DriftTrigger[] = [
    { kind: "new_lesson", ref: "LL-A", detail: "a" },
    { kind: "model_upgrade", ref: "model-B", detail: "b" },
    { kind: "handoff_failure", ref: "ho-C", detail: "c" },
  ]
  const detector = new DriftDetector({
    scanTriggers: async () => triggers,
    openUpdateDraft: async (d) => {
      if (d.trigger.ref === "model-B") throw new Error("draft store 写失败")
    },
  })
  const result = await detector.run()
  assert.equal(result.draftsOpened.length, 2, "A + C 成功开")
  assert.equal(result.failed.length, 1, "B 失败")
  assert.equal(result.failed[0].trigger.ref, "model-B")
  assert.match(result.failed[0].error, /写失败/)
})

test("DriftDetector · clock 注入反映在 scannedAt", async () => {
  const fixed = new Date("2026-05-18T10:00:00.000Z")
  const detector = new DriftDetector({
    scanTriggers: async () => [],
    clock: () => fixed,
  })
  const result = await detector.run()
  assert.equal(result.scannedAt, "2026-05-18T10:00:00.000Z")
})

test("DriftDetector · 同类多 trigger → 各自独立 draft", async () => {
  const triggers: DriftTrigger[] = [
    { kind: "new_lesson", ref: "LL-01", detail: "lesson 1" },
    { kind: "new_lesson", ref: "LL-02", detail: "lesson 2" },
  ]
  const detector = new DriftDetector({ scanTriggers: async () => triggers })
  const result = await detector.run()
  assert.equal(result.draftsOpened.length, 2)
  assert.notEqual(result.draftsOpened[0].title, result.draftsOpened[1].title)
})
