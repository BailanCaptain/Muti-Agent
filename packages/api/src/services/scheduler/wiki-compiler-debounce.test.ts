/**
 * F027 P19.15 · WikiCompilerDebounce 测试 — AC-P2-17
 *
 * 覆盖：
 *   - 单 event → debounce 后 recompile fire 1 次
 *   - burst（debounce 内多次 onWikiEvent）→ 收敛成 1 次 recompile
 *   - event 间隔 > debounce → 多次 recompile
 *   - flush() 立即触发
 *   - reentrancy：recompile 进行中来 event → 本轮后补跑 1 次
 *   - recompile throw → 不打断（后续 event 仍能触发）
 *   - stop() 后 onWikiEvent noop
 *
 * 测试用极短 debounceMs（40ms）压缩耗时。
 */

import assert from "node:assert/strict"
import test from "node:test"
import { WikiCompilerDebounce } from "./wiki-compiler-debounce"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("WikiCompilerDebounce · AC-P2-17: 单 event → debounce 后 recompile 1 次", async () => {
  let count = 0
  const d = new WikiCompilerDebounce({
    recompileDerivedViews: async () => {
      count += 1
    },
    debounceMs: 40,
  })
  d.onWikiEvent()
  assert.equal(count, 0, "debounce 内还没 fire")
  await sleep(120)
  assert.equal(count, 1, "debounce 后 recompile 1 次")
  d.stop()
})

test("WikiCompilerDebounce · AC-P2-17: burst 收敛 — debounce 内 5 次 onWikiEvent → 1 次 recompile", async () => {
  let count = 0
  const d = new WikiCompilerDebounce({
    recompileDerivedViews: async () => {
      count += 1
    },
    debounceMs: 60,
  })
  // 5 次快速 onWikiEvent（每次重置 debounce）
  for (let i = 0; i < 5; i++) {
    d.onWikiEvent()
    await sleep(15) // < debounceMs，持续重置
  }
  await sleep(150) // 等最后一次 debounce 完成
  assert.equal(count, 1, `burst 应收敛成 1 次, 实际 ${count}`)
  d.stop()
})

test("WikiCompilerDebounce · event 间隔 > debounce → 多次 recompile", async () => {
  let count = 0
  const d = new WikiCompilerDebounce({
    recompileDerivedViews: async () => {
      count += 1
    },
    debounceMs: 40,
  })
  d.onWikiEvent()
  await sleep(120) // 1st recompile
  d.onWikiEvent()
  await sleep(120) // 2nd recompile
  assert.equal(count, 2, "两次独立 event 应 2 次 recompile")
  d.stop()
})

test("WikiCompilerDebounce · flush() 立即触发待跑 recompile", async () => {
  let count = 0
  const d = new WikiCompilerDebounce({
    recompileDerivedViews: async () => {
      count += 1
    },
    debounceMs: 9999, // 长 debounce — 正常不会自己 fire
  })
  d.onWikiEvent()
  assert.equal(count, 0)
  await d.flush() // 立即跑
  assert.equal(count, 1, "flush 立即触发")
  d.stop()
})

test("WikiCompilerDebounce · reentrancy: recompile 进行中来 event → 本轮后补跑", async () => {
  let count = 0
  let releaseFirst!: () => void
  const firstRecompile = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const d = new WikiCompilerDebounce({
    recompileDerivedViews: async () => {
      count += 1
      if (count === 1) await firstRecompile // 第一次卡住
    },
    debounceMs: 9999,
  })

  // 触发第一次 recompile（卡住）
  const flush1 = d.flush()
  await sleep(20)
  assert.equal(d.isRunning(), true, "第一次 recompile 进行中")

  // 进行中来新 event + flush → 应标记 pending，不并发跑
  d.onWikiEvent()
  const flush2 = d.flush()
  await sleep(20)
  assert.equal(count, 1, "reentrancy 期间不并发，仍只跑了第一次")

  // 释放第一次 → 本轮完后应补跑一次
  releaseFirst()
  await flush1
  await flush2
  await sleep(20)
  assert.equal(count, 2, "第一轮完成后补跑 1 次（收敛 reentrancy 期间所有 event）")
  d.stop()
})

test("WikiCompilerDebounce · 范-r2 P3-2: recompile 进行中 stop() → 完成后不补跑", async () => {
  let count = 0
  let releaseFirst!: () => void
  const firstRecompile = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const d = new WikiCompilerDebounce({
    recompileDerivedViews: async () => {
      count += 1
      if (count === 1) await firstRecompile // 第一次卡住
    },
    debounceMs: 9999,
  })
  const flush1 = d.flush() // 触发第一次 recompile（卡住）
  await sleep(20)
  assert.equal(d.isRunning(), true, "第一次 recompile 进行中")
  const flush2 = d.flush() // 进行中再 flush → 标记 pendingAfterRun
  await sleep(20)
  d.stop() // stop 应清 pendingAfterRun
  releaseFirst()
  await flush1
  await flush2
  await sleep(40)
  assert.equal(count, 1, "stop 后本轮完成不补跑（pendingAfterRun 被清）")
})

test("WikiCompilerDebounce · recompile throw → 不打断后续 event", async () => {
  let count = 0
  const d = new WikiCompilerDebounce({
    recompileDerivedViews: async () => {
      count += 1
      throw new Error("compile failed")
    },
    debounceMs: 40,
  })
  d.onWikiEvent()
  await sleep(120)
  assert.equal(count, 1)
  // 第一次 throw 后，第二次 event 仍能触发
  d.onWikiEvent()
  await sleep(120)
  assert.equal(count, 2, "throw 不打断后续 recompile")
  d.stop()
})

test("WikiCompilerDebounce · stop() 后 onWikiEvent noop", async () => {
  let count = 0
  const d = new WikiCompilerDebounce({
    recompileDerivedViews: async () => {
      count += 1
    },
    debounceMs: 40,
  })
  d.stop()
  d.onWikiEvent() // stop 后应 noop
  await sleep(120)
  assert.equal(count, 0, "stop 后 onWikiEvent 不触发 recompile")
})

test("WikiCompilerDebounce · stop() 清 pending debounce timer", async () => {
  let count = 0
  const d = new WikiCompilerDebounce({
    recompileDerivedViews: async () => {
      count += 1
    },
    debounceMs: 60,
  })
  d.onWikiEvent() // 启 debounce
  d.stop() // 应清掉 pending timer
  await sleep(150)
  assert.equal(count, 0, "stop 清掉了 pending debounce → 不 fire")
})

test("WikiCompilerDebounce · 默认 debounceMs = 5000", async () => {
  let count = 0
  const d = new WikiCompilerDebounce({
    recompileDerivedViews: async () => {
      count += 1
    },
    // debounceMs 不传 → 默认 5000
  })
  d.onWikiEvent()
  await sleep(120) // 远 < 5000
  assert.equal(count, 0, "默认 5s debounce — 120ms 还没 fire")
  d.stop()
})
