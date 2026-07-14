/**
 * F027 收录设置 · codex / gemini 单轮 runner 单测（spawn 注入）
 *
 * 断言点 = 2026-06-13 `--help` 实测落定的调用形态（防漂移）：
 *   codex:  exec -s read-only --skip-git-repo-check [-m <model>]，prompt 走 stdin
 *   gemini: --approval-mode plan -p "" [-m <model>]，prompt 走 stdin
 */

import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { describe, it } from "node:test"
import { createCodexPromptRunner, createGeminiPromptRunner } from "./wiki-compile-cli-runners"

interface FakeProcOpts {
  exitCode?: number
  stdout?: string
  stderr?: string
}

function makeFakeSpawn(opts: FakeProcOpts = {}) {
  const calls: {
    command: string
    args: readonly string[]
    stdin: string
    options?: { shell?: boolean }
  }[] = []
  const spawn = (command: string, args: readonly string[], options?: { shell?: boolean }) => {
    const call = { command, args, stdin: "", options }
    calls.push(call)
    const proc = new EventEmitter() as EventEmitter & {
      stdin: { write: (s: string) => void; end: () => void; on: () => void }
      stdout: EventEmitter
      stderr: EventEmitter
      kill: () => void
    }
    proc.stdin = {
      write: (s: string) => {
        call.stdin += s
      },
      end: () => {},
      on: () => {},
    }
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = () => {}
    setImmediate(() => {
      if (opts.stdout) proc.stdout.emit("data", opts.stdout)
      if (opts.stderr) proc.stderr.emit("data", opts.stderr)
      proc.emit("close", opts.exitCode ?? 0)
    })
    return proc as never
  }
  return { spawn, calls }
}

describe("createCodexPromptRunner", () => {
  it("signal 已取消 → 不 spawn，直接返回 aborted", async () => {
    const fake = makeFakeSpawn({ stdout: "不应执行" })
    const ac = new AbortController()
    ac.abort()
    const r = await createCodexPromptRunner({ spawn: fake.spawn }).runPrompt("p", {
      signal: ac.signal,
    })
    assert.equal(r.ok, false)
    assert.equal(r.error, "aborted")
    assert.equal(fake.calls.length, 0)
  })

  it("运行中取消 → killTree 整树终止并返回 aborted", async () => {
    const killed: unknown[] = []
    let plainKilled = 0
    const hangingSpawn = () => {
      const proc = new EventEmitter() as never as EventEmitter & {
        stdin: { write: () => void; end: () => void; on: () => void }
        stdout: EventEmitter
        stderr: EventEmitter
        kill: () => void
      }
      proc.stdin = { write: () => {}, end: () => {}, on: () => {} }
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.kill = () => {
        plainKilled++
      }
      return proc as never
    }
    const ac = new AbortController()
    const pending = createCodexPromptRunner({
      spawn: hangingSpawn,
      killTree: (proc) => killed.push(proc),
    }).runPrompt("p", { timeoutMs: 20, signal: ac.signal })
    ac.abort()
    const r = await pending
    assert.equal(r.ok, false)
    assert.equal(r.error, "aborted")
    assert.equal(killed.length, 1)
    assert.equal(plainKilled, 0, "Windows shell runner 取消不能只杀 cmd 壳")
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(killed.length, 1, "aborted settle 后必须清 timer，不能再按 timeout 二次树杀")
  })

  it("args = exec -s read-only --skip-git-repo-check；prompt 经 stdin；stdout trim 返回", async () => {
    const fake = makeFakeSpawn({ stdout: "  compiled-json  " })
    const runner = createCodexPromptRunner({ spawn: fake.spawn })
    const r = await runner.runPrompt("THE PROMPT")
    assert.equal(r.ok, true)
    assert.equal(r.text, "compiled-json")
    assert.equal(fake.calls[0].command, "codex")
    assert.deepEqual(fake.calls[0].args, ["exec", "-s", "read-only", "--skip-git-repo-check"])
    assert.equal(fake.calls[0].stdin, "THE PROMPT")
  })

  it("model 传入 → 追加 -m <model>；留空 → 不传（CLI 默认模型）", async () => {
    const fake = makeFakeSpawn({ stdout: "x" })
    await createCodexPromptRunner({ spawn: fake.spawn, model: "gpt-5.4" }).runPrompt("p")
    assert.deepEqual(fake.calls[0].args.slice(-2), ["-m", "gpt-5.4"])
    await createCodexPromptRunner({ spawn: fake.spawn, model: "   " }).runPrompt("p")
    assert.ok(!fake.calls[1].args.includes("-m"))
  })

  it('补丁#3 · effort → --config model_reasoning_effort="<effort>"（小孙：codex 可选强度）', async () => {
    const fake = makeFakeSpawn({ stdout: "x" })
    await createCodexPromptRunner({ spawn: fake.spawn, model: "gpt-5.4", effort: "xhigh" }).runPrompt(
      "p",
    )
    const args = fake.calls[0].args
    assert.ok(args.includes("-m") && args.includes("gpt-5.4"))
    assert.ok(args.includes("--config"), `应含 --config: ${args.join(" ")}`)
    assert.ok(
      args.some((a) => String(a) === 'model_reasoning_effort="xhigh"'),
      `应含 model_reasoning_effort="xhigh": ${args.join(" ")}`,
    )
  })

  it("补丁#3 · 无 effort → 不带 --config（CLI 默认强度）", async () => {
    const fake = makeFakeSpawn({ stdout: "x" })
    await createCodexPromptRunner({ spawn: fake.spawn, model: "gpt-5.4" }).runPrompt("p")
    assert.ok(!fake.calls[0].args.includes("--config"))
  })

  it("非零退出 → error 含 exit-code + stderr 摘要（fallback 链可识别 quota/rate）", async () => {
    const fake = makeFakeSpawn({ exitCode: 1, stderr: "rate limit exceeded" })
    const r = await createCodexPromptRunner({ spawn: fake.spawn }).runPrompt("p")
    assert.equal(r.ok, false)
    assert.match(r.error ?? "", /exit-code-1/)
    assert.match(r.error ?? "", /rate limit/)
  })
})

describe("createGeminiPromptRunner", () => {
  it('args = --approval-mode plan -p ""；prompt 经 stdin', async () => {
    const fake = makeFakeSpawn({ stdout: "g-out" })
    const runner = createGeminiPromptRunner({ spawn: fake.spawn })
    const r = await runner.runPrompt("G PROMPT")
    assert.equal(r.ok, true)
    assert.equal(r.text, "g-out")
    assert.equal(fake.calls[0].command, "gemini")
    assert.deepEqual(fake.calls[0].args, ["--approval-mode", "plan", "-p", '""'])
    assert.equal(fake.calls[0].stdin, "G PROMPT")
  })

  it("model 传入 → 追加 -m", async () => {
    const fake = makeFakeSpawn({ stdout: "x" })
    await createGeminiPromptRunner({ spawn: fake.spawn, model: "gemini-3-pro" }).runPrompt("p")
    assert.deepEqual(fake.calls[0].args.slice(-2), ["-m", "gemini-3-pro"])
  })

  // 德彪 kb-ux2 r3 P2：-p 空参按平台分形——win32 shell:true 走 cmd 解析需字面 `""`；
  // POSIX shell:false argv 直传，`""` 两个引号字符会污染 prompt，必须传真空串
  it('-p 空参平台分形：win32 → 字面 `""`；POSIX → 真空串', async () => {
    const fakeWin = makeFakeSpawn({ stdout: "x" })
    await createGeminiPromptRunner({ spawn: fakeWin.spawn, isWindows: true }).runPrompt("p")
    assert.deepEqual(fakeWin.calls[0].args, ["--approval-mode", "plan", "-p", '""'])

    const fakePosix = makeFakeSpawn({ stdout: "x" })
    await createGeminiPromptRunner({ spawn: fakePosix.spawn, isWindows: false }).runPrompt("p")
    assert.deepEqual(fakePosix.calls[0].args, ["--approval-mode", "plan", "-p", ""])
  })

  it("空输出 → empty-output 错误（不当成功）", async () => {
    const fake = makeFakeSpawn({ stdout: "   " })
    const r = await createGeminiPromptRunner({ spawn: fake.spawn }).runPrompt("p")
    assert.equal(r.ok, false)
    assert.match(r.error ?? "", /empty-output/)
  })
})

describe("shell 平台分流（德彪 kb-ux2 r2 P2）", () => {
  it("isWindows=true → shell:true（.cmd shim 需要）；false → shell:false（POSIX 直接 exec，kill 即杀真子进程）", async () => {
    const fakeWin = makeFakeSpawn({ stdout: "x" })
    await createCodexPromptRunner({ spawn: fakeWin.spawn, isWindows: true }).runPrompt("p")
    assert.equal(fakeWin.calls[0].options?.shell, true)

    const fakePosix = makeFakeSpawn({ stdout: "x" })
    await createGeminiPromptRunner({ spawn: fakePosix.spawn, isWindows: false }).runPrompt("p")
    assert.equal(fakePosix.calls[0].options?.shell, false)
  })

  it("isWindows=false 超时 → 直接 proc.kill（无壳层，无需 taskkill 树杀）", async () => {
    let plainKilled = 0
    const hangingSpawn = () => {
      const proc = new EventEmitter() as never as EventEmitter & {
        stdin: { write: () => void; end: () => void; on: () => void }
        stdout: EventEmitter
        stderr: EventEmitter
        kill: () => void
      }
      proc.stdin = { write: () => {}, end: () => {}, on: () => {} }
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.kill = () => {
        plainKilled++
      }
      return proc as never
    }
    const r = await createCodexPromptRunner({
      spawn: hangingSpawn,
      isWindows: false,
    }).runPrompt("p", { timeoutMs: 20 })
    assert.equal(r.ok, false)
    assert.equal(r.error, "timeout")
    assert.equal(plainKilled, 1)
  })
})

describe("timeout 树杀（德彪 kb-ux2 r1 P2）", () => {
  it("超时 → 调 killTree 而非裸 proc.kill（shell:true 下 kill 只杀 cmd 壳，CLI 子进程孤儿化）", async () => {
    // 永不 close 的进程：触发 timeout 路径
    const killed: unknown[] = []
    const hangingSpawn = () => {
      const proc = new EventEmitter() as never as EventEmitter & {
        stdin: { write: () => void; end: () => void; on: () => void }
        stdout: EventEmitter
        stderr: EventEmitter
        kill: () => void
      }
      proc.stdin = { write: () => {}, end: () => {}, on: () => {} }
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.kill = () => {}
      return proc as never
    }
    const r = await createCodexPromptRunner({
      spawn: hangingSpawn,
      killTree: (p) => killed.push(p),
    }).runPrompt("p", { timeoutMs: 20 })
    assert.equal(r.ok, false)
    assert.equal(r.error, "timeout")
    assert.equal(killed.length, 1, "timeout 必须走 killTree 整树终止")
  })
})
