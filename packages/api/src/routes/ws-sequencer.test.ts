import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { GroupSequencer } from "./ws-sequencer"

describe("GroupSequencer (F031 · per-sessionGroup seq + 进程 epoch)", () => {
  it("next() 同组单调递增，从 1 开始", () => {
    const seq = new GroupSequencer()
    assert.equal(seq.next("g1"), 1)
    assert.equal(seq.next("g1"), 2)
    assert.equal(seq.next("g1"), 3)
  })

  it("不同组独立计数", () => {
    const seq = new GroupSequencer()
    seq.next("g1")
    seq.next("g1")
    assert.equal(seq.next("g2"), 1)
    assert.equal(seq.next("g1"), 3)
  })

  it("current() 只读不递增；未知组返回 0", () => {
    const seq = new GroupSequencer()
    assert.equal(seq.current("g1"), 0)
    seq.next("g1")
    assert.equal(seq.current("g1"), 1)
    assert.equal(seq.current("g1"), 1)
    assert.equal(seq.next("g1"), 2)
  })

  it("epoch 是稳定的 UUID（实例内不变，实例间不同）", () => {
    const a = new GroupSequencer()
    const b = new GroupSequencer()
    assert.match(a.epoch, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    assert.equal(a.epoch, a.epoch)
    assert.notEqual(a.epoch, b.epoch)
  })
})
