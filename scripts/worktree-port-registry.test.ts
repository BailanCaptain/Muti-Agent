import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { claimPorts, releasePorts } from "./worktree-port-registry"

type Entry = { worktreeName: string; apiPort: number; webPort: number }

const workerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "worktree-port-registry-claim-worker.ts",
)

function claimInChild(registryPath: string, worktreeName: string): Promise<Entry> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["--no-install", "tsx", workerPath, registryPath, worktreeName],
      { stdio: ["ignore", "pipe", "pipe"], shell: true },
    )
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claim worker exit ${code}: ${stderr}`))
        return
      }
      try {
        resolve(JSON.parse(stdout.trim()))
      } catch (err) {
        reject(new Error(`claim worker bad json: ${stdout} :: ${String(err)}`))
      }
    })
  })
}

test("F024 claimPorts allocates stable api/web ports per worktree", async () => {
  const registryPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "f024-ports-")),
    ".worktree-ports.json",
  )
  const first = await claimPorts(registryPath, "feat/F024")
  const second = await claimPorts(registryPath, "feat/F021")

  assert.equal(first.apiPort, 8800)
  assert.equal(first.webPort, 3100)
  assert.equal(second.apiPort, 8801)
  assert.equal(second.webPort, 3101)
})

test("F024 claimPorts is idempotent for the same worktree", async () => {
  const registryPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "f024-ports-")),
    ".worktree-ports.json",
  )
  const first = await claimPorts(registryPath, "feat/F024")
  const again = await claimPorts(registryPath, "feat/F024")
  assert.deepEqual(again, first)
})

test("F024 releasePorts removes claimed worktree entry", async () => {
  const registryPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "f024-ports-")),
    ".worktree-ports.json",
  )
  await claimPorts(registryPath, "feat/F024")
  await releasePorts(registryPath, "feat/F024")
  assert.equal(fs.readFileSync(registryPath, "utf8").includes("feat/F024"), false)
})

test("F024 claimPorts reuses released port slots", async () => {
  const registryPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "f024-ports-")),
    ".worktree-ports.json",
  )
  await claimPorts(registryPath, "feat/F024")
  const second = await claimPorts(registryPath, "feat/F021")
  await releasePorts(registryPath, "feat/F024")
  const third = await claimPorts(registryPath, "feat/F022")

  assert.equal(second.apiPort, 8801)
  assert.equal(third.apiPort, 8800)
  assert.equal(third.webPort, 3100)
})

test("F024 claimPorts holds a cross-process lock — concurrent claims never collide", async () => {
  const registryPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "f024-ports-race-")),
    ".worktree-ports.json",
  )
  const names = Array.from({ length: 6 }, (_, i) => `feat/F9${i}0`)
  const entries = await Promise.all(names.map((n) => claimInChild(registryPath, n)))
  const apiPorts = entries.map((e) => e.apiPort).sort((a, b) => a - b)
  const webPorts = entries.map((e) => e.webPort).sort((a, b) => a - b)
  assert.equal(
    new Set(apiPorts).size,
    names.length,
    `duplicate apiPorts across concurrent claims: ${JSON.stringify(apiPorts)}`,
  )
  assert.equal(
    new Set(webPorts).size,
    names.length,
    `duplicate webPorts across concurrent claims: ${JSON.stringify(webPorts)}`,
  )
  assert.deepEqual(apiPorts, [8800, 8801, 8802, 8803, 8804, 8805])
  assert.deepEqual(webPorts, [3100, 3101, 3102, 3103, 3104, 3105])
})
