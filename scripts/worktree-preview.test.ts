import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { claimPorts } from "./worktree-port-registry"
import {
  buildDotenvContent,
  buildPreviewEnv,
  createShutdownController,
  formatPreviewBanner,
  prepareDotenv,
  restoreDotenv,
  shutdownPreview,
} from "./worktree-preview"

test("F024 buildPreviewEnv points sqlite to .runtime and evidence to .agents", () => {
  const env = buildPreviewEnv({
    repoRoot: "C:/repo",
    worktreeName: "feat/F024",
    apiPort: 8800,
    webPort: 3100,
  })

  assert.equal(env.SQLITE_PATH, "C:/repo/.runtime/worktree-preview/data/multi-agent.sqlite")
  assert.equal(env.UPLOADS_DIR, "C:/repo/.agents/acceptance/uploads")
  assert.equal(env.RUNTIME_EVENTS_DIR, "C:/repo/.agents/acceptance/runtime-events")
})

test("F024 buildPreviewEnv wires api/web ports and next public urls", () => {
  const env = buildPreviewEnv({
    repoRoot: "C:/repo",
    worktreeName: "feat/F024",
    apiPort: 8800,
    webPort: 3100,
  })

  assert.equal(env.API_PORT, "8800")
  assert.equal(env.PORT, "3100")
  assert.equal(env.NEXT_PUBLIC_API_HTTP_URL, "http://localhost:8800")
  assert.equal(env.NEXT_PUBLIC_API_WS_URL, "ws://localhost:8800/ws")
})

test("F024 buildPreviewEnv sets CORS_ORIGIN to the web port so API accepts preview web origin", () => {
  const env = buildPreviewEnv({
    repoRoot: "C:/repo",
    worktreeName: "feat/F024",
    apiPort: 8800,
    webPort: 3100,
  })

  assert.equal(env.CORS_ORIGIN, "http://localhost:3100")
})

test("F024 buildPreviewEnv injects NEXT_PUBLIC_APP_TITLE_PREFIX for tab recognition", () => {
  const env = buildPreviewEnv({
    repoRoot: "C:/repo",
    worktreeName: "feat/F024",
    apiPort: 8800,
    webPort: 3100,
  })

  assert.equal(env.NEXT_PUBLIC_APP_TITLE_PREFIX, "[feat/F024] ")
})

test("F024 buildDotenvContent emits only NEXT_PUBLIC_* for client bundle inline", () => {
  const env = buildPreviewEnv({
    repoRoot: "C:/repo",
    worktreeName: "feat/F024",
    apiPort: 8800,
    webPort: 3100,
  })
  const content = buildDotenvContent(env)

  assert.match(content, /^NEXT_PUBLIC_API_HTTP_URL="http:\/\/localhost:8800"$/m)
  assert.match(content, /^NEXT_PUBLIC_API_WS_URL="ws:\/\/localhost:8800\/ws"$/m)
  assert.match(content, /^NEXT_PUBLIC_APP_TITLE_PREFIX="\[feat\/F024\] "$/m)

  assert.doesNotMatch(content, /^SQLITE_PATH=/m)
  assert.doesNotMatch(content, /^UPLOADS_DIR=/m)
  assert.doesNotMatch(content, /^RUNTIME_EVENTS_DIR=/m)
  assert.doesNotMatch(content, /^API_PORT=/m)
  assert.doesNotMatch(content, /^PORT=/m)
})

test("F024 formatPreviewBanner prints the required preview line", () => {
  const text = formatPreviewBanner({
    worktreeName: "feat/F024",
    webPort: 3100,
    apiPort: 8800,
    tty: false,
  })
  assert.match(text, /worktree feat\/F024 preview: web=http:\/\/localhost:3100 api=http:\/\/localhost:8800/)
})

test("F024 formatPreviewBanner keeps the AC-1.3 key substring in TTY mode too", () => {
  const text = formatPreviewBanner({
    worktreeName: "feat/F024",
    webPort: 3100,
    apiPort: 8800,
    tty: true,
  })
  assert.ok(text.includes("worktree feat/F024 preview: localhost:3100"))
})

test("F024 buildPreviewEnv injects NEXT_PUBLIC_API_URL / NEXT_PUBLIC_API_BASE_URL aliases so UI does not fall back to main-repo 8787 (review P1-C)", () => {
  const env = buildPreviewEnv({
    repoRoot: "C:/repo",
    worktreeName: "feat/F024",
    apiPort: 8800,
    webPort: 3100,
  })

  assert.equal(env.NEXT_PUBLIC_API_URL, "http://localhost:8800")
  assert.equal(env.NEXT_PUBLIC_API_BASE_URL, "http://localhost:8800")
})

test("F024 buildDotenvContent emits every NEXT_PUBLIC_API_* alias referenced by UI (review P1-C)", () => {
  const env = buildPreviewEnv({
    repoRoot: "C:/repo",
    worktreeName: "feat/F024",
    apiPort: 8800,
    webPort: 3100,
  })
  const content = buildDotenvContent(env)

  assert.match(content, /^NEXT_PUBLIC_API_URL="http:\/\/localhost:8800"$/m)
  assert.match(content, /^NEXT_PUBLIC_API_BASE_URL="http:\/\/localhost:8800"$/m)
})

test("F024 prepareDotenv backs up a pre-existing .env.development.local before writing (review P1-A)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f024-preview-"))
  const target = path.join(dir, ".env.development.local")
  fs.writeFileSync(target, "USER_LOCAL_CONFIG=keepme\n")

  const handle = prepareDotenv(target, "NEW_PREVIEW_CONTENT=1\n")

  assert.ok(handle.backupPath, "expected a backup path when prior file existed")
  assert.equal(fs.readFileSync(handle.backupPath!, "utf8"), "USER_LOCAL_CONFIG=keepme\n")
  assert.equal(fs.readFileSync(target, "utf8"), "NEW_PREVIEW_CONTENT=1\n")

  fs.rmSync(dir, { recursive: true, force: true })
})

test("F024 restoreDotenv restores the backup on cleanup and does not silently delete user config (review P1-A)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f024-preview-"))
  const target = path.join(dir, ".env.development.local")
  fs.writeFileSync(target, "USER_LOCAL_CONFIG=keepme\n")

  const handle = prepareDotenv(target, "NEW_PREVIEW_CONTENT=1\n")
  restoreDotenv(handle)

  assert.equal(fs.readFileSync(target, "utf8"), "USER_LOCAL_CONFIG=keepme\n", "original content must be restored")
  assert.equal(fs.existsSync(handle.backupPath!), false, "backup file must be removed after restore")

  fs.rmSync(dir, { recursive: true, force: true })
})

test("F024 restoreDotenv removes the generated file when no prior file existed (review P1-A)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f024-preview-"))
  const target = path.join(dir, ".env.development.local")

  const handle = prepareDotenv(target, "NEW_PREVIEW_CONTENT=1\n")
  assert.equal(handle.backupPath, null)
  assert.equal(fs.existsSync(target), true)

  restoreDotenv(handle)

  assert.equal(fs.existsSync(target), false, "generated preview dotenv must be removed when no original existed")

  fs.rmSync(dir, { recursive: true, force: true })
})

test("F024 shutdownPreview's returned promise only resolves after releasePorts has landed (re-review P1)", async () => {
  const registryPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "f024-shutdown-")),
    ".worktree-ports.json",
  )
  await claimPorts(registryPath, "feat/F024")
  const killerCalls: string[] = []

  await shutdownPreview({
    registryPath,
    worktreeName: "feat/F024",
    dotenvHandle: null,
    killers: [() => killerCalls.push("api"), () => killerCalls.push("web")],
  })

  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
    entries: Array<{ worktreeName: string }>
  }
  assert.equal(
    registry.entries.length,
    0,
    "shutdownPreview must not resolve until releasePorts has actually written the registry",
  )
  assert.deepEqual(killerCalls, ["api", "web"], "all killers must run on shutdown")
})

test("F024 createShutdownController memoizes — racing SIGINT+SIGTERM releases ports and invokes killers exactly once (re-review follow-up)", async () => {
  const registryPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "f024-shutdown-idem-")),
    ".worktree-ports.json",
  )
  await claimPorts(registryPath, "feat/F024")
  const killerCalls: string[] = []

  const { triggerShutdown } = createShutdownController({
    registryPath,
    worktreeName: "feat/F024",
    dotenvHandle: null,
    killers: [() => killerCalls.push("api"), () => killerCalls.push("web")],
  })

  const p1 = triggerShutdown()
  const p2 = triggerShutdown()
  const p3 = triggerShutdown()
  assert.strictEqual(p1, p2, "triggerShutdown must return the same Promise on concurrent calls")
  assert.strictEqual(p2, p3, "triggerShutdown must return the same Promise on concurrent calls")
  await Promise.all([p1, p2, p3])

  assert.deepEqual(
    killerCalls,
    ["api", "web"],
    "killers must fire exactly once despite multiple shutdown triggers — no double-kill",
  )
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
    entries: Array<{ worktreeName: string }>
  }
  assert.equal(registry.entries.length, 0, "registry must be fully drained even when 3 signals race")
})

test("F024 onSignal wiring — SIGINT then SIGTERM drains registry and exits with 0 (re-review follow-up)", async () => {
  const registryPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "f024-onsignal-")),
    ".worktree-ports.json",
  )
  await claimPorts(registryPath, "feat/F024")

  const { triggerShutdown } = createShutdownController({
    registryPath,
    worktreeName: "feat/F024",
    dotenvHandle: null,
    killers: [],
  })
  const exitCalls: number[] = []
  const exitSpy = (code: number): void => {
    exitCalls.push(code)
  }
  // Mirrors main()'s onSignal wiring exactly (see worktree-preview.ts).
  const onSignal = (): void => {
    void triggerShutdown().finally(() => exitSpy(0))
  }

  onSignal() // SIGINT
  onSignal() // SIGTERM racing right behind
  await triggerShutdown()
  // Let both .finally chains drain.
  await new Promise((r) => setImmediate(r))

  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
    entries: Array<{ worktreeName: string }>
  }
  assert.equal(registry.entries.length, 0, "onSignal must drain registry before exiting")
  assert.ok(exitCalls.length >= 1, "exit must be invoked at least once")
  for (const code of exitCalls) {
    assert.equal(code, 0, "every exit call from onSignal must use code 0 (graceful)")
  }
})

test("F024 SIGINT-equivalent path truly releases the port entry — child exit flushes release (re-review P1)", async () => {
  const registryPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "f024-shutdown-race-")),
    ".worktree-ports.json",
  )
  const workerPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "worktree-preview-shutdown-worker.ts",
  )

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "npx",
      ["--no-install", "tsx", workerPath, registryPath, "feat/F024"],
      { stdio: ["ignore", "pipe", "pipe"], shell: true },
    )
    let stderr = ""
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`shutdown worker exit ${code}: ${stderr}`))
        return
      }
      resolve()
    })
  })

  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
    entries: Array<{ worktreeName: string }>
  }
  assert.equal(
    registry.entries.length,
    0,
    "after child process exits, the registry must contain zero zombie entries — otherwise Ctrl+C leaks port claims",
  )
})
