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
  DRIFT_DRAFT_REASON_PREFIX,
  DriftDetector,
  type DriftDetectionResult,
  type DriftTrigger,
  type DriftUpdateDraft,
  buildDriftAlert,
  buildUpdateDraft,
  driftDraftBasename,
  driftDraftReason,
  driftTriggerKey,
  parseDriftDraftReasonKey,
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

// ── 范-r1 P2-2: trigger 去重 ────────────────────────────────────────────

test("DriftDetector · 范-r1 P2-2: in-run 去重 — 同次 scan 重复 trigger 只开 1 draft", async () => {
  const triggers: DriftTrigger[] = [
    { kind: "new_lesson", ref: "LL-31", detail: "first" },
    { kind: "new_lesson", ref: "LL-31", detail: "dup same kind:ref" },
    { kind: "model_upgrade", ref: "LL-31", detail: "different kind same ref — 不算 dup" },
  ]
  const detector = new DriftDetector({ scanTriggers: async () => triggers })
  const result = await detector.run()
  assert.equal(result.draftsOpened.length, 2, "new_lesson:LL-31 去重 + model_upgrade:LL-31 保留")
  assert.equal(result.skippedDuplicate, 1)
})

test("DriftDetector · 范-r1 P2-2: 跨 run 去重 — processedTriggerKeys 注入跳过已处理", async () => {
  const triggers: DriftTrigger[] = [
    { kind: "new_lesson", ref: "LL-31", detail: "上周已开过 draft" },
    { kind: "new_lesson", ref: "LL-32", detail: "本周新增" },
  ]
  const opened: DriftUpdateDraft[] = []
  const detector = new DriftDetector({
    scanTriggers: async () => triggers,
    openUpdateDraft: async (d) => {
      opened.push(d)
    },
    // 上周已处理 new_lesson:LL-31
    processedTriggerKeys: new Set(["new_lesson:LL-31"]),
  })
  const result = await detector.run()
  assert.equal(result.draftsOpened.length, 1, "只 LL-32 新开 draft")
  assert.equal(result.skippedDuplicate, 1, "LL-31 已处理 skip")
  assert.equal(opened.length, 1)
  assert.match(opened[0].title, /LL-32/)
})

test("DriftDetector · 范-r1 P2-2: 无 processedTriggerKeys → 仅 in-run 去重", async () => {
  const detector = new DriftDetector({
    scanTriggers: async () => [{ kind: "new_lesson", ref: "LL-01", detail: "x" }],
  })
  const result = await detector.run()
  assert.equal(result.skippedDuplicate, 0)
  assert.equal(result.draftsOpened.length, 1)
})

// ── 收尾修1 · dedup helper（reason 精确编码 / 反解）────────────────────────
//
// 设计审 critique P1：basename `drift-<kind>-<ref>` 反解有歧义（kind 含 `_`、ref 含 `-`，
// naive split 切错 key → dedup 永 miss → 每周重开）。因此跨 run dedup 走 wiki_events.reason
// `drift:<kind>:<ref>` 精确编码 + slice-prefix 反解（永不重新 split），下面这组测试锁住互逆性。

test("修1 · driftDraftReason → drift:<key> 前缀编码", () => {
  const r = driftDraftReason({ kind: "new_lesson", ref: "LL-031", detail: "x" })
  assert.equal(r, "drift:new_lesson:LL-031")
  assert.ok(r.startsWith(DRIFT_DRAFT_REASON_PREFIX))
})

test("修1 · reason ↔ key 严格互逆（kind 含 `_` + ref 含 `-`，critique P1 的歧义点）", () => {
  // 三类 kind 全覆盖；ref 全部含 `-`（LL-031 / claude-opus-4-7 / handoff-abc-123）
  const triggers: DriftTrigger[] = [
    { kind: "new_lesson", ref: "LL-031", detail: "a" },
    { kind: "model_upgrade", ref: "claude-opus-4-7", detail: "b" },
    { kind: "handoff_failure", ref: "handoff-abc-123", detail: "c" },
  ]
  for (const t of triggers) {
    const key = driftTriggerKey(t)
    const reason = driftDraftReason(t)
    const parsed = parseDriftDraftReasonKey(reason)
    assert.equal(parsed, key, `${reason} 反解必须 === driftTriggerKey ${key}`)
  }
})

test("修1 · ref 含冒号也不破坏互逆（slice-prefix 不重新 split）", () => {
  const t: DriftTrigger = { kind: "model_upgrade", ref: "ns:sub:model", detail: "x" }
  assert.equal(parseDriftDraftReasonKey(driftDraftReason(t)), driftTriggerKey(t))
})

test("修1 · parseDriftDraftReasonKey: 非 drift / null / 空 key → null", () => {
  assert.equal(parseDriftDraftReasonKey("F027 普通 promote reason"), null)
  assert.equal(parseDriftDraftReasonKey(null), null)
  assert.equal(parseDriftDraftReasonKey(undefined), null)
  assert.equal(parseDriftDraftReasonKey("drift:"), null, "前缀但空 key → null（不污染 dedup 集合）")
})

test("修1 · driftDraftBasename: ref 清洗 [^a-zA-Z0-9_-]→_（防路径注入）+ 附 key hash", () => {
  // 德彪 r1 P1：清洗后附原始 key 的短 hash 保证单射。基名形如 drift-<kind>-<safeRef>-<8hex>。
  const b1 = driftDraftBasename({ kind: "handoff_failure", ref: "../../etc/passwd", detail: "x" })
  assert.match(b1, /^drift-handoff_failure-______etc_passwd-[0-9a-f]{8}$/)
  const b2 = driftDraftBasename({ kind: "new_lesson", ref: "LL-031", detail: "x" })
  assert.match(b2, /^drift-new_lesson-LL-031-[0-9a-f]{8}$/, "合法 ref 原样 + hash 后缀")
})

test("修1 · driftDraftBasename: 清洗碰撞的不同 trigger 仍得不同 basename（德彪 r1 P1）", () => {
  // a:b 与 a/b 清洗后都 →a_b，但原始 key 不同 → hash 不同 → 路径单射，不再永久 CAS 冲突。
  const colon = driftDraftBasename({ kind: "new_lesson", ref: "a:b", detail: "x" })
  const slash = driftDraftBasename({ kind: "new_lesson", ref: "a/b", detail: "x" })
  assert.notEqual(colon, slash, "碰撞 ref 必须落不同 basename")
  assert.ok(colon.startsWith("drift-new_lesson-a_b-"))
  assert.ok(slash.startsWith("drift-new_lesson-a_b-"))
})

// ── 收尾修1 · buildDriftAlert（独立 shape，不复用 ChainedAlert）─────────────

test("修1 · buildDriftAlert: 从 result 抽 draftsOpened/failed 计数 + 标题 + room", () => {
  const result: DriftDetectionResult = {
    scannedAt: "2026-06-14T02:00:00.000Z",
    triggers: [],
    draftsOpened: [
      buildUpdateDraft({ kind: "new_lesson", ref: "LL-040", detail: "x" }),
      buildUpdateDraft({ kind: "model_upgrade", ref: "claude-opus-4-8", detail: "y" }),
    ],
    failed: [{ trigger: { kind: "handoff_failure", ref: "ho-Z", detail: "z" }, error: "boom" }],
    skippedDuplicate: 0,
  }
  const alert = buildDriftAlert(result, "R-201")
  assert.equal(alert.scannedAt, "2026-06-14T02:00:00.000Z")
  assert.equal(alert.draftsOpened, 2)
  assert.equal(alert.failed, 1)
  assert.equal(alert.targetRoom, "R-201")
  assert.equal(alert.draftTitles.length, 2)
  assert.match(alert.draftTitles[0], /LL-040/)
})
