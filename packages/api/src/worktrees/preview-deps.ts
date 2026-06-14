import path from "node:path"

import type { PreviewEnv } from "@multi-agent/shared"

import { slugifyWorktreeId } from "./preview-guards"

/**
 * F028 Task 5 · 编排真实 deps 适配层（纯函数：解析 + 命令拼装，不跑真命令）
 *
 * - CIM CreationDate：ConvertTo-Json 序列化为 .NET "\/Date(epoch-ms)\/"（本机实测
 *   2026-06-11），提取整数 epoch-ms 串用于 D7 精确相等比较（同源采集同表示）。
 * - Windows spawn：pnpm 是 .cmd shim，默认 spawn 跑不动（Node 官方文档）；F024 用
 *   shell:true 但有 DEP0190 args-concat 注入面。本层用 **cmd.exe 固定字面量 args
 *   数组**（r6 P1-2 / r7 修订）：用户可控量只进 cwd/env 选项，命令行零插值。
 * - netstat listener pids 仅用于 foreign 检测/后代校验输入，**永不直接作为 kill 输入**。
 */

export type CimProcessRow = { pid: number; ppid: number; creationDate: string }

const DOTNET_DATE_RE = /\/Date\((\d+)\)\//

/** `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,CreationDate | ConvertTo-Json` */
export function parseCimProcessTable(stdout: string): CimProcessRow[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  const items = Array.isArray(parsed) ? parsed : [parsed] // 单条结果是裸对象
  const rows: CimProcessRow[] = []
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue
    const rec = item as Record<string, unknown>
    const pid = rec.ProcessId
    const ppid = rec.ParentProcessId
    const cd = rec.CreationDate
    if (typeof pid !== "number" || typeof ppid !== "number" || typeof cd !== "string") continue
    const m = DOTNET_DATE_RE.exec(cd)
    if (!m) continue
    rows.push({ pid, ppid, creationDate: m[1] })
  }
  return rows
}

/** taskkill 树杀固定参数（args 数组，无字符串拼接） */
export function buildTaskkillArgs(pid: number): string[] {
  return ["/PID", String(pid), "/T", "/F"]
}

export type SpawnSpec = {
  command: string
  args: string[]
  cwd: string
  detached: true
  logPath: string
  env: Record<string, string>
}

/**
 * dev:api / dev:web spawn spec——win32 走 cmd.exe 固定字面量（防注入），posix 直调 pnpm；
 * env = baseEnv + buildPreviewEnv 注入（UI 路径零 .env* 写入，D9）；日志路径由 worktreeId
 * slug 构成（D13）。
 */
export function buildSpawnSpec(
  proc: "api" | "web",
  worktree: { name: string; path: string },
  previewEnv: PreviewEnv,
  opts: { platform: NodeJS.Platform | string; logDir: string; baseEnv: Record<string, string | undefined> },
): SpawnSpec {
  const script = proc === "api" ? "dev:api" : "dev:web"
  const isWindows = opts.platform === "win32"
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.baseEnv)) {
    if (v !== undefined) env[k] = v
  }
  Object.assign(env, previewEnv)
  return {
    command: isWindows ? "cmd.exe" : "pnpm",
    // 固定字面量——"pnpm dev:api"/"pnpm dev:web" 二选一，无任何外部输入参与命令行
    args: isWindows ? ["/d", "/s", "/c", `pnpm ${script}`] : [script],
    cwd: worktree.path,
    detached: true,
    logPath: path.join(opts.logDir, `${slugifyWorktreeId(worktree.name)}-${proc}.log`),
    env,
  }
}

/** netstat -ano 输出 → port → LISTENING pids（IPv4/IPv6 去重；非 LISTENING 行忽略） */
export function parsePortListeners(netstatStdout: string, ports: number[]): Map<number, number[]> {
  const wanted = new Set(ports)
  const result = new Map<number, Set<number>>()
  for (const port of ports) result.set(port, new Set())
  for (const line of netstatStdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    // TCP <local> <remote> LISTENING <pid>
    if (cols.length < 5 || cols[0] !== "TCP" || cols[3] !== "LISTENING") continue
    const local = cols[1]
    const portMatch = /:(\d+)$/.exec(local)
    if (!portMatch) continue
    const port = Number(portMatch[1])
    if (!wanted.has(port)) continue
    const pid = Number(cols[4])
    if (Number.isInteger(pid)) result.get(port)?.add(pid)
  }
  return new Map([...result.entries()].map(([port, pids]) => [port, [...pids]]))
}

export type WorkerSpec = { command: string; args: string[] }

export type WorkerSpawnInputs = {
  /** process.execPath（node 可执行文件绝对路径） */
  nodeExe: string
  /** <mainRoot>/node_modules/tsx/dist/cli.mjs（node 直跑，绕开 npx/.cmd shim） */
  tsxCliPath: string
  mainRoot: string
  registryPath: string
  worktreeName: string
}

/**
 * F024 跨进程 claim worker（stdout JSON = PortEntry）。
 * 德彪 r1 P1-1：npx 是 .cmd shim，曾迫使 shell:true → cmd.exe 重新解析整条命令行，
 * worktree 名里的 `&`/`^` 等元字符成注入面（AC6 禁 shell 拼接）。改 node 直跑
 * tsx cli.mjs：纯 args 数组、shell:false，名字只是普通 argv 字符串。
 */
export function buildClaimWorkerSpec(inputs: WorkerSpawnInputs): WorkerSpec {
  return {
    command: inputs.nodeExe,
    args: [
      inputs.tsxCliPath,
      path.join(inputs.mainRoot, "scripts", "worktree-port-registry-claim-worker.ts"),
      inputs.registryPath,
      inputs.worktreeName,
    ],
  }
}

/** F024 shutdown worker（registry 条目清理）；同 claim 的 node 直跑形态（API 路径暂无调用方，保持合同一致） */
export function buildShutdownWorkerSpec(inputs: WorkerSpawnInputs): WorkerSpec {
  return {
    command: inputs.nodeExe,
    args: [
      inputs.tsxCliPath,
      path.join(inputs.mainRoot, "scripts", "worktree-preview-shutdown-worker.ts"),
      inputs.registryPath,
      inputs.worktreeName,
    ],
  }
}

/**
 * F028 续作 AC12 · 纯 registry 条目释放 worker spec（清理收口）。同 claim 的 node 直跑、
 * shell:false 形态——只 releasePorts，不碰进程（与 shutdown-worker 的 shutdownPreview 区分，
 * UI 清理的进程停止走 orchestrator.stop，绝不在此重抄 kill）。
 */
export function buildReleaseWorkerSpec(inputs: WorkerSpawnInputs): WorkerSpec {
  return {
    command: inputs.nodeExe,
    args: [
      inputs.tsxCliPath,
      path.join(inputs.mainRoot, "scripts", "worktree-port-registry-release-worker.ts"),
      inputs.registryPath,
      inputs.worktreeName,
    ],
  }
}

/**
 * 德彪 r1 P1-3：taskkill 幂等判定。本机实测（2026-06-13）：不存在 pid → exit 128 +
 * "ERROR: The process \"4194303\" not found."；access denied 等真失败 → exit 1。
 * 中文 Windows stderr 是本地化文案（OEM 编码），**只认 exit code 128，禁止匹配文案**。
 */
export function isTaskkillIdempotentMiss(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  return (err as { code?: unknown }).code === 128
}

/**
 * 德彪 r1 P2-1：spawn → unref 后所有权采集（CIM CreationDate）失败时，子进程活着
 * 却没有状态记录 = 不可管理的孤儿 preview。采集失败必须回收**自己刚 spawn 的 pid**
 * （记录在手，不违反"绝不按端口/名杀"）再抛；回收失败不掩盖采集错误。
 */
export async function captureSpawnOwnership(
  pid: number,
  io: {
    probeCreationDate: (pid: number) => Promise<string | null>
    killTree: (pid: number) => Promise<void>
  },
): Promise<string> {
  const creationDate = await io.probeCreationDate(pid)
  if (creationDate === null) {
    await io.killTree(pid).catch(() => {
      // 回收尽力而为：进程可能本来就死（幂等），或杀失败——都以采集错误为准
    })
    throw new Error(`spawned pid ${pid}: ownership capture failed (CIM query failed or process died) — reclaimed`)
  }
  return creationDate
}

export type ClaimParseResult =
  | { ok: true; entry: { worktreeName: string; apiPort: number; webPort: number } }
  | { ok: false; error: string }

export function parseClaimWorkerOutput(stdout: string): ClaimParseResult {
  try {
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>
    if (
      typeof parsed.worktreeName === "string" &&
      typeof parsed.apiPort === "number" &&
      typeof parsed.webPort === "number"
    ) {
      return {
        ok: true,
        entry: { worktreeName: parsed.worktreeName, apiPort: parsed.apiPort, webPort: parsed.webPort },
      }
    }
    return { ok: false, error: `claim worker output missing fields: ${stdout.slice(0, 120)}` }
  } catch {
    return { ok: false, error: `claim worker output not JSON: ${stdout.slice(0, 120)}` }
  }
}
