import assert from "node:assert/strict"
import test from "node:test"
import { resolveDecisionParams } from "./decision-callback-mapping"

const twoOptions = [
  { id: "a", label: "A" },
  { id: "b", label: "B" },
]

test("kind=select → multi_choice 单选", () => {
  const r = resolveDecisionParams({ kind: "select", options: twoOptions })
  assert.ok(r.ok)
  assert.equal(r.value.kind, "multi_choice")
  assert.equal(r.value.multiSelect, false)
  assert.deepEqual(r.value.options, twoOptions)
})

test("kind=multi_select → multi_choice 多选", () => {
  const r = resolveDecisionParams({ kind: "multi_select", options: twoOptions })
  assert.ok(r.ok)
  assert.equal(r.value.kind, "multi_choice")
  assert.equal(r.value.multiSelect, true)
})

test("kind=confirm 无 options → inline_confirmation + 默认确认/取消", () => {
  const r = resolveDecisionParams({ kind: "confirm" })
  assert.ok(r.ok)
  assert.equal(r.value.kind, "inline_confirmation")
  assert.equal(r.value.multiSelect, false)
  assert.deepEqual(
    r.value.options.map((o) => o.id),
    ["confirm", "cancel"],
  )
})

test("kind=confirm 自带 options 优先", () => {
  const r = resolveDecisionParams({ kind: "confirm", options: twoOptions })
  assert.ok(r.ok)
  assert.equal(r.value.kind, "inline_confirmation")
  assert.deepEqual(r.value.options, twoOptions)
})

test("legacy 不带 kind → multi_choice + multiSelect 透传（零回归）", () => {
  const single = resolveDecisionParams({ options: twoOptions })
  assert.ok(single.ok)
  assert.equal(single.value.kind, "multi_choice")
  assert.equal(single.value.multiSelect, false)

  const multi = resolveDecisionParams({ options: twoOptions, multiSelect: true })
  assert.ok(multi.ok)
  assert.equal(multi.value.multiSelect, true)
})

test("select/multi_select/legacy options <2 → error", () => {
  for (const kind of ["select", "multi_select", undefined]) {
    const r = resolveDecisionParams({ kind, options: [{ id: "a", label: "A" }] })
    assert.equal(r.ok, false, `kind=${kind} 单选项必须报错`)
    const empty = resolveDecisionParams({ kind })
    assert.equal(empty.ok, false, `kind=${kind} 无选项必须报错`)
  }
})

test("confirm 自带单 option → error（残缺确认卡 fail-closed）", () => {
  const r = resolveDecisionParams({ kind: "confirm", options: [{ id: "a", label: "A" }] })
  assert.equal(r.ok, false)
})

test("未知 kind → error（fail-closed，不静默当 select）", () => {
  const r = resolveDecisionParams({ kind: "bogus", options: twoOptions })
  assert.equal(r.ok, false)
})
