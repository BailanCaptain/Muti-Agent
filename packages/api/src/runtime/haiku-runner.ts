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
  /**
   * 外部取消（F037 播客批德彪 r2 P1）：abort → kill CLI 子进程并立即 settle
   * `error:"aborted"`。缺省不挂——既有调用方零影响。
   */
  signal?: AbortSignal
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
  /** Windows shell/Node 包装层必须整树终止；测试可注入观察。 */
  killTree?: (proc: ChildProcess) => void
  isWindows?: boolean
}

const DEFAULT_TIMEOUT_MS = 15000

const HAIKU_MODEL = "claude-haiku-4-5"
const SONNET_MODEL = "claude-sonnet-4-6"
const OPUS_MODEL = "claude-opus-4-7"
const OPUS_46_MODEL = "claude-opus-4-6"

function winKillTree(proc: ChildProcess): void {
  if (proc.pid) {
    const taskkill = realSpawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"])
    taskkill.on("error", () => {})
  } else {
    proc.kill()
  }
}

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
function createClaudeCliRunner(
  model: string,
  deps: HaikuRunnerDeps = {},
  effort?: string,
): HaikuRunner {
  const spawn = deps.spawn ?? (realSpawn as SpawnFn)
  const isWindows = deps.isWindows ?? process.platform === "win32"
  const killTree = deps.killTree ?? (isWindows ? winKillTree : (proc: ChildProcess) => proc.kill())

  return {
    runPrompt(prompt, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      // 预 abort：不 spawn（F037 德彪 r2 P1——预算已掐断时绝不再起 CLI 进程烧配额）
      if (opts.signal?.aborted) {
        return Promise.resolve({ ok: false, text: "", durationMs: 0, error: "aborted" })
      }
      const runtime = resolveClaudeCommand()
      const args = [...runtime.prefixArgs, "--print", "--model", model]
      // 补丁#3（小孙「claude 可选强度」）：effort → `--effort <value>`（同 claude-runtime 主链）。
      // 留空 → 不传 → CLI 默认强度。
      if (effort?.trim()) args.push("--effort", effort.trim())
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
          opts.signal?.removeEventListener("abort", onAbort)
          resolve(res)
        }

        const timer = setTimeout(() => {
          settle({ ok: false, text: "", durationMs: Date.now() - start, error: "timeout" })
          // Windows 下 Claude 可能经 cmd/node 包装；必须杀进程树，避免超时后仍后台耗额度。
          try {
            killTree(proc)
          } catch {
            // 调用已 fail-closed；终止失败不得让 promise 悬挂。
          }
        }, timeoutMs)

        // 外部取消：kill 子进程立即收场；注册后补查一次防「spawn 与注册之间」的窗口漏
        const onAbort = () => {
          settle({ ok: false, text: "", durationMs: Date.now() - start, error: "aborted" })
          try {
            killTree(proc)
          } catch {
            // 调用已取消；终止失败不得让 promise 悬挂。
          }
        }
        opts.signal?.addEventListener("abort", onAbort, { once: true })
        if (opts.signal?.aborted) onAbort()

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

/**
 * Opus 4.6 — F027 B1-a session 滚动会话摘要生成器。
 * 小孙 2026-06-06 拍：摘要弃 Gemini CLI，改用 Claude Opus 4.6。走 stdin（本 runner 已修
 * ENAMETOOLONG）—— 摘要 prompt 含最多 100 条消息可达数十 KB，原 `-p <argv>` 会 spawn 超限。
 */
export function createOpus46Runner(deps: HaikuRunnerDeps = {}): HaikuRunner {
  return createClaudeCliRunner(OPUS_46_MODEL, deps)
}

/**
 * F027 收录设置 · 任意 claude model id 的通用 runner 工厂。
 * 小孙拍：wiki 编译模型可自由输入（新模型出了不必等代码更新白名单）——
 * 具名 4 工厂之外的 id 走本工厂按需构造；id 不存在时 CLI 非零退出（stderr 进 error），
 * 上层 fallback 链兜底。
 */
export function createClaudeModelRunner(
  model: string,
  deps: HaikuRunnerDeps = {},
  effort?: string,
): HaikuRunner {
  return createClaudeCliRunner(model, deps, effort)
}
