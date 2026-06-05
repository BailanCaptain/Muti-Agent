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

type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: { shell?: boolean },
) => ChildProcess

export interface HaikuRunnerDeps {
  spawn?: SpawnFn
}

const DEFAULT_TIMEOUT_MS = 15000

const HAIKU_MODEL = "claude-haiku-4-5"
const SONNET_MODEL = "claude-sonnet-4-6"
const OPUS_MODEL = "claude-opus-4-7"

/**
 * 单轮 Claude CLI 调用封装。内部 spawn `claude --print --model <model> "<prompt>"`，
 * 超时 kill，stdout trim 返回。失败分四类：timeout / exit-code-N / empty-output / spawn-error。
 *
 * 注入 `spawn` 便于测试（stub ChildProcess）。生产使用默认 node:child_process.spawn。
 *
 * 模型选择：
 *   - HaikuRunner (haiku-4-5): SessionTitler 等高频低成本任务（房间标题等）
 *   - SonnetRunner (sonnet-4-6): F027 P12 decision extractor 等需要语义判断准确度的任务
 *     （小孙 2026-05-13 拍板：决策识别准确度优先于 quota；订阅模式 quota 不是约束）
 */
function createClaudeCliRunner(model: string, deps: HaikuRunnerDeps = {}): HaikuRunner {
  const spawn = deps.spawn ?? (realSpawn as SpawnFn)

  return {
    runPrompt(prompt, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const runtime = resolveClaudeCommand()
      const args = [...runtime.prefixArgs, "--print", "--model", model]
      const start = Date.now()
      const proc = spawn(runtime.command, args, { shell: runtime.shell })
      // F027 B3: prompt 经 stdin 喂入，**不进 argv**。
      // 原先 prompt 当 argv 末位传 → Windows CreateProcess 命令行 ~32KB 上限，大文档
      // （实测 45KB docs/lessons/lessons-learned.md）触发 `spawn ENAMETOOLONG`，compile 全退回 stub。
      // stdin 无长度限制。写完即 end()：既喂入 prompt，又让 `claude --print` 见 EOF 干净退出
      // （保留原 Windows stdin-EOF hang 防护）。
      // 德彪 codex P2：stdin error（EPIPE，claude 读完前先退出）不能崩进程，但也**不能静默吞** ——
      // 否则 prompt 没写完导致 LLM 收截断输入却被当普通失败，无从诊断（正是本 bug 的"无声失败"教训）。
      // 记 stdinError，仅在失败路径（exit≠0 / empty-output）拼进 error 暴露；成功路径（有输出=prompt
      // 已被读够）不因迟到的 benign EPIPE 误判失败。
      let stdinError: string | undefined
      proc.stdin?.on?.("error", (err: Error) => {
        stdinError = err?.message ?? String(err)
      })
      proc.stdin?.write(prompt)
      proc.stdin?.end()

      let stdout = ""
      proc.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8")
      })

      // codex P2-1(G11)：收集 stderr —— claude CLI 把 quota/rate-limit/429 写 stderr，
      // 不进 stderr 的话 exit-code-N 永远匹配不到 runner-with-fallback 的 /quota|rate|429/，
      // Opus 配额耗尽就不会降级 Haiku 而直接 fail。失败时把 stderr 摘要拼进 error。
      let stderr = ""
      proc.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8")
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
          // 德彪 codex P2：失败路径附 stdin-error（若有），让"prompt 没喂进去"可诊断（非静默吞）。
          const stdinTail = stdinError ? ` stdin-error: ${stdinError}` : ""
          if (code !== 0) {
            // 把 stderr 摘要拼进 error，让 runner-with-fallback 能识别 quota/rate/429 触发降级。
            const errTail = stderr.trim().slice(0, 200)
            const error = errTail
              ? `exit-code-${code}: ${errTail}${stdinTail}`
              : `exit-code-${code}${stdinTail}`
            return settle({ ok: false, text: "", durationMs, error })
          }
          if (!text) {
            return settle({ ok: false, text: "", durationMs, error: `empty-output${stdinTail}` })
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

/** Haiku 4.5 — SessionTitler 等高频低成本任务（房间标题等） */
export function createHaikuRunner(deps: HaikuRunnerDeps = {}): HaikuRunner {
  return createClaudeCliRunner(HAIKU_MODEL, deps)
}

/**
 * Sonnet 4.6 — F027 P12 decision extractor 等需要语义判断准确度的任务。
 * 小孙 2026-05-13 拍板：决策识别准确度优先于 quota；订阅模式 quota 不是约束。
 * 接口与 HaikuRunner 完全一致（HaikuRunner 是历史 type 名，可作通用 ClaudeRunner 用）。
 */
export function createSonnetRunner(deps: HaikuRunnerDeps = {}): HaikuRunner {
  return createClaudeCliRunner(SONNET_MODEL, deps)
}

/** Opus 4.7 — F027 P18 evidence pack judge runner. */
export function createOpusRunner(deps: HaikuRunnerDeps = {}): HaikuRunner {
  return createClaudeCliRunner(OPUS_MODEL, deps)
}
