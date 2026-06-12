import { createHash } from "node:crypto"
import path from "node:path"

import type { ProcessRecord } from "./preview-state-types"

/**
 * F028 Task 2 · preview 控制面安全边界原语（AC6/AC9 守门）
 * 全部纯函数零 IO——realpath/进程表/端口探测等真 IO 由编排器层（Task 4/5）执行后
 * 把结果喂进来；本模块只做不可绕过的裁决。
 *
 * 设计决策锚：D7（pid+CreationDate 精确相等 + listener 后代链）、D10（allowed-origin
 * 白名单，非 Origin==Host）、D13（worktreeId slug ≤40）、r6 P2-3（NTFS ADS 拒 `:`）、
 * r5/r6（SQLITE_PATH 验父目录，DB 文件可不存在）。
 */

export class PreviewGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PreviewGuardError"
  }
}

export class NotOwnedError extends PreviewGuardError {
  constructor(message: string) {
    super(message)
    this.name = "NotOwnedError"
  }
}

const MAIN_API_PORT = 8787
const MAIN_WEB_PORT = 3000
const WORKTREE_API_BASE = 8800
const WORKTREE_WEB_BASE = 3100
/** 主 UI 固定 origin（r5：主 web dev 端口本 repo 恒为 3000，不从 CORS RegExp 推导） */
const MAIN_UI_ORIGIN = `http://localhost:${MAIN_WEB_PORT}`

/** AC6: 只允许 F024 registry 基址段的 worktree 端口；主库/系统端口一律拒 */
export function assertWorktreePort(port: number): void {
  if (!Number.isInteger(port) || port <= 0) {
    throw new PreviewGuardError(`invalid port: ${port}`)
  }
  if (port === MAIN_API_PORT || port === MAIN_WEB_PORT) {
    throw new PreviewGuardError(`port ${port} belongs to main dev stack — refuse to touch`)
  }
  const inApiRange = port >= WORKTREE_API_BASE
  const inWebRange = port >= WORKTREE_WEB_BASE && port < MAIN_API_PORT
  if (!inApiRange && !inWebRange) {
    throw new PreviewGuardError(`port ${port} outside worktree preview ranges (>=${WORKTREE_WEB_BASE}/${WORKTREE_API_BASE})`)
  }
}

/** AC6: name 必须命中 inventory（服务端单源解析）且非主仓 */
export function assertOperableWorktree<T extends { name: string; isMain: boolean }>(
  name: string,
  inventory: T[],
): T {
  const entry = inventory.find((e) => e.name === name)
  if (!entry) throw new PreviewGuardError(`worktree "${name}" not in inventory`)
  if (entry.isMain) throw new PreviewGuardError("main worktree is not operable")
  return entry
}

/** AC9/D7: 记录存在且 OS 实测 CreationDate 与落盘值精确相等（同源采集，无容差） */
export function assertOwnedProcess(
  rec: ProcessRecord | null,
  osCreationDate: string | null,
): void {
  if (!rec) throw new NotOwnedError("no process record on file")
  if (osCreationDate === null) throw new NotOwnedError(`pid ${rec.pid} not found in process table`)
  if (osCreationDate !== rec.creationDate) {
    throw new NotOwnedError(
      `pid ${rec.pid} CreationDate mismatch (recorded=${rec.creationDate} actual=${osCreationDate}) — likely PID reuse`,
    )
  }
}

export type CorsOriginConfig = string | RegExp | (string | RegExp)[]

/**
 * D10/r4 P1-2: 控制面精确 Origin 白名单——主 UI 固定 origin + registry webPort origins +
 * CORS 配置中的**字符串**成员。RegExp 成员不可枚举且默认形态放行任意 localhost 端口
 * （含 API 自身 :8800），控制面一律忽略之。
 */
export function resolveControlPlaneOrigins(
  corsOrigin: CorsOriginConfig,
  registryWebPorts: number[],
): Set<string> {
  const origins = new Set<string>([MAIN_UI_ORIGIN])
  for (const port of registryWebPorts) origins.add(`http://localhost:${port}`)
  const members = Array.isArray(corsOrigin) ? corsOrigin : [corsOrigin]
  for (const member of members) {
    if (typeof member === "string" && member.length > 0) origins.add(member)
  }
  return origins
}

/** AC6: Origin 头存在时必须精确命中白名单；无 Origin（curl/同进程）放行 */
export function assertAllowedOrigin(
  originHeader: string | undefined,
  allowedOrigins: Set<string>,
): void {
  if (originHeader === undefined) return
  if (!allowedOrigins.has(originHeader)) {
    throw new PreviewGuardError(`origin "${originHeader}" not in control-plane whitelist`)
  }
}

export type ProcessTableRow = { pid: number; ppid: number }

/** AC9/D7: listener 必须是记录 pid 的后代（ppid 链上溯，visited 防环） */
export function assertListenerDescendant(
  processTable: ProcessTableRow[],
  listenerPid: number,
  rootPid: number,
): void {
  const byPid = new Map(processTable.map((row) => [row.pid, row]))
  if (!byPid.has(listenerPid)) {
    throw new PreviewGuardError(`listener pid ${listenerPid} not in process table`)
  }
  const visited = new Set<number>()
  let current: number | undefined = listenerPid
  while (current !== undefined) {
    if (current === rootPid) return
    if (visited.has(current)) {
      throw new PreviewGuardError(`ppid chain cycle at pid ${current}`)
    }
    visited.add(current)
    current = byPid.get(current)?.ppid
  }
  throw new PreviewGuardError(
    `listener pid ${listenerPid} is not a descendant of recorded pid ${rootPid}`,
  )
}

/**
 * D13: 文件系统安全 worktreeId —— `(sanitize(name) || "wt").slice(0,31) + "-" + sha1[0:8]`
 * 总长 ≤40；`feat/a-b` 与 `feat-a/b` 同形不同哈希不碰撞。
 */
export function slugifyWorktreeId(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+|[-.]+$/g, "")
  const prefix = (sanitized || "wt").slice(0, 31)
  const hash = createHash("sha1").update(name, "utf8").digest("hex").slice(0, 8)
  return `${prefix}-${hash}`
}

function normalize(p: string): string {
  return path.resolve(p).replace(/\\/g, "/")
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}

/**
 * AC6/r5/r6: SQLITE_PATH 验**父目录**包含性（DB 文件首启可不存在）——
 * 父目录必须在 `<worktreeRoot>/.runtime/worktree-preview/` 内，整路径不得等于/落入
 * 任一主库数据路径。`..` 经 resolve 归一后再判。
 */
export function assertSqlitePathContained(
  sqlitePath: string,
  worktreeRoot: string,
  mainDataPaths: string[],
): void {
  const resolved = normalize(sqlitePath)
  const parent = normalize(path.dirname(resolved))
  const allowedBase = normalize(path.join(worktreeRoot, ".runtime", "worktree-preview"))
  if (!isWithin(parent, allowedBase)) {
    throw new PreviewGuardError(
      `SQLITE_PATH parent "${parent}" escapes worktree preview data base "${allowedBase}"`,
    )
  }
  for (const main of mainDataPaths) {
    const mainResolved = normalize(main)
    if (resolved === mainResolved || isWithin(resolved, mainResolved)) {
      throw new PreviewGuardError(`SQLITE_PATH "${resolved}" hits main data path "${mainResolved}"`)
    }
  }
}

/** r6 P2-3: 相对路径含 `:` = NTFS Alternate Data Stream 逃逸面，一律拒 */
export function assertPathNoAds(relPath: string): void {
  if (relPath.includes(":")) {
    throw new PreviewGuardError(`path "${relPath}" contains ":" (NTFS ADS rejected)`)
  }
}
