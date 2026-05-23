/**
 * F027 P19.7 · DocsWatcher 测试 — AC-P2-7
 *
 * 覆盖：
 *   - 真 fs temp integration: 起 watcher → 写文件 → 等 stability + debounce → onEvent fire
 *   - 60s debounce 防保存中频繁触发：连续两次 write 同 path 在 debounce 内 → onEvent 仅 1 次
 *   - debounce 超时：两次 write 间隔 > debounce → onEvent 2 次
 *   - kind 收敛：add 后接 change → finalKind='add'（caller 看新文件信号）
 *   - 忽略临时文件：*.tmp / *~ / *.swp 不触发 onEvent
 *   - unlink 立即 fire（无 debounce 等待）+ cancel pending add/change
 *   - start/stop idempotent
 *   - onEvent throw 被吞 + watcher 继续
 *   - relativePath 计算（取最长匹配 watchPath 前缀）
 *   - ignoreInitial：启动时已存在的文件不触发 add
 *
 * 性能调优：测试用极短 debounce/stability（80ms / 30ms）压缩耗时。
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { DocsWatcher, type DocsEvent } from "./docs-watcher"

function safeTempDir(prefix: string) {
  const runtimeDir = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(runtimeDir, { recursive: true })
  return fs.mkdtempSync(path.join(runtimeDir, prefix))
}
function safeCleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // best effort
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 轮询等待条件成立（chokidar + 真 fs 时序在满负载 CI 下抖动大 —— 固定 sleep
 * 不可靠，改为 poll-until 直到条件成立或超时）。
 */
async function waitFor(
  cond: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 3000
  const intervalMs = opts.intervalMs ?? 25
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true
    await sleep(intervalMs)
  }
  return cond()
}

interface Harness {
  watcher: DocsWatcher
  events: DocsEvent[]
  tempDir: string
  watchPath: string
  cleanup: () => Promise<void>
}

async function build(opts: {
  debounceMs?: number
  stabilityMs?: number
  ignored?: (string | RegExp)[]
} = {}): Promise<Harness> {
  const tempDir = safeTempDir("docs-watcher-")
  const watchPath = path.join(tempDir, "features")
  fs.mkdirSync(watchPath, { recursive: true })
  const events: DocsEvent[] = []
  const watcher = new DocsWatcher({
    watchPaths: [watchPath],
    debounceMs: opts.debounceMs ?? 80,
    stabilityMs: opts.stabilityMs ?? 30,
    ignored: opts.ignored,
    onEvent: (e) => {
      events.push(e)
    },
  })
  await watcher.start()
  return {
    watcher,
    events,
    tempDir,
    watchPath,
    cleanup: async () => {
      await watcher.stop()
      safeCleanup(tempDir)
    },
  }
}

// ── 基础 lifecycle ────────────────────────────────────────────────────

test("DocsWatcher · start/stop idempotent + isRunning 状态正确", async () => {
  const h = await build()
  try {
    assert.equal(h.watcher.isRunning(), true)
    await h.watcher.start() // second call no-op
    assert.equal(h.watcher.isRunning(), true)
    await h.watcher.stop()
    assert.equal(h.watcher.isRunning(), false)
    await h.watcher.stop() // second stop no-op
    assert.equal(h.watcher.isRunning(), false)
  } finally {
    await h.cleanup()
  }
})

// ── 真 fs integration ─────────────────────────────────────────────────
// 注：chokidar + 真 fs 在满负载 CI 时序抖动大 → 用 waitFor 轮询替代固定 sleep。

test("DocsWatcher · 真 fs add → stability + debounce 后 onEvent fire", async () => {
  const h = await build({ debounceMs: 80, stabilityMs: 30 })
  try {
    const f = path.join(h.watchPath, "F999-test.md")
    fs.writeFileSync(f, "# F999 test\n", "utf-8")
    const fired = await waitFor(() => h.events.length >= 1)
    assert.ok(fired, `应触发 onEvent, 实际 ${h.events.length}`)
    assert.equal(h.events.length, 1)
    assert.equal(h.events[0].kind, "add")
    assert.equal(h.events[0].absolutePath, path.resolve(f))
    assert.equal(h.events[0].relativePath, "F999-test.md")
  } finally {
    await h.cleanup()
  }
})

// ── 60s debounce 收敛 ────────────────────────────────────────────────

test("DocsWatcher · 同 path 连续两次 write 在 debounce 内 → onEvent 仅 1 次", async () => {
  const h = await build({ debounceMs: 200, stabilityMs: 30 })
  try {
    const f = path.join(h.watchPath, "rapid.md")
    fs.writeFileSync(f, "v1", "utf-8")
    await sleep(80)
    fs.writeFileSync(f, "v2", "utf-8") // reset debounce
    await sleep(80)
    fs.writeFileSync(f, "v3", "utf-8") // reset again
    // 等到 onEvent fire（debounce 收敛后 1 次）
    const fired = await waitFor(() => h.events.length >= 1)
    assert.ok(fired, "debounce 收敛后应 fire 1 次")
    // 再等一个 debounce 窗口确认没有第 2 次
    await sleep(300)
    assert.equal(h.events.length, 1, `连续编辑只触发 1 次, 实际 ${h.events.length}`)
  } finally {
    await h.cleanup()
  }
})

test("DocsWatcher · 两次 write 间隔 > debounce → onEvent 触发 2 次", async () => {
  const h = await build({ debounceMs: 80, stabilityMs: 30 })
  try {
    const f = path.join(h.watchPath, "spaced.md")
    fs.writeFileSync(f, "v1", "utf-8")
    assert.ok(await waitFor(() => h.events.length >= 1), "第 1 次应 fire")
    fs.writeFileSync(f, "v2", "utf-8")
    assert.ok(
      await waitFor(() => h.events.length >= 2),
      `两次独立写应 2 次, 实际 ${h.events.length}`,
    )
  } finally {
    await h.cleanup()
  }
})

test("DocsWatcher · kind 收敛: add 后接 change → finalKind='add'", async () => {
  const h = await build({ debounceMs: 200, stabilityMs: 30 })
  try {
    const f = path.join(h.watchPath, "merged.md")
    fs.writeFileSync(f, "v1", "utf-8") // add
    await sleep(80)
    fs.writeFileSync(f, "v2", "utf-8") // change in debounce window → reset debounce 但保留 kind=add
    assert.ok(await waitFor(() => h.events.length >= 1), "debounce 收敛后应 fire")
    await sleep(300) // 确认无第 2 次
    assert.equal(h.events.length, 1)
    assert.equal(h.events[0].kind, "add", "add+change debounce 收敛后应保留 add 信号")
  } finally {
    await h.cleanup()
  }
})

// ── 忽略临时文件 ──────────────────────────────────────────────────────

test("DocsWatcher · 忽略 *.tmp / *~ / *.swp / .DS_Store", async () => {
  const h = await build({ debounceMs: 60, stabilityMs: 30 })
  try {
    fs.writeFileSync(path.join(h.watchPath, "real.md"), "real", "utf-8")
    fs.writeFileSync(path.join(h.watchPath, "draft.md.tmp"), "tmp", "utf-8")
    fs.writeFileSync(path.join(h.watchPath, "draft.md~"), "vim backup", "utf-8")
    fs.writeFileSync(path.join(h.watchPath, ".DS_Store"), "mac", "utf-8")
    fs.writeFileSync(path.join(h.watchPath, "config.swp"), "vim swap", "utf-8")
    assert.ok(await waitFor(() => h.events.length >= 1), "real.md 应 fire")
    await sleep(300) // 给 ignored 文件充分机会"误触发"（应不会）
    assert.equal(
      h.events.length,
      1,
      `仅 real.md 应触发, ignored ${h.events.length - 1} 个意外: ${h.events.map((e) => e.relativePath).join(",")}`,
    )
    assert.equal(h.events[0].relativePath, "real.md")
  } finally {
    await h.cleanup()
  }
})

// ── unlink 即时 fire + cancel pending ──────────────────────────────────

test("DocsWatcher · unlink 立即 fire + 同 path pending add/change cancel", async () => {
  const h = await build({ debounceMs: 500, stabilityMs: 30 })
  try {
    const f = path.join(h.watchPath, "ephemeral.md")
    fs.writeFileSync(f, "data", "utf-8")
    await sleep(80) // 让 chokidar 有机会 stability + 进 debounce（add 进 pending）
    fs.unlinkSync(f)
    // unlink 立即 fire（无 debounce）→ 轮询等 unlink kind 出现
    const sawUnlink = await waitFor(() => h.events.some((e) => e.kind === "unlink"))
    assert.ok(sawUnlink, `events kinds: ${h.events.map((e) => e.kind).join(",")}`)
    // add 应被 unlink cancel（debounce 500ms 还没到）→ 不进 events
    const addCount = h.events.filter((e) => e.kind === "add").length
    assert.equal(addCount, 0, "add 应被 unlink cancel，不进 events")
  } finally {
    await h.cleanup()
  }
})

// ── ignoreInitial：启动时已存在的文件不触发 add ────────────────────────

test("DocsWatcher · 启动前已存在文件不触发 add (ignoreInitial=true)", async () => {
  const tempDir = safeTempDir("docs-watcher-init-")
  const watchPath = path.join(tempDir, "features")
  fs.mkdirSync(watchPath, { recursive: true })
  // 启动 watcher 前先放文件
  fs.writeFileSync(path.join(watchPath, "preexisting.md"), "data", "utf-8")
  const events: DocsEvent[] = []
  const watcher = new DocsWatcher({
    watchPaths: [watchPath],
    debounceMs: 60,
    stabilityMs: 30,
    onEvent: (e) => {
      events.push(e)
    },
  })
  await watcher.start()
  try {
    await sleep(250)
    assert.equal(events.length, 0, "启动前文件不应触发 add（ingestInitial=true）")
  } finally {
    await watcher.stop()
    safeCleanup(tempDir)
  }
})

// ── onEvent throw 不打断 watcher ──────────────────────────────────────

test("DocsWatcher · onEvent throw 被吞，watcher 继续运行", async () => {
  const tempDir = safeTempDir("docs-watcher-throw-")
  const watchPath = path.join(tempDir, "features")
  fs.mkdirSync(watchPath, { recursive: true })
  let count = 0
  const watcher = new DocsWatcher({
    watchPaths: [watchPath],
    debounceMs: 60,
    stabilityMs: 30,
    onEvent: () => {
      count += 1
      throw new Error("intentional test error")
    },
  })
  await watcher.start()
  try {
    fs.writeFileSync(path.join(watchPath, "first.md"), "1", "utf-8")
    assert.ok(await waitFor(() => count >= 1), "第 1 次 onEvent 应触发")
    fs.writeFileSync(path.join(watchPath, "second.md"), "2", "utf-8")
    assert.ok(
      await waitFor(() => count >= 2),
      `两次 onEvent 都应被调用（throw 不打断）, 实际 ${count}`,
    )
    assert.equal(watcher.isRunning(), true, "watcher 仍 running")
  } finally {
    await watcher.stop()
    safeCleanup(tempDir)
  }
})

// ── relativePath: 取最长匹配 watchPath 前缀 ────────────────────────────

test("DocsWatcher · relativePath = abs path 相对最长匹配 watchPath", async () => {
  const tempDir = safeTempDir("docs-watcher-rel-")
  const features = path.join(tempDir, "features")
  const sub = path.join(features, "F999")
  fs.mkdirSync(sub, { recursive: true })
  const events: DocsEvent[] = []
  const watcher = new DocsWatcher({
    watchPaths: [features],
    debounceMs: 60,
    stabilityMs: 30,
    onEvent: (e) => {
      events.push(e)
    },
  })
  await watcher.start()
  try {
    fs.writeFileSync(path.join(sub, "spec.md"), "data", "utf-8")
    assert.ok(await waitFor(() => events.length >= 1), "应 fire onEvent")
    assert.equal(events.length, 1)
    // relativePath 相对 features：F999/spec.md（windows 是 F999\spec.md）
    assert.match(events[0].relativePath, /^F999[/\\]spec\.md$/)
  } finally {
    await watcher.stop()
    safeCleanup(tempDir)
  }
})
