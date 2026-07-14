/**
 * F027 收录设置 · codex / gemini 单轮 prompt runner（wiki 编译用）
 *
 * 背景：小孙原话「你这样写 我这样就只能用claude了」——wiki 编译引擎放开为三家
 * （claude 走 haiku-runner 既有 CLI 链；本文件补 codex / gemini 两家适配器）。
 *
 * 调用形态（2026-06-13 实测 `--help` 落定，非脑补）：
 *   - codex:  `codex exec -s read-only --skip-git-repo-check [-m <model>]`，prompt 经 stdin
 *     （help 明示：无 PROMPT 参数时从 stdin 读；headers 走 stderr，stdout=最终消息）
 *   - gemini: `gemini --approval-mode plan -p "" [-m <model>]`，prompt 经 stdin
 *     （help 明示：-p 非交互 headless；stdin 内容拼接进输入；plan=只读模式）
 *   - 两家 prompt 一律 stdin（compile prompt 10-45KB，argv 会撞 Windows 32KB 上限，
 *     同 haiku-runner ENAMETOOLONG 教训）
 *   - model 留空 → 不传 -m → 该 CLI 自己的默认模型（小孙「新模型出了」的另一条退路）
 *
 * 契约与 HaikuRunner 一致（透明互换）：超时 kill / stdout trim / 失败四类编码。
 * 注意：codex/gemini 跑 compile 的 JSON 合格率未知（prompt 按 claude 调的）——schema
 * 失败走既有 3 次重试 + Haiku 4.5 fallback + stub 兜底，坏不了数据，log 可观测。
 */

import type { ChildProcess } from "node:child_process"
import { spawn as realSpawn } from "node:child_process"
import type { HaikuRunner, HaikuRunResult } from "./haiku-runner"

const DEFAULT_TIMEOUT_MS = 15000

type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: { shell?: boolean },
) => ChildProcess

export interface CliPromptRunnerDeps {
  spawn?: SpawnFn
  /** 模型 id；缺省 → 不传 -m，用 CLI 默认模型。 */
  model?: string
  /** 推理强度；缺省 → 不传，用 CLI 默认（补丁#3「codex 可选强度」）。 */
  effort?: string
  /** 超时终止钩子（测试注入）。默认在 createCliPromptRunner 内按平台绑定。 */
  killTree?: (proc: ChildProcess) => void
  /** 平台分流注入（测试两分支用）。缺省 = process.platform === "win32"。 */
  isWindows?: boolean
}

/**
 * 德彪 kb-ux2 r1+r2 P2 · 平台分流：
 *   - win32：codex/gemini 是 .cmd shim，必须 shell:true 走 cmd 解析；由此 proc 是
 *     cmd.exe 壳，proc.kill() 只杀壳——CLI（及其可能再起的原生子进程）孤儿化继续跑、
 *     继续占订阅额度 → 超时 taskkill /T /F 整树终止（对任意进程树结构成立）。
 *   - POSIX：bin 是普通可执行/链接，直接 exec（shell:false）——proc 即真子进程，
 *     kill 即生效；不引入 /bin/sh 壳层（sh 是否 exec 子命令依实现而定，不赌）。
 */
function winKillTree(proc: ChildProcess): void {
  if (proc.pid) {
    const tk = realSpawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"])
    tk.on("error", () => {}) // taskkill 自身失败不致命：runner 已按 timeout settle
  } else {
    proc.kill()
  }
}

function createCliPromptRunner(command: string, args: string[], deps: CliPromptRunnerDeps): HaikuRunner {
  const spawn = deps.spawn ?? (realSpawn as SpawnFn)
  const isWindows = deps.isWindows ?? process.platform === "win32"
  const killTree =
    deps.killTree ?? (isWindows ? winKillTree : (proc: ChildProcess) => proc.kill())

  return {
    runPrompt(prompt, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      // 调用方预算已取消时绝不再起 CLI 进程。
      if (opts.signal?.aborted) {
        return Promise.resolve({ ok: false, text: "", durationMs: 0, error: "aborted" })
      }
      const start = Date.now()
      // shell 仅 win32（解析 codex.cmd / gemini.cmd shim）；POSIX 直接 exec 免壳层
      const proc = spawn(command, args, { shell: isWindows })

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
          // settle 在前：测试/平台钩子若同步发 close，也不能覆盖 timeout 结果。
          try {
            killTree(proc)
          } catch {
            // 终止失败不改变 runner 已经 fail-closed 的 timeout 结果。
          }
        }, timeoutMs)

        const onAbort = () => {
          settle({ ok: false, text: "", durationMs: Date.now() - start, error: "aborted" })
          // Windows 下 proc 是 cmd 壳，必须整树终止，不能只杀壳留下 Codex 孤儿进程。
          try {
            killTree(proc)
          } catch {
            // 取消结果保持 aborted；终止钩子异常不得把调用方悬挂。
          }
        }
        opts.signal?.addEventListener("abort", onAbort, { once: true })
        // 覆盖 spawn 与 listener 注册之间的竞态窗口。
        if (opts.signal?.aborted) onAbort()

        proc.on("close", (code) => {
          const durationMs = Date.now() - start
          const text = stdout.trim()
          const stdinTail = stdinError ? ` stdin-error: ${stdinError}` : ""
          if (code !== 0) {
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

/** codex 单轮：read-only sandbox，prompt 走 stdin（codex exec 派审同款管道形态）。 */
export function createCodexPromptRunner(deps: CliPromptRunnerDeps = {}): HaikuRunner {
  const args = ["exec", "-s", "read-only", "--skip-git-repo-check"]
  if (deps.model?.trim()) args.push("-m", deps.model.trim())
  // 补丁#3（小孙「codex 可选强度」）：effort → `--config model_reasoning_effort="<value>"`
  // （同 codex-runtime 主链）。留空 → 不传 → CLI 默认强度。
  if (deps.effort?.trim()) {
    args.push("--config", `model_reasoning_effort="${deps.effort.trim()}"`)
  }
  return createCliPromptRunner("codex", args, deps)
}

/**
 * gemini 单轮：plan（只读）模式 headless，prompt 走 stdin（-p 空参触发非交互，stdin 拼接为输入）。
 * 德彪 r3 P2 · -p 空参按平台分形：win32 shell:true 经 cmd 解析，需字面 `""` 才落空参；
 * POSIX shell:false argv 直传，字面 `""` 是两个引号字符会污染 prompt → 传真空串。
 */
export function createGeminiPromptRunner(deps: CliPromptRunnerDeps = {}): HaikuRunner {
  const isWindows = deps.isWindows ?? process.platform === "win32"
  const args = ["--approval-mode", "plan", "-p", isWindows ? '""' : ""]
  if (deps.model?.trim()) args.push("-m", deps.model.trim())
  return createCliPromptRunner("gemini", args, deps)
}
