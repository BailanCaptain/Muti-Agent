/**
 * F027 P19.15 · WikiCompilerDebounce 测试 — AC-P2-17
 *
 * ⚙️ 确定性重写（fix/docs-watcher-fake-timer）：旧实现用真 setTimeout 防抖 + 真 sleep 等待，
 *   满负载下 timer 被饿死、断言抖动。现改用 node:test mock.timers 推进防抖、微任务 flush 处理
 *   async recompile → 零 wall-clock 依赖、确定性、负载免疫。零生产代码改动。
 *
 * 覆盖：
 *   - 单 event → debounce 后 recompile fire 1 次
 *   - burst（debounce 内多次 onWikiEvent）→ 收敛成 1 次 recompile
 *   - event 间隔 > debounce → 多次 recompile
 *   - flush() 立即触发
 *   - reentrancy：recompile 进行中来 event → 本轮后补跑 1 次
 *   - 范-r2 P3-2：recompile 进行中 stop() → 完成后不补跑
 *   - recompile throw → 不打断（后续 event 仍能触发）
 *   - stop() 后 onWikiEvent noop / 清 pending timer
 *   - 默认 debounceMs = 5000
 */

import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { WikiCompilerDebounce } from "./wiki-compiler-debounce"

/** 让 fire() 的 async recompile 链（`void this.fire()` → await recompile）跑完。 */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

test("WikiCompilerDebounce · AC-P2-17: 单 event → debounce 后 recompile 1 次", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let count = 0
  const d = new WikiCompilerDebounce({
    recompileDerivedViews: async () => {
      count += 1
    },
    debounceMs: 40,
  })
  d.onWikiEvent()
  assert.equal(count, 0, "debounce 内还没 fire")
  t.mock.timers.tick(40)
  await flushMicrotasks()
  assert.equal(count, 1, "debounce 后 recompile 1 次")
  d.stop()
})

test("WikiCompilerDebounce · AC-P2-17: burst 收敛 — debounce 内 5 次 onWikiEvent → 1 次 recompile", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let count = 0
  const d = new WikiCompilerDebounce({
    recompileDerivedViews: async () => {
      count += 1
    },
    debounceMs: 60,
  })
  // 5 次快速 onWikiEvent，每次间隔 15ms（< 60ms 持续重置防抖）
  for (let i = 0; i < 5; i++) {
    d.onWikiEvent()
    t.mock.timers.tick(15)
  }
  assert.equal(count, 0, "burst 期间防抖一直被重置，未 fire")
  t.mock.timers.tick(60) // 等最后一次防抖完成
  await flushMicrotasks()
  assert.equal(count, 1, `burst 应收敛成 1 次, 实际 ${count}`)
  d.stop()
})

test("WikiCompilerDebounce · event 间隔 > debounce → 多次 recompile", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let count = 0
  const d = new WikiCompilerDebounce({
    recompileDerivedViews: async () => {
      count += 1
    },
    debounceMs: 40,
  })
  d.onWikiEvent()
  t.mock.timers.tick(40)
  await flushMicrotasks() // 1st recompile
  assert.equal(count, 1)
  d.onWikiEvent()
  t.mock.timers.tick(40)
  await flushMicrotasks() // 2nd recompile
  assert.equal(count, 2, "两次独立 event 应 2 次 recompile")
  d.stop()
})

test("WikiCompilerDebounce · flush() 立即触发待跑 recompile", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let count = 0
  const d = new WikiCompilerDebounce({
    recompileDerivedViews: async () => {
      count += 1
    },
    debounceMs: 9999, // 长 debounce — 正常不会自己 fire
  })
  d.onWikiEvent()
  assert.equal(count, 0)
  await d.flush() // 立即跑（清 timer + 直接 fire）
  assert.equal(count, 1, "flush 立即触发")
  d.stop()
})

test("WikiCompilerDebounce · reentrancy: recompile 进行中来 event → 本轮后补跑", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
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
  await flushMicrotasks()
  assert.equal(d.isRunning(), true, "第一次 recompile 进行中")

  // 进行中来新 event + flush → 应标记 pending，不并发跑
  d.onWikiEvent()
  const flush2 = d.flush()
  await flushMicrotasks()
  assert.equal(count, 1, "reentrancy 期间不并发，仍只跑了第一次")

  // 释放第一次 → 本轮完后应补跑一次
  releaseFirst()
  await flush1
  await flush2
  await flushMicrotasks()
  assert.equal(count, 2, "第一轮完成后补跑 1 次（收敛 reentrancy 期间所有 event）")
  d.stop()
})

test("WikiCompilerDebounce · 范-r2 P3-2: recompile 进行中 stop() → 完成后不补跑", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
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
  await flushMicrotasks()
  assert.equal(d.isRunning(), true, "第一次 recompile 进行中")
  const flush2 = d.flush() // 进行中再 flush → 标记 pendingAfterRun
  await flushMicrotasks()
  d.stop() // stop 应清 pendingAfterRun
  releaseFirst()
  await flush1
  await flush2
  await flushMicrotasks()
  assert.equal(count, 1, "stop 后本轮完成不补跑（pendingAfterRun 被清）")
})

test("WikiCompilerDebounce · recompile throw → 不打断后续 event", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let count = 0
  const d = new WikiCompilerDebounce({
    recompileDerivedViews: async () => {
      count += 1
      throw new Error("compile failed")
    },
    debounceMs: 40,
  })
  d.onWikiEvent()
  t.mock.timers.tick(40)
  await flushMicrotasks()
  assert.equal(count, 1)
  // 第一次 throw 后，第二次 event 仍能触发
  d.onWikiEvent()
  t.mock.timers.tick(40)
  await flushMicrotasks()
  assert.equal(count, 2, "throw 不打断后续 recompile")
  d.stop()
})

test("WikiCompilerDebounce · stop() 后 onWikiEvent noop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let count = 0
  const d = new WikiCompilerDebounce({
    recompileDerivedViews: async () => {
      count += 1
    },
    debounceMs: 40,
  })
  d.stop()
  d.onWikiEvent() // stop 后应 noop
  t.mock.timers.tick(120)
  await flushMicrotasks()
  assert.equal(count, 0, "stop 后 onWikiEvent 不触发 recompile")
})

test("WikiCompilerDebounce · stop() 清 pending debounce timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let count = 0
  const d = new WikiCompilerDebounce({
    recompileDerivedViews: async () => {
      count += 1
    },
    debounceMs: 60,
  })
  d.onWikiEvent() // 启 debounce
  d.stop() // 应清掉 pending timer
  t.mock.timers.tick(150)
  await flushMicrotasks()
  assert.equal(count, 0, "stop 清掉了 pending debounce → 不 fire")
})

test("WikiCompilerDebounce · 默认 debounceMs = 5000", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let count = 0
  const d = new WikiCompilerDebounce({
    recompileDerivedViews: async () => {
      count += 1
    },
    // debounceMs 不传 → 默认 5000
  })
  d.onWikiEvent()
  t.mock.timers.tick(120) // 远 < 5000
  await flushMicrotasks()
  assert.equal(count, 0, "默认 5s debounce — 120ms 还没 fire")
  // 推到 5000 应 fire（验证默认值确实是 5000）
  t.mock.timers.tick(4880)
  await flushMicrotasks()
  assert.equal(count, 1, "推满 5000ms 后 fire")
  d.stop()
})
