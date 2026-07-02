/**
 * F027 P19.7 · DocsWatcher 测试 — AC-P2-7
 *
 * ⚙️ 确定性重写（fix/docs-watcher-fake-timer）：
 *   旧实现用真 chokidar + 真 fs + 真 timer，满负载（多 worktree 并发跑全套件 + agent-sessions
 *   107s 归档压测）下 chokidar 事件被 IO 饿死，waitFor 150s 都等不到 → flaky 拦 husky。
 *   现改为注入 fake watch source 直驱合成 add/change/unlink + node:test mock.timers 驱动 60s
 *   防抖 → **零 wall-clock 依赖、确定性、负载免疫**，毫秒级跑完。
 *
 * 覆盖 DocsWatcher 自有逻辑（chokidar 委托的行为改为「接线断言」，不再真跑 fs 重测 chokidar）：
 *   - start/stop idempotent + isRunning + factory 只调一次 + close 调用
 *   - add → 60s 防抖后 onEvent fire 1 次
 *   - 同 path 防抖窗口内再写 → 重置计时 + 收敛成 1 次
 *   - 间隔 > 防抖 → fire 2 次
 *   - kind 收敛：add 后接 change → finalKind='add'
 *   - unlink 立即 fire（无防抖）+ cancel 同 path pending add/change
 *   - relativePath：取最长匹配 watchPath 前缀
 *   - onEvent throw 被吞 + watcher 继续
 *   - 接线断言：factory 收到 DEFAULT_IGNORED + 自定义 ignored + ignoreInitial + awaitWriteFinish
 *   - pollInterval clamp [10,100]（范-r1 P3）
 *   - [integration] 真 chokidar+真 fs smoke（默认 skip；DOCS_WATCHER_FS_IT=1 按需跑）
 *
 * 注：ignored 过滤 / ignoreInitial 是 chokidar 的行为（上游已测），本层只验「DocsWatcher 把正确
 *     的 options 传给了 chokidar」（接线），真 chokidar 行为由 opt-in 集成 smoke 兜底。
 */

import assert from "node:assert/strict"
import path from "node:path"
import test, { type TestContext } from "node:test"
import {
  type DocsEvent,
  DocsWatcher,
  type FileWatchSource,
  type WatchSourceOptions,
} from "./docs-watcher"

// fake watch source 用的固定 abs 根（永不落盘 —— fake 不碰真 fs）
const FAKE_ROOT = path.resolve("fake-docs-watcher-root")
const WATCH_PATH = path.join(FAKE_ROOT, "features")

/** 让 dispatch 的 `Promise.resolve().then(onEvent)` 微任务跑完（mock.timers 不影响微任务队列）。 */
async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/**
 * Fake 文件监听源：实现 DocsWatcher 依赖的最小事件面，暴露 emitX() 让测试同步驱动合成事件。
 * `once("ready")` 同步 fire（fake 即时 ready）→ DocsWatcher.start() 的 ready 等待立即 resolve。
 */
class FakeWatchSource implements FileWatchSource {
  readonly paths: string[]
  readonly options: WatchSourceOptions
  closed = false
  private readonly handlers = new Map<string, Array<(arg: never) => void>>()

  constructor(paths: string[], options: WatchSourceOptions) {
    this.paths = paths
    this.options = options
  }

  on(event: "add" | "change" | "unlink", handler: (filePath: string) => void): this
  on(event: "error", handler: (err: unknown) => void): this
  on(event: string, handler: (arg: never) => void): this {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return this
  }

  once(event: "ready", handler: () => void): this {
    if (event === "ready") handler() // fake 即时 ready
    return this
  }

  async close(): Promise<void> {
    this.closed = true
  }

  // ── 测试驱动器（同步 fire 注册的 handler）──
  private fire(event: string, arg: unknown): void {
    for (const h of this.handlers.get(event) ?? []) (h as (a: unknown) => void)(arg)
  }
  emitAdd(p: string): void {
    this.fire("add", p)
  }
  emitChange(p: string): void {
    this.fire("change", p)
  }
  emitUnlink(p: string): void {
    this.fire("unlink", p)
  }
  emitError(e: unknown): void {
    this.fire("error", e)
  }
}

interface FakeHarness {
  watcher: DocsWatcher
  fake: FakeWatchSource
  events: DocsEvent[]
  factoryCalls: () => number
  capturedOptions: () => WatchSourceOptions | undefined
}

/**
 * 起一个注入 fake source 的 DocsWatcher，并启用 mock.timers（拦 setTimeout/clearTimeout）。
 * 调用方用 t.mock.timers.tick(ms) 推进 60s 防抖；mock.timers 在测试结束自动还原。
 */
async function buildFake(
  t: TestContext,
  opts: {
    debounceMs?: number
    stabilityMs?: number
    ignored?: (string | RegExp)[]
    /** 是否启用 mock.timers（默认 true）；纯查 options 接线的测试传 false 避免重复 enable。 */
    mockTimers?: boolean
  } = {},
): Promise<FakeHarness> {
  if (opts.mockTimers !== false) t.mock.timers.enable({ apis: ["setTimeout"] })
  const events: DocsEvent[] = []
  let fake: FakeWatchSource | undefined
  let calls = 0
  let captured: WatchSourceOptions | undefined
  const watcher = new DocsWatcher({
    watchPaths: [WATCH_PATH],
    debounceMs: opts.debounceMs ?? 60_000,
    stabilityMs: opts.stabilityMs ?? 1500,
    ignored: opts.ignored,
    onEvent: (e) => {
      events.push(e)
    },
    watchSourceFactory: (paths, options) => {
      calls += 1
      captured = options
      fake = new FakeWatchSource(paths, options)
      return fake
    },
  })
  await watcher.start()
  if (!fake) throw new Error("factory 未被调用 —— start() 没经过 watchSourceFactory")
  return {
    watcher,
    fake,
    events,
    factoryCalls: () => calls,
    capturedOptions: () => captured,
  }
}

const inWatch = (rel: string) => path.join(WATCH_PATH, rel)

// ── 基础 lifecycle ────────────────────────────────────────────────────

test("DocsWatcher · start/stop idempotent + isRunning + factory 只调一次 + close", async (t) => {
  const h = await buildFake(t)
  assert.equal(h.watcher.isRunning(), true)
  await h.watcher.start() // 第二次 start → noop（不应再调 factory）
  assert.equal(h.watcher.isRunning(), true)
  assert.equal(h.factoryCalls(), 1, "start idempotent：factory 只调一次")
  await h.watcher.stop()
  assert.equal(h.watcher.isRunning(), false)
  assert.equal(h.fake.closed, true, "stop 应 close 底层 source")
  await h.watcher.stop() // 第二次 stop → noop
  assert.equal(h.watcher.isRunning(), false)
})

// ── 防抖 fire ──────────────────────────────────────────────────────────

test("DocsWatcher · add → 60s 防抖后 onEvent fire 1 次", async (t) => {
  const h = await buildFake(t, { debounceMs: 60_000 })
  const f = inWatch("F999-test.md")
  h.fake.emitAdd(f)
  assert.equal(h.events.length, 0, "防抖窗口内还没 fire")
  t.mock.timers.tick(59_999)
  await flushMicrotasks()
  assert.equal(h.events.length, 0, "差 1ms 不 fire")
  t.mock.timers.tick(1)
  await flushMicrotasks()
  assert.equal(h.events.length, 1, "60s 后 fire 1 次")
  assert.equal(h.events[0].kind, "add")
  assert.equal(h.events[0].absolutePath, path.resolve(f))
  assert.equal(h.events[0].relativePath, "F999-test.md")
  await h.watcher.stop()
})

test("DocsWatcher · 同 path 防抖窗口内再写 → 重置计时 + 收敛成 1 次（kind 保 add）", async (t) => {
  const h = await buildFake(t, { debounceMs: 60_000 })
  const f = inWatch("rapid.md")
  h.fake.emitAdd(f)
  t.mock.timers.tick(30_000) // 半程
  assert.equal(h.events.length, 0)
  h.fake.emitChange(f) // 重置防抖 + add 后接 change
  t.mock.timers.tick(30_000) // 距重置仅 30s，不 fire
  await flushMicrotasks()
  assert.equal(h.events.length, 0, "再写后计时被重置，30s 不 fire")
  t.mock.timers.tick(30_000) // 距重置满 60s
  await flushMicrotasks()
  assert.equal(h.events.length, 1, "收敛成 1 次")
  assert.equal(h.events[0].kind, "add", "add 后接 change → finalKind 保留 add")
  await h.watcher.stop()
})

test("DocsWatcher · 间隔 > 防抖 → fire 2 次", async (t) => {
  const h = await buildFake(t, { debounceMs: 60_000 })
  const f = inWatch("spaced.md")
  h.fake.emitAdd(f)
  t.mock.timers.tick(60_000)
  await flushMicrotasks()
  assert.equal(h.events.length, 1)
  h.fake.emitChange(f)
  t.mock.timers.tick(60_000)
  await flushMicrotasks()
  assert.equal(h.events.length, 2, "两次独立写应 fire 2 次")
  assert.equal(h.events[1].kind, "change", "第二次独立 change（pending 已清）→ change")
  await h.watcher.stop()
})

// ── unlink 即时 fire + cancel pending ──────────────────────────────────

test("DocsWatcher · unlink 立即 fire（无防抖）+ cancel 同 path pending add/change", async (t) => {
  const h = await buildFake(t, { debounceMs: 60_000 })
  // 场景 1：pending add 被 unlink cancel
  const f1 = inWatch("ephemeral.md")
  h.fake.emitAdd(f1) // 进 pending（防抖未到）
  h.fake.emitUnlink(f1) // 立即 fire + cancel pending add
  await flushMicrotasks()
  assert.equal(h.events.length, 1, "unlink 立即 fire 1 次")
  assert.equal(h.events[0].kind, "unlink")
  // 场景 2：pending change 被 unlink cancel（范-r1 P3-2：补 change 覆盖）
  const f2 = inWatch("editing.md")
  h.fake.emitChange(f2) // change 进 pending（防抖未到）
  h.fake.emitUnlink(f2) // 立即 fire unlink + cancel pending change
  await flushMicrotasks()
  // 推满防抖：被 cancel 的 add/change 都不应 fire
  t.mock.timers.tick(60_000)
  await flushMicrotasks()
  assert.equal(h.events.filter((e) => e.kind === "add").length, 0, "pending add 被 unlink cancel")
  assert.equal(
    h.events.filter((e) => e.kind === "change").length,
    0,
    "pending change 被 unlink cancel",
  )
  assert.equal(h.events.filter((e) => e.kind === "unlink").length, 2, "两次 unlink 都 fire")
  assert.equal(h.events.length, 2, "总共 2 次（都是 unlink，pending 全被 cancel）")
  await h.watcher.stop()
})

// ── relativePath ───────────────────────────────────────────────────────

test("DocsWatcher · relativePath = abs 相对 watchPath（子目录）", async (t) => {
  const h = await buildFake(t, { debounceMs: 60_000 })
  h.fake.emitAdd(inWatch(path.join("F999", "spec.md")))
  t.mock.timers.tick(60_000)
  await flushMicrotasks()
  assert.equal(h.events.length, 1)
  assert.match(h.events[0].relativePath, /^F999[/\\]spec\.md$/)
  await h.watcher.stop()
})

test("DocsWatcher · relativePath 取最长匹配 watchPath 前缀（重叠根）", async (t) => {
  // 范-r1 P3-2：原测试只传单路径，验不了「最长前缀」。这里传两个重叠根。
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const features = path.join(FAKE_ROOT, "features")
  const sub = path.join(features, "F999") // sub 是 features 的子目录（重叠）
  const events: DocsEvent[] = []
  let fake: FakeWatchSource | undefined
  const watcher = new DocsWatcher({
    watchPaths: [features, sub],
    debounceMs: 60_000,
    onEvent: (e) => {
      events.push(e)
    },
    watchSourceFactory: (paths, options) => {
      fake = new FakeWatchSource(paths, options)
      return fake
    },
  })
  await watcher.start()
  if (!fake) throw new Error("factory 未调用")
  // sub 下的文件 → 应相对更长的 sub 前缀（"spec.md"），而非 features（"F999/spec.md"）
  fake.emitAdd(path.join(sub, "spec.md"))
  t.mock.timers.tick(60_000)
  await flushMicrotasks()
  assert.equal(events.length, 1)
  assert.equal(
    events[0].relativePath,
    "spec.md",
    `应取最长前缀 sub, 实际 ${events[0].relativePath}`,
  )
  // 仅在 features 下的文件 → 相对 features
  fake.emitAdd(path.join(features, "F888.md"))
  t.mock.timers.tick(60_000)
  await flushMicrotasks()
  assert.equal(events[1].relativePath, "F888.md")
  await watcher.stop()
})

// ── onEvent throw 不打断 ────────────────────────────────────────────────

test("DocsWatcher · onEvent throw 被吞，watcher 继续", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let count = 0
  let fake: FakeWatchSource | undefined
  const watcher = new DocsWatcher({
    watchPaths: [WATCH_PATH],
    debounceMs: 60_000,
    onEvent: () => {
      count += 1
      throw new Error("intentional test error")
    },
    watchSourceFactory: (paths, options) => {
      fake = new FakeWatchSource(paths, options)
      return fake
    },
  })
  await watcher.start()
  if (!fake) throw new Error("factory 未调用")
  fake.emitAdd(inWatch("first.md"))
  t.mock.timers.tick(60_000)
  await flushMicrotasks()
  assert.equal(count, 1, "第 1 次 onEvent 触发")
  fake.emitAdd(inWatch("second.md"))
  t.mock.timers.tick(60_000)
  await flushMicrotasks()
  assert.equal(count, 2, "throw 不打断后续 onEvent")
  assert.equal(watcher.isRunning(), true, "watcher 仍 running")
  await watcher.stop()
})

// ── 接线断言（替代「真 fs 重测 chokidar 的 ignored/ignoreInitial」）──────────

test("DocsWatcher · 接线：factory 收到 DEFAULT_IGNORED + 自定义 ignored + ignoreInitial + awaitWriteFinish", async (t) => {
  const h = await buildFake(t, { stabilityMs: 1500, ignored: [/custom-pattern/] })
  const opts = h.capturedOptions()
  assert.ok(opts, "factory 应收到 options")
  assert.equal(opts.ignoreInitial, true, "ignoreInitial=true（启动已存在文件不算 add）")
  assert.equal(opts.persistent, true)
  assert.equal(opts.awaitWriteFinish.stabilityThreshold, 1500, "stabilityThreshold = stabilityMs")
  // ignored 含全部 7 项 DEFAULT_IGNORED + 自定义（范-r1 P3-1：原只查 3 项，删 ~/.swp/.git 仍绿）
  const ignoredSrc = opts.ignored.map((p) => (p instanceof RegExp ? p.source : String(p)))
  for (const [needle, name] of [
    [/tmp/, ".tmp"],
    [/~/, "~ 备份"],
    [/swp/, ".swp"],
    [/swo/, ".swo"],
    [/DS_Store/, ".DS_Store"],
    [/git/, ".git/"],
    [/node_modules/, "node_modules/"],
  ] as const) {
    assert.ok(
      ignoredSrc.some((s) => needle.test(s)),
      `DEFAULT_IGNORED 应含 ${name}: ${ignoredSrc.join(",")}`,
    )
  }
  assert.ok(
    ignoredSrc.some((s) => /custom-pattern/.test(s)),
    "应含自定义 ignore",
  )
  // 总数锁：7 默认 + 1 自定义；删任一默认值即挂
  assert.equal(
    opts.ignored.length,
    8,
    `ignored 应为 7 默认 + 1 自定义 = 8, 实际 ${opts.ignored.length}`,
  )
  await h.watcher.stop()
})

test("DocsWatcher · 接线：pollInterval clamp [10,100]（范-r1 P3）", async (t) => {
  // stabilityMs/3，clamp 到 [10,100]
  for (const [stabilityMs, expected] of [
    [30, 10], // floor(10)=10
    [150, 50], // floor(50)=50
    [1500, 100], // floor(500) → clamp 100
    [9, 10], // floor(3)=3 → clamp 10
  ] as const) {
    const h = await buildFake(t, { stabilityMs, mockTimers: false })
    const opts = h.capturedOptions()
    assert.ok(opts)
    assert.equal(
      opts.awaitWriteFinish.pollInterval,
      expected,
      `stabilityMs=${stabilityMs} → pollInterval ${expected}`,
    )
    await h.watcher.stop()
  }
})

// ── [integration] 真 chokidar+真 fs smoke（默认 skip）─────────────────────
// 默认 chokidar 工厂的端到端验证。husky 套件不跑（避免真 fs 时序在满负载下 flaky）。
// 按需：DOCS_WATCHER_FS_IT=1 pnpm --filter @multi-agent/api exec tsx --test docs-watcher.test.ts
const RUN_FS_IT = process.env.DOCS_WATCHER_FS_IT === "1"

test(
  "DocsWatcher · [integration] 真 chokidar+真 fs: add fire + ignored 不 fire + ignoreInitial（默认 skip）",
  { skip: !RUN_FS_IT },
  async () => {
    const fs = await import("node:fs")
    const os = await import("node:os")
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-watcher-it-"))
    const watchPath = path.join(tempDir, "features")
    fs.mkdirSync(watchPath, { recursive: true })
    // ignoreInitial：start 前已存在的文件不应触发 add（范-r1 P2-1：smoke 此前仅验 add）
    fs.writeFileSync(path.join(watchPath, "preexisting.md"), "old\n", "utf-8")
    const events: DocsEvent[] = []
    // 默认 factory（chokidar）—— 不注入 watchSourceFactory
    const watcher = new DocsWatcher({
      watchPaths: [watchPath],
      debounceMs: 80,
      stabilityMs: 30,
      onEvent: (e) => {
        events.push(e)
      },
    })
    await watcher.start()
    try {
      fs.writeFileSync(path.join(watchPath, "F999-it.md"), "# it\n", "utf-8") // 应 fire add
      fs.writeFileSync(path.join(watchPath, "scratch.md.tmp"), "x", "utf-8") // ignored 不应 fire
      const start = Date.now()
      while (!events.some((e) => e.relativePath === "F999-it.md") && Date.now() - start < 10_000) {
        await sleep(25)
      }
      // 再等一拍，确认 ignored/preexisting 不会迟到触发
      await sleep(300)
      const rels = events.map((e) => e.relativePath)
      assert.ok(
        rels.includes("F999-it.md"),
        `真 chokidar 应 fire F999-it.md add, 实际 ${rels.join(",")}`,
      )
      assert.equal(events.find((e) => e.relativePath === "F999-it.md")?.kind, "add")
      assert.ok(!rels.includes("preexisting.md"), "ignoreInitial：start 前已存在文件不 fire")
      assert.ok(!rels.some((r) => r.endsWith(".tmp")), "ignored：.tmp 文件不 fire")
    } finally {
      await watcher.stop()
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 })
    }
  },
)
