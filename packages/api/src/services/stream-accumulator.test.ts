import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { StreamAccumulator } from "./stream-accumulator"

describe("StreamAccumulator (F031 AC4 · offset = append 前快照)", () => {
  it("push 返回 append 前 offset 并累积内容", () => {
    const acc = new StreamAccumulator()
    assert.equal(acc.push("AB"), 0)
    assert.equal(acc.push("C"), 2)
    assert.equal(acc.push("DE"), 3)
    assert.equal(acc.current, "ABCDE")
  })

  it("空段 push 返回当前长度且内容不变", () => {
    const acc = new StreamAccumulator()
    acc.push("AB")
    assert.equal(acc.push(""), 2)
    assert.equal(acc.current, "AB")
  })

  it("set 重置后 offset 从新基准重启（retry 清零对齐语义）", () => {
    const acc = new StreamAccumulator()
    acc.push("bad content")
    acc.set("")
    assert.equal(acc.push("good"), 0)
    assert.equal(acc.current, "good")
  })

  it("set 到非空值后 push offset 接在其后（catch 路径 append 语义）", () => {
    const acc = new StreamAccumulator()
    acc.set("prefix")
    assert.equal(acc.push("-tail"), 6)
    assert.equal(acc.current, "prefix-tail")
  })
})
