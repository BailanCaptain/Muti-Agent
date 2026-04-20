import type { ChildProcess } from "node:child_process"
import { spawn as realSpawn } from "node:child_process"
import { resolveClaudeCommand } from "./claude-command"

export interface HaikuRunResult {
  ok: boolean
  /** Trimmed stdout on success; empty string on failure. */
  text: string
  /** Wall-clock duration measured from spawn to close / timeout / error. */
  durationMs: number
  /** One of: `timeout` | `exit-code-<N>` | `empty-output` | `spawn-error:<msg>`. */
  error?: string
}

export interface HaikuRunOptions {
  /** Default 5000ms. */
  timeoutMs?: number
}

export interface HaikuRunner {
  runPrompt(prompt: string, opts?: HaikuRunOptions): Promise<HaikuRunResult>
}

type SpawnFn = (command: string, args: readonly string[], options?: { shell?: boolean }) => ChildProcess

export interface HaikuRunnerDeps {
  spawn?: SpawnFn
}

const DEFAULT_TIMEOUT_MS = 15000

/**
 * 单轮 Haiku 调用封装。内部 spawn `claude --print --model claude-haiku-4-5 "<prompt>"`，
 * 5s 超时 kill，stdout trim 返回。失败分四类：timeout / exit-code-N / empty-output / spawn-error。
 *
 * 注入 `spawn` 便于测试（stub ChildProcess）。生产使用默认 node:child_process.spawn。
 */
export function createHaikuRunner(deps: HaikuRunnerDeps = {}): HaikuRunner {
  const spawn = deps.spawn ?? (realSpawn as SpawnFn)

  return {
    runPrompt(prompt, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const runtime = resolveClaudeCommand()
      const args = [...runtime.prefixArgs, "--print", "--model", "claude-haiku-4-5", prompt]
      const start = Date.now()
      const proc = spawn(runtime.command, args, { shell: runtime.shell })
      // Close stdin immediately so `claude --print` sees EOF and can exit cleanly.
      // Without this, claude CLI on Windows hangs until external kill even after
      // writing stdout, which meant every call hit the timeout branch in prod.
      proc.stdin?.end()

      let stdout = ""
      proc.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8")
      })

      return new Promise<HaikuRunResult>((resolve) => {
        let settled = false
        const settle = (res: HaikuRunResult) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(res)
        }

        const timer = setTimeout(() => {
          proc.kill()
          settle({ ok: false, text: "", durationMs: Date.now() - start, error: "timeout" })
        }, timeoutMs)

        proc.on("close", (code) => {
          const durationMs = Date.now() - start
          const text = stdout.trim()
          if (code !== 0) {
            return settle({ ok: false, text: "", durationMs, error: `exit-code-${code}` })
          }
          if (!text) {
            return settle({ ok: false, text: "", durationMs, error: "empty-output" })
          }
          settle({ ok: true, text, durationMs })
        })

        proc.on("error", (err: Error) => {
          settle({
            ok: false,
            text: "",
            durationMs: Date.now() - start,
            error: `spawn-error:${err.message}`,
          })
        })
      })
    },
  }
}
