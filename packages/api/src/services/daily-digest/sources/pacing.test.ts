import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { forEachPaced, resolvePacing } from "./pacing"

/** 限速专项：注入时钟/睡眠，验证 delay 语义与预算/abort 的不空等纪律 */
const DEFAULTS = { delayMs: 1, jitterMs: 1, maxTotalMs: 1 }

function fakePacing(opts: { delayMs: number; maxTotalMs: number }) {
  let t = 0
  const sleeps: number[] = []
  const pacing = resolvePacing(
    {
      delayMs: opts.delayMs,
      jitterMs: 0,
      maxTotalMs: opts.maxTotalMs,
      sleep: async (ms) => {
        sleeps.push(ms)
        t += ms
      },
      random: () => 0,
      clock: () => t,
    },
    DEFAULTS,
  )
  return {
    pacing,
    sleeps,
    tick: (ms: number) => {
      t += ms
    },
  }
}

describe("forEachPaced（B 项限速骨架专项）", () => {
  it("条目间隔 delay；末位不空等", async () => {
    const { pacing, sleeps, tick } = fakePacing({ delayMs: 100, maxTotalMs: 10_000 })
    const seen: string[] = []
    await forEachPaced(["a", "b", "c"], pacing, undefined, async (x) => {
      seen.push(x)
      tick(10)
    })
    assert.deepEqual(seen, ["a", "b", "c"])
    assert.deepEqual(sleeps, [100, 100])
  })

  it("fetch 后预算已尽 → 不再空等一拍（德彪 batchA-r1 P2）", async () => {
    const { pacing, sleeps, tick } = fakePacing({ delayMs: 100, maxTotalMs: 50 })
    const seen: string[] = []
    await forEachPaced(["a", "b"], pacing, undefined, async (x) => {
      seen.push(x)
      tick(60) // 第一跳就吃穿预算
    })
    assert.deepEqual(seen, ["a"])
    assert.equal(sleeps.length, 0, "预算已尽还睡 = 白等一拍")
  })

  it("fetch 中 abort → 不睡不抓下一个", async () => {
    const { pacing, sleeps } = fakePacing({ delayMs: 100, maxTotalMs: 10_000 })
    const ac = new AbortController()
    const seen: string[] = []
    await forEachPaced(["a", "b"], pacing, ac.signal, async (x) => {
      seen.push(x)
      ac.abort()
    })
    assert.deepEqual(seen, ["a"])
    assert.equal(sleeps.length, 0)
  })
})
