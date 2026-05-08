import assert from "node:assert/strict"
import test from "node:test"
import { inferOnBehalfOf } from "./mention-router"

// F026 ADR-003 · on-behalf 语义反推
//   "帮/代/替/为 X + @B"  → on_behalf_of = X, convener_id = X (豁免严格分级)
//   "@B +（仅 X 参考）"    → on_behalf_of = X, convener_id 保持默认（观众视角）
//   无信号                 → null
//   冲突（多主语）         → null（fail-closed）

test("on-behalf: 『帮小孙 review』→ on_behalf_of=小孙, convener=小孙", () => {
  const r = inferOnBehalfOf("@范德彪 帮小孙 review PR", { atIndex: 0, aliasEnd: 4 })
  assert.equal(r.onBehalfOf, "小孙")
  assert.equal(r.convenerTransfer, true)
})

test("on-behalf: 『代我问一下』→ on_behalf_of='self', convener_transfer=true", () => {
  const r = inferOnBehalfOf("@桂芬 代我问一下老板", { atIndex: 0, aliasEnd: 3 })
  assert.equal(r.onBehalfOf, "self")
  assert.equal(r.convenerTransfer, true)
})

test("on-behalf: 『替小孙 check』→ on_behalf_of=小孙", () => {
  const r = inferOnBehalfOf("@黄仁勋 替小孙 check 这个设计", { atIndex: 0, aliasEnd: 4 })
  assert.equal(r.onBehalfOf, "小孙")
  assert.equal(r.convenerTransfer, true)
})

test("on-behalf: 『为小孙跑一下』→ on_behalf_of=小孙", () => {
  const r = inferOnBehalfOf("@范德彪 为小孙跑一下 benchmark", { atIndex: 0, aliasEnd: 4 })
  assert.equal(r.onBehalfOf, "小孙")
  assert.equal(r.convenerTransfer, true)
})

test("on-behalf: 『@B（仅 X 参考）』→ on_behalf_of=X, 但 convener 不转移（观众视角）", () => {
  const r = inferOnBehalfOf("@范德彪（仅小孙参考）我说的意思是……", { atIndex: 0, aliasEnd: 4 })
  assert.equal(r.onBehalfOf, "小孙")
  assert.equal(r.convenerTransfer, false, "观众视角不转移收敛权")
})

test("on-behalf: 无信号 → null + 默认严格分级", () => {
  const r = inferOnBehalfOf("@范德彪 帮我 review PR", { atIndex: 0, aliasEnd: 4 })
  assert.equal(r.onBehalfOf, "self", "『帮我』识别 self 代表 issuer")
  assert.equal(r.convenerTransfer, true)
})

test("on-behalf: 无 on-behalf 信号 → null", () => {
  const r = inferOnBehalfOf("@范德彪 看下这个 PR", { atIndex: 0, aliasEnd: 4 })
  assert.equal(r.onBehalfOf, null)
  assert.equal(r.convenerTransfer, false)
})

test("on-behalf: 冲突（多主语）→ fail-closed null", () => {
  const r = inferOnBehalfOf("@范德彪 帮小孙和老板一起 review", { atIndex: 0, aliasEnd: 4 })
  assert.equal(r.onBehalfOf, null, "冲突信号 fail-closed")
  assert.equal(r.convenerTransfer, false)
})

test("on-behalf: 『给 X 看』→ 观众视角 on_behalf_of=X, convener 不转移", () => {
  const r = inferOnBehalfOf("@黄仁勋 给小孙看下这个方案", { atIndex: 0, aliasEnd: 4 })
  assert.equal(r.onBehalfOf, "小孙")
  assert.equal(r.convenerTransfer, false, "『给 X 看』= 给观众，不转移收敛权")
})
