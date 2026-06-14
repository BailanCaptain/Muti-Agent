import path from "node:path"

import {
  NotOwnedError,
  PreviewGuardError,
  assertListenerDescendant,
  assertOperableWorktree,
  assertOwnedProcess,
  assertSqlitePathContained,
  assertWorktreePort,
  slugifyWorktreeId,
  type ProcessTableRow,
} from "./preview-guards"
import type { PreviewStateStore } from "./preview-state"
import type { PreviewState, ProcessRecord } from "./preview-state-types"
import type { WorktreeInventoryEntry } from "./worktree-inventory"

/**
 * F028 Task 4 · preview 编排器（AC5/AC6/AC7/AC9/AC10）
 *
 * 控制面单实例前提（D12）：本编排器只在主 API 实例创建（WORKTREE_PREVIEW 门禁在
 * 路由层），内存单飞锁因此有效。
 *
 * kill 纪律（D7/AC9）：任何 kill 前必须完成预检三连——记录 pid CreationDate 同源
 * 精确相等 + 端口 listener 全员是记录 pid 后代 + 端口断言；restartAll 在首个 kill
 * 之前完成 api+web **双进程全量预检**（半杀禁止）。失败 → occupied-foreign，绝不
 * 按端口/进程名杀。
 */

export type PreviewActionOk = { ok: true; apiPort: number; webPort: number }
export type PreviewActionFail = {
  ok: false
  stage: "occupied-foreign" | "kill" | "spawn" | "ready-timeout" | "in-progress"
  message: string
}
export type PreviewActionResponse = PreviewActionOk | PreviewActionFail

export type SpawnedProc = { pid: number; creationDate: string; logPath: string }

export type OrchestratorDeps = {
  inventory: () => Promise<WorktreeInventoryEntry[]>
  store: PreviewStateStore
  probeCreationDate: (pid: number) => Promise<string | null>
  processTable: () => Promise<ProcessTableRow[]>
  /** port → 该端口上的 listener pids（仅用于后代校验/foreign 检测，永不直接作为 kill 输入） */
  portListeners: (ports: number[]) => Promise<Map<number, number[]>>
  killTree: (pid: number) => Promise<void>
  spawnProc: (
    proc: "api" | "web",
    worktree: { name: string; path: string },
    ports: { apiPort: number; webPort: number },
  ) => Promise<SpawnedProc>
  claimPorts: (worktreeName: string) => Promise<{ apiPort: number; webPort: number }>
  /** r5/r6: 先查既存祖先（拒 junction）→ mkdir 缺失段 → realpath；违规抛 */
  ensureSqliteDataDir: (worktreeRoot: string) => Promise<{ realDataDir: string }>
  mainDataPaths: string[]
  waitPortReady: (port: number, timeoutMs: number) => Promise<boolean>
  /** 德彪 r1 P1-3：杀后端口复探（plan 风险表）——true = 端口已清空可安全 spawn */
  waitPortFree: (port: number, timeoutMs: number) => Promise<boolean>
  readLogTail: (logPath: string, lines: number) => Promise<string[]>
  now: () => string
}

const READY_TIMEOUT_MS = 120_000
const KILL_FREE_TIMEOUT_MS = 15_000
const SQLITE_BASENAME = "multi-agent.sqlite"

export type PreviewOrchestrator = {
  compileBackend: (name: string) => Promise<PreviewActionResponse>
  restartAll: (name: string) => Promise<PreviewActionResponse>
  start: (name: string) => Promise<PreviewActionResponse>
  /** 续作 AC12/D16：停 preview（清理前置）。复用 D7 预检纪律，dead pid 幂等成功，foreign 不杀 */
  stop: (name: string) => Promise<PreviewActionResponse>
  /**
   * 续作 AC12（德彪 code-r1 P2-1）：在**每-worktree 互斥锁**下跑 cleanup body。与
   * compile/restart/start/stop 共用同一把锁——cleanup 期间 preview 操作一律 in-progress、
   * 反之亦然，杜绝"在正被删除的 worktree 里起进程"。锁被占 → 返回 onBusy()。
   * fn 收到**不加锁的 stop**（cleanup 已持锁，再走 public stop 会撞自身锁）。
   */
  withCleanupLock: <T>(
    name: string,
    onBusy: () => T,
    fn: (stopUnlocked: () => Promise<PreviewActionResponse>) => Promise<T>,
  ) => Promise<T>
  tailLog: (
    name: string,
    proc: "api" | "web",
    lines: number,
  ) => Promise<{ lines: string[]; logPath: string }>
}

export function createPreviewOrchestrator(deps: OrchestratorDeps): PreviewOrchestrator {
  const inFlight = new Set<string>()
  // 续作 AC12：cleanup 专用锁。与 inFlight 跨检 = cleanup 与 preview 操作互斥（德彪 code-r1 P2-1）
  const cleanupInFlight = new Set<string>()

  function fail(stage: PreviewActionFail["stage"], message: string): PreviewActionFail {
    return { ok: false, stage, message }
  }

  function mapError(err: unknown): PreviewActionFail {
    if (err instanceof NotOwnedError) return fail("occupied-foreign", err.message)
    if (err instanceof PreviewGuardError) return fail("kill", err.message)
    return fail("spawn", err instanceof Error ? err.message : String(err))
  }

  /** 单进程 kill 前预检：记录所有权（精确相等）+ listener 全员后代。无记录但有 listener = foreign。 */
  async function precheckProc(
    rec: ProcessRecord | null,
    port: number,
    table: ProcessTableRow[],
    listeners: number[],
  ): Promise<void> {
    if (!rec) {
      if (listeners.length > 0) {
        throw new NotOwnedError(`port ${port} occupied by unmanaged process(es) ${listeners.join(",")}`)
      }
      return
    }
    assertOwnedProcess(rec, await deps.probeCreationDate(rec.pid))
    for (const pid of listeners) {
      try {
        assertListenerDescendant(table, pid, rec.pid)
      } catch (err) {
        throw new NotOwnedError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  /**
   * 续作 AC12/D16 · stop 专用裁决（与 compile/restart 预检不同点：dead pid 是幂等 skip
   * 而非 foreign）。我方进程活着 + listener 全后代 → "kill"；记录进程已死/被复用且端口空
   * → "skip"（已停）；端口仍被非我方占（活进程非后代 / 死记录但端口有 listener）→ 抛
   * NotOwnedError（绝不按端口杀）。
   */
  async function stopVerdict(
    rec: ProcessRecord | null,
    port: number,
    table: ProcessTableRow[],
    listeners: number[],
  ): Promise<"kill" | "skip"> {
    if (!rec) {
      if (listeners.length > 0) {
        throw new NotOwnedError(`port ${port} occupied by unmanaged process(es) ${listeners.join(",")}`)
      }
      return "skip"
    }
    const actual = await deps.probeCreationDate(rec.pid)
    if (actual !== null && actual === rec.creationDate) {
      for (const pid of listeners) {
        try {
          assertListenerDescendant(table, pid, rec.pid)
        } catch (err) {
          throw new NotOwnedError(err instanceof Error ? err.message : String(err))
        }
      }
      return "kill"
    }
    // 记录的进程已死或被 PID 复用
    if (listeners.length > 0) {
      throw new NotOwnedError(
        `port ${port} occupied by non-owned process(es) ${listeners.join(",")} (recorded pid ${rec.pid} gone)`,
      )
    }
    return "skip"
  }

  async function withOperation(
    name: string,
    action: string,
    body: () => Promise<PreviewActionResponse>,
  ): Promise<PreviewActionResponse> {
    if (inFlight.has(name) || cleanupInFlight.has(name)) {
      const res = fail("in-progress", `operation already in progress for ${name}`)
      await deps.store.appendAudit({ action, worktree: name, ok: false, stage: res.stage, message: res.message })
      return res
    }
    inFlight.add(name)
    let result: PreviewActionResponse
    try {
      result = await body()
    } catch (err) {
      result = mapError(err)
    } finally {
      inFlight.delete(name)
    }
    await deps.store.appendAudit({
      action,
      worktree: name,
      ok: result.ok,
      ...(result.ok ? {} : { stage: result.stage, message: result.message }),
    })
    return result
  }

  async function resolvePorts(
    entry: WorktreeInventoryEntry,
    state: PreviewState | null,
  ): Promise<{ apiPort: number; webPort: number } | null> {
    if (state) return { apiPort: state.apiPort, webPort: state.webPort }
    if (entry.preview) return { apiPort: entry.preview.apiPort, webPort: entry.preview.webPort }
    return null
  }

  /**
   * 德彪 r1 P1-3：kill 真失败（access denied 等）传播为 stage:"kill"；杀后必须复探
   * 端口确认空（plan 风险表"杀后端口复探"）——旧 listener 残留会让后续 ready 检查
   * 立即真、UI 假报成功。任一步失败 → 不得 spawn。
   */
  async function killAndConfirmFree(
    proc: "api" | "web",
    pid: number,
    port: number,
    state: PreviewState,
  ): Promise<PreviewActionFail | null> {
    try {
      await deps.killTree(pid)
    } catch (err) {
      return fail(
        "kill",
        `taskkill pid ${pid} (${proc}) failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    state.processes[proc] = null
    await deps.store.writeState(state)
    if (!(await deps.waitPortFree(port, KILL_FREE_TIMEOUT_MS))) {
      return fail("kill", `port ${port} still occupied ${KILL_FREE_TIMEOUT_MS}ms after killing pid ${pid}`)
    }
    return null
  }

  async function spawnAndAwait(
    proc: "api" | "web",
    entry: WorktreeInventoryEntry,
    ports: { apiPort: number; webPort: number },
    state: PreviewState,
  ): Promise<PreviewActionResponse | null> {
    const spawned = await deps.spawnProc(proc, { name: entry.name, path: entry.path }, ports)
    const port = proc === "api" ? ports.apiPort : ports.webPort
    const ready = await deps.waitPortReady(port, READY_TIMEOUT_MS)
    if (!ready) {
      // 回收自己 spawn 的子进程：同源 CreationDate 验证后树杀（绝不杀别人）
      const actual = await deps.probeCreationDate(spawned.pid)
      if (actual !== null && actual === spawned.creationDate) {
        await deps.killTree(spawned.pid)
      }
      state.processes[proc] = null
      await deps.store.writeState(state)
      return fail("ready-timeout", `${proc} port ${port} not ready in ${READY_TIMEOUT_MS}ms`)
    }
    state.processes[proc] = {
      pid: spawned.pid,
      creationDate: spawned.creationDate,
      startedAt: deps.now(),
    }
    await deps.store.writeState(state)
    return null
  }

  function baseState(name: string, ports: { apiPort: number; webPort: number }): PreviewState {
    return {
      worktreeName: name,
      worktreeId: slugifyWorktreeId(name),
      apiPort: ports.apiPort,
      webPort: ports.webPort,
      processes: { api: null, web: null },
    }
  }

  /**
   * 停 preview 的实际逻辑（**不含锁**）。public `stop` 包 withOperation（inFlight）；
   * cleanup 路径已持 cleanupInFlight（互斥保证），直接调本函数避免与自身锁死（德彪 code-r1 P2-1）。
   */
  async function doStop(name: string): Promise<PreviewActionResponse> {
    const state = await deps.store.readState(name)
    const inventory = await deps.inventory()
    const entry = inventory.find((e) => e.name === name) ?? null
    const ports = state
      ? { apiPort: state.apiPort, webPort: state.webPort }
      : entry?.preview
        ? { apiPort: entry.preview.apiPort, webPort: entry.preview.webPort }
        : null
    if (!ports) return { ok: true, apiPort: 0, webPort: 0 } // 无端口无状态 → 已停，幂等成功

    const [table, listeners] = await Promise.all([
      deps.processTable(),
      deps.portListeners([ports.apiPort, ports.webPort]),
    ])
    const apiRec = state?.processes.api ?? null
    const webRec = state?.processes.web ?? null
    // 双进程全量预检（半杀禁止）：任一 foreign 即抛，先于任何 kill
    const apiVerdict = await stopVerdict(apiRec, ports.apiPort, table, listeners.get(ports.apiPort) ?? [])
    const webVerdict = await stopVerdict(webRec, ports.webPort, table, listeners.get(ports.webPort) ?? [])

    const working = state ?? baseState(name, ports)
    for (const [proc, rec, port, verdict] of [
      ["api", apiRec, ports.apiPort, apiVerdict],
      ["web", webRec, ports.webPort, webVerdict],
    ] as const) {
      if (verdict === "kill" && rec) {
        const killFailure = await killAndConfirmFree(proc, rec.pid, port, working)
        if (killFailure) return killFailure
      } else if (rec) {
        working.processes[proc] = null // skip（已死/被复用）：清陈旧记录
        await deps.store.writeState(working)
      }
    }
    return { ok: true, apiPort: ports.apiPort, webPort: ports.webPort }
  }

  return {
    compileBackend: (name) =>
      withOperation(name, "compile-backend", async () => {
        const inventory = await deps.inventory()
        const entry = assertOperableWorktree(name, inventory)
        const state = await deps.store.readState(name)
        const ports = await resolvePorts(entry, state)
        if (!ports) return fail("spawn", "no ports allocated — use start instead")
        assertWorktreePort(ports.apiPort)
        assertWorktreePort(ports.webPort)

        const [table, listeners] = await Promise.all([
          deps.processTable(),
          deps.portListeners([ports.apiPort]),
        ])
        const apiRec = state?.processes.api ?? null
        await precheckProc(apiRec, ports.apiPort, table, listeners.get(ports.apiPort) ?? [])

        const working = state ?? baseState(name, ports)
        if (apiRec) {
          const killFailure = await killAndConfirmFree("api", apiRec.pid, ports.apiPort, working)
          if (killFailure) return killFailure
        }
        const failure = await spawnAndAwait("api", entry, ports, working)
        if (failure) return failure
        return { ok: true, apiPort: ports.apiPort, webPort: ports.webPort }
      }),

    restartAll: (name) =>
      withOperation(name, "restart", async () => {
        const inventory = await deps.inventory()
        const entry = assertOperableWorktree(name, inventory)
        const state = await deps.store.readState(name)
        const ports = await resolvePorts(entry, state)
        if (!ports) return fail("spawn", "no ports allocated — use start instead")
        assertWorktreePort(ports.apiPort)
        assertWorktreePort(ports.webPort)

        const [table, listeners] = await Promise.all([
          deps.processTable(),
          deps.portListeners([ports.apiPort, ports.webPort]),
        ])
        const apiRec = state?.processes.api ?? null
        const webRec = state?.processes.web ?? null
        // 双进程全量预检完成后才允许首杀（半杀禁止）
        await precheckProc(apiRec, ports.apiPort, table, listeners.get(ports.apiPort) ?? [])
        await precheckProc(webRec, ports.webPort, table, listeners.get(ports.webPort) ?? [])

        const working = state ?? baseState(name, ports)
        for (const [proc, rec, port] of [
          ["api", apiRec, ports.apiPort],
          ["web", webRec, ports.webPort],
        ] as const) {
          if (rec) {
            const killFailure = await killAndConfirmFree(proc, rec.pid, port, working)
            if (killFailure) return killFailure
          }
        }
        for (const proc of ["api", "web"] as const) {
          const failure = await spawnAndAwait(proc, entry, ports, working)
          if (failure) return failure
        }
        return { ok: true, apiPort: ports.apiPort, webPort: ports.webPort }
      }),

    start: (name) =>
      withOperation(name, "start", async () => {
        const inventory = await deps.inventory()
        const entry = assertOperableWorktree(name, inventory)
        if (entry.preview && entry.preview.ownership === "ui" && (entry.preview.apiAlive || entry.preview.webAlive)) {
          return fail("spawn", `worktree ${name} preview already running`)
        }
        const ports = entry.preview
          ? { apiPort: entry.preview.apiPort, webPort: entry.preview.webPort }
          : await deps.claimPorts(name)
        assertWorktreePort(ports.apiPort)
        assertWorktreePort(ports.webPort)

        // r4 P1-1: start 前双端口 foreign 探测——start 语义下不应有任何属于我们的 listener
        const listeners = await deps.portListeners([ports.apiPort, ports.webPort])
        const occupied = [...listeners.entries()].filter(([, pids]) => pids.length > 0)
        if (occupied.length > 0) {
          return fail(
            "occupied-foreign",
            `port(s) ${occupied.map(([p]) => p).join(",")} already occupied by unmanaged process(es)`,
          )
        }

        // r5/r6: 先查祖先后建目录 + realpath，再做 SQLITE_PATH 包含断言（验父目录，DB 文件可不存在）
        const { realDataDir } = await deps.ensureSqliteDataDir(entry.path)
        const sqlitePath = path.join(realDataDir, SQLITE_BASENAME)
        assertSqlitePathContained(sqlitePath, entry.path, deps.mainDataPaths)

        const working = baseState(name, ports)
        await deps.store.writeState(working)
        for (const proc of ["api", "web"] as const) {
          const failure = await spawnAndAwait(proc, entry, ports, working)
          if (failure) return failure
        }
        return { ok: true, apiPort: ports.apiPort, webPort: ports.webPort }
      }),

    stop: (name) => withOperation(name, "stop", () => doStop(name)),

    async withCleanupLock(name, onBusy, fn) {
      // 与 preview 操作（inFlight）跨检：任一占用 → onBusy（杜绝在被删 worktree 里起进程）。
      if (inFlight.has(name) || cleanupInFlight.has(name)) return onBusy()
      cleanupInFlight.add(name)
      try {
        // fn 拿到**不加锁的 stop**——cleanupInFlight 已保证互斥，再走 withOperation 会撞自身锁
        return await fn(() => doStop(name))
      } finally {
        cleanupInFlight.delete(name)
      }
    },

    tailLog: async (name, proc, lines) => {
      const logPath = path.join(deps.store.baseDir, `${slugifyWorktreeId(name)}-${proc}.log`)
      return { lines: await deps.readLogTail(logPath, lines), logPath }
    },
  }
}
