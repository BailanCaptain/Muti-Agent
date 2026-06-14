import { execFile, spawn } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { promisify } from "node:util"

import { buildPreviewEnv } from "@multi-agent/shared"

import type { CorsOriginConfig } from "./preview-guards"
import { resolveControlPlaneOrigins } from "./preview-guards"
import {
  buildClaimWorkerSpec,
  buildReleaseWorkerSpec,
  buildSpawnSpec,
  buildTaskkillArgs,
  captureSpawnOwnership,
  isTaskkillIdempotentMiss,
  parseCimProcessTable,
  parseClaimWorkerOutput,
  parsePortListeners,
} from "./preview-deps"
import { createPreviewOrchestrator, type OrchestratorDeps, type PreviewOrchestrator } from "./preview-orchestrator"
import { createPreviewStateStore, reconcileOnBoot, type PreviewStateStore } from "./preview-state"
import { planArtifactRemoval, runWorktreeCleanup, type CleanupResult } from "./worktree-cleanup"
import { buildInventory, type WorktreeInventoryEntry } from "./worktree-inventory"
import { buildWorktreeSummary } from "./worktree-summary"
import type { ProjectTreeRoutesOpts } from "../routes/project-tree"
import type { WorktreeRoutesOpts } from "../routes/worktrees"

/**
 * F028 Task 7 · 组合根（真 IO 胶水）——纯逻辑全部在 inventory/guards/state/
 * orchestrator/deps 模块且已测；本文件只做接线，不含分支逻辑。
 *
 * 路径单源：registry 与状态目录恒挂**主仓根**（`git rev-parse --git-common-dir`
 * 在 worktree 内也解析到主仓 .git），preview 实例读同一份（plan v5 风险表）。
 */

const execFileAsync = promisify(execFile)

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true })
  return stdout
}

async function runPowerShellJson(script: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  )
  return stdout
}

async function resolveMainRepoRoot(cwd: string): Promise<string> {
  const commonDir = (await runGit(["rev-parse", "--git-common-dir"], cwd)).trim()
  const abs = path.isAbsolute(commonDir) ? commonDir : path.join(cwd, commonDir)
  return path.dirname(abs)
}

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port, timeout: 1200 })
    const done = (alive: boolean) => {
      socket.destroy()
      resolve(alive)
    }
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false))
    socket.once("error", () => done(false))
  })
}

async function probeCreationDate(pid: number): Promise<string | null> {
  try {
    const stdout = await runPowerShellJson(
      `Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}" | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json`,
    )
    return parseCimProcessTable(stdout)[0]?.creationDate ?? null
  } catch {
    return null
  }
}

async function processTable() {
  const stdout = await runPowerShellJson(
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json",
  )
  return parseCimProcessTable(stdout)
}

async function portListeners(ports: number[]): Promise<Map<number, number[]>> {
  const { stdout } = await execFileAsync("netstat", ["-ano"], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  return parsePortListeners(stdout, ports)
}

/** 德彪 r1 P1-3：exit 128（进程不存在，实测）= 幂等成功；其余（access denied 等）传播 */
async function killTree(pid: number): Promise<void> {
  try {
    await execFileAsync("taskkill", buildTaskkillArgs(pid), { windowsHide: true })
  } catch (err) {
    if (isTaskkillIdempotentMiss(err)) return
    throw err
  }
}

/** r5/r6 顺序：先逐级 lstat 既存祖先（拒 symlink/junction）→ mkdir 缺失段 → realpath */
async function ensureSqliteDataDir(worktreeRoot: string): Promise<{ realDataDir: string }> {
  const target = path.join(worktreeRoot, ".runtime", "worktree-preview", "data")
  const rootResolved = path.resolve(worktreeRoot)
  const segments = path.relative(rootResolved, target).split(path.sep)
  let current = rootResolved
  for (const seg of segments) {
    current = path.join(current, seg)
    let st: import("node:fs").Stats
    try {
      st = await fsp.lstat(current)
    } catch {
      break // 第一个不存在的段：其余由 mkdir 创建，无需再查
    }
    if (st.isSymbolicLink()) {
      throw new Error(`refusing: existing ancestor "${current}" is a symlink/junction`)
    }
  }
  await fsp.mkdir(target, { recursive: true })
  const realDataDir = await fsp.realpath(target)
  return { realDataDir }
}

async function readLogTail(logPath: string, lines: number): Promise<string[]> {
  try {
    const raw = await fsp.readFile(logPath, "utf8")
    const all = raw.split(/\r?\n/)
    while (all.length > 0 && all[all.length - 1] === "") all.pop()
    return all.slice(-lines)
  } catch {
    return []
  }
}

async function waitPortReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probePort(port)) return true
    await new Promise((r) => setTimeout(r, 1500))
  }
  return false
}

/** 德彪 r1 P1-3：杀后端口复探——connect 拒绝即视为已清空 */
async function waitPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await probePort(port))) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

export async function buildWorktreeRoutesOpts(input: {
  corsOrigin: CorsOriginConfig
}): Promise<WorktreeRoutesOpts & { projectTree: ProjectTreeRoutesOpts }> {
  const mainRoot = await resolveMainRepoRoot(process.cwd())
  const registryPath = path.join(mainRoot, ".worktree-ports.json")
  const stateBase = path.join(mainRoot, ".runtime", "worktree-preview-ui")
  const store: PreviewStateStore = createPreviewStateStore({
    baseDir: stateBase,
    now: () => new Date().toISOString(),
  })

  async function readRegistry(): Promise<Array<{ worktreeName: string; apiPort: number; webPort: number }>> {
    try {
      const raw = await fsp.readFile(registryPath, "utf8")
      const parsed = JSON.parse(raw) as { entries?: Array<{ worktreeName: string; apiPort: number; webPort: number }> }
      return Array.isArray(parsed.entries) ? parsed.entries : []
    } catch {
      return []
    }
  }

  const inventory = (): Promise<WorktreeInventoryEntry[]> =>
    buildInventory({
      execGitWorktreeList: () => runGit(["worktree", "list", "--porcelain"], mainRoot),
      readRegistry,
      probePort,
      readState: (name) => store.readState(name),
      probeCreationDate,
      baseRef: "dev",
      // AC11：在 worktree 路径下跑 git；非零退出 execFile 自动 reject 且 err.code=退出码
      execGitAt: (worktreePath, args) => runGit(args, worktreePath),
    })

  const orchestratorDeps: OrchestratorDeps = {
    inventory,
    store,
    probeCreationDate,
    processTable,
    portListeners,
    killTree,
    spawnProc: async (proc, worktree, ports) => {
      const previewEnv = buildPreviewEnv({
        repoRoot: worktree.path.replace(/\\/g, "/"),
        worktreeName: worktree.name,
        apiPort: ports.apiPort,
        webPort: ports.webPort,
      })
      const spec = buildSpawnSpec(proc, worktree, previewEnv, {
        platform: process.platform,
        logDir: stateBase,
        baseEnv: process.env,
      })
      await fsp.mkdir(path.dirname(spec.logPath), { recursive: true })
      const logFd = fs.openSync(spec.logPath, "a")
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        detached: spec.detached,
        windowsHide: true,
        stdio: ["ignore", logFd, logFd],
      })
      child.unref()
      fs.closeSync(logFd)
      const pid = child.pid
      if (!pid) throw new Error(`spawn ${proc} returned no pid`)
      // 同源采集（D7）：CreationDate 与后续预检走同一 CIM 查询源；
      // 德彪 r1 P2-1：采集失败回收自己刚 spawn 的 pid，不留无状态孤儿
      const creationDate = await captureSpawnOwnership(pid, { probeCreationDate, killTree })
      return { pid, creationDate, logPath: spec.logPath }
    },
    claimPorts: async (worktreeName) => {
      // 德彪 r1 P1-1：node 直跑 tsx cli.mjs（shell:false）——废 npx/.cmd shim 的
      // shell:true 注入面，worktree 名只是普通 argv 字符串
      const spec = buildClaimWorkerSpec({
        nodeExe: process.execPath,
        tsxCliPath: path.join(mainRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        mainRoot,
        registryPath,
        worktreeName,
      })
      const { stdout } = await execFileAsync(spec.command, spec.args, {
        cwd: mainRoot,
        windowsHide: true,
      })
      const parsed = parseClaimWorkerOutput(stdout)
      if (!parsed.ok) throw new Error(parsed.error)
      return { apiPort: parsed.entry.apiPort, webPort: parsed.entry.webPort }
    },
    ensureSqliteDataDir,
    mainDataPaths: [
      path.join(mainRoot, "data"),
      path.join(mainRoot, ".runtime"),
    ],
    waitPortReady,
    waitPortFree,
    readLogTail,
    now: () => new Date().toISOString(),
  }

  const orchestrator: PreviewOrchestrator = createPreviewOrchestrator(orchestratorDeps)

  const tsxCliPath = path.join(mainRoot, "node_modules", "tsx", "dist", "cli.mjs")

  // 续作 AC12 · 预删可再生构建产物：仅 node_modules + .next（planArtifactRemoval 白名单，避
  // Windows file-busy）。其余 worktree 自造数据由后续 git worktree remove 删。fs.rm force 只表
  // 示"不存在不报错"，非 git --force。
  async function rmArtifacts(worktreePath: string): Promise<string[]> {
    let entries: string[]
    try {
      entries = await fsp.readdir(worktreePath)
    } catch {
      return []
    }
    const removed: string[] = []
    for (const name of planArtifactRemoval(entries)) {
      try {
        await fsp.rm(path.join(worktreePath, name), { recursive: true, force: true })
        removed.push(name)
      } catch {
        // best-effort：后续 git worktree remove（无 --force）会兜底拒残留
      }
    }
    return removed
  }

  // 续作 AC12 · 清理走 orchestrator 的每-worktree 互斥锁（与 compile/restart/start/stop 共用，
  // 德彪 code-r1 P2-1：cleanup rm/remove 期间禁起 preview）。stopUnlocked 由锁注入避免自锁。
  const cleanup = (name: string): Promise<CleanupResult> =>
    orchestrator.withCleanupLock(
      name,
      () => ({ ok: false, steps: [{ name: "in-progress", ok: false, message: `操作进行中：${name}` }] }),
      (stopUnlocked) =>
        runWorktreeCleanup({
          name,
          inventory,
          execGitMain: (args) => runGit(args, mainRoot),
          execGitAt: (worktreePath, args) => runGit(args, worktreePath),
          // 德彪 code-r3 P1：**不**吞 readdir 失败——读不到目录不能伪装成"没有备份"
          // （那会 fail-open 让不可再生原配置进非原子删除路径）。让它 reject → 安全门 fail-closed。
          listEntries: (worktreePath) => fsp.readdir(worktreePath),
          stopPreview: () => stopUnlocked(),
          rmArtifacts,
          releasePorts: async (worktreeName) => {
            const spec = buildReleaseWorkerSpec({
              nodeExe: process.execPath,
              tsxCliPath,
              mainRoot,
              registryPath,
              worktreeName,
            })
            await execFileAsync(spec.command, spec.args, { cwd: mainRoot, windowsHide: true })
          },
          deleteState: (n) => store.deleteState(n),
          appendAudit: (e) => store.appendAudit(e),
        }),
    )

  return {
    controlEnabled: process.env.WORKTREE_PREVIEW !== "1",
    inventory,
    summary: (name, worktreePath) =>
      buildWorktreeSummary({
        worktreePath,
        baseRef: "dev",
        execGit: (args) => runGit(args, worktreePath),
      }),
    orchestrator,
    cleanup,
    allowedOrigins: async () => {
      const registry = await readRegistry()
      return resolveControlPlaneOrigins(
        input.corsOrigin,
        registry.map((e) => e.webPort),
      )
    },
    reconcile: () => reconcileOnBoot({ store, probeCreationDate }),
    // F028 Phase 2：项目目录路由共用同一 inventory 闭包与主仓根（单源）
    projectTree: { mainRepoRoot: mainRoot, inventory },
  }
}
