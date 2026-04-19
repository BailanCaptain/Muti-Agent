import fs from "node:fs"
import path from "node:path"

import lockfile from "proper-lockfile"

// Concurrency model (F024 review P2, escalated 2026-04-20): multi-feature parallel
// development means two worktrees may call `pnpm preview` in the same tick. The
// registry file is the read-modify-write target, so we wrap every claim/release
// in `proper-lockfile.lock()` — atomic mkdir-based locking that works across
// Node processes on Windows/macOS/Linux. `stale: 10s` auto-releases if a holder
// crashes before releasing; retries back off up to 2s so worst-case 6 concurrent
// claims serialize in well under a second per claim on a warm FS.

export type PortEntry = {
  worktreeName: string
  apiPort: number
  webPort: number
}

type Registry = {
  entries: PortEntry[]
}

const API_PORT_BASE = 8800
const WEB_PORT_BASE = 3100

function readRegistry(registryPath: string): Registry {
  if (!fs.existsSync(registryPath)) return { entries: [] }
  const raw = fs.readFileSync(registryPath, "utf8")
  if (!raw.trim()) return { entries: [] }
  const parsed = JSON.parse(raw) as Registry
  if (!Array.isArray(parsed.entries)) return { entries: [] }
  return parsed
}

function writeRegistry(registryPath: string, registry: Registry): void {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true })
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`)
}

function ensureRegistryFile(registryPath: string): void {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true })
  if (!fs.existsSync(registryPath)) {
    fs.writeFileSync(registryPath, `${JSON.stringify({ entries: [] }, null, 2)}\n`)
  }
}

async function withLock<T>(registryPath: string, fn: () => T): Promise<T> {
  ensureRegistryFile(registryPath)
  const release = await lockfile.lock(registryPath, {
    realpath: false,
    stale: 10_000,
    retries: { retries: 40, minTimeout: 20, maxTimeout: 200, factor: 1.5 },
  })
  try {
    return fn()
  } finally {
    await release()
  }
}

function nextFreePort(base: number, used: Set<number>): number {
  let port = base
  while (used.has(port)) port++
  return port
}

export async function claimPorts(
  registryPath: string,
  worktreeName: string,
): Promise<PortEntry> {
  return withLock(registryPath, () => {
    const registry = readRegistry(registryPath)
    const existing = registry.entries.find((e) => e.worktreeName === worktreeName)
    if (existing) return existing

    const apiPort = nextFreePort(
      API_PORT_BASE,
      new Set(registry.entries.map((e) => e.apiPort)),
    )
    const webPort = nextFreePort(
      WEB_PORT_BASE,
      new Set(registry.entries.map((e) => e.webPort)),
    )
    const entry: PortEntry = { worktreeName, apiPort, webPort }
    registry.entries.push(entry)
    writeRegistry(registryPath, registry)
    return entry
  })
}

export async function releasePorts(
  registryPath: string,
  worktreeName: string,
): Promise<void> {
  await withLock(registryPath, () => {
    const registry = readRegistry(registryPath)
    registry.entries = registry.entries.filter((e) => e.worktreeName !== worktreeName)
    writeRegistry(registryPath, registry)
  })
}
