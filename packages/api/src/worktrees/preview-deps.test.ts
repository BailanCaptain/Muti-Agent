import assert from "node:assert/strict"
import { test } from "node:test"

import { buildPreviewEnv } from "@multi-agent/shared"

import {
  buildClaimWorkerSpec,
  buildShutdownWorkerSpec,
  buildSpawnSpec,
  buildTaskkillArgs,
  captureSpawnOwnership,
  isTaskkillIdempotentMiss,
  parseCimProcessTable,
  parseClaimWorkerOutput,
  parsePortListeners,
} from "./preview-deps"
import { slugifyWorktreeId } from "./preview-guards"

/**
 * F028 Task 5 · 编排真实 deps 适配层（plan v5 用例 1-6）
 * 全部纯函数（解析 + 命令拼装），fixture 来自本机实测（2026-06-11 取样）：
 * CIM CreationDate 序列化为 .NET "\/Date(epoch-ms)\/"，netstat -ano 五列。
 */

// (1) parseCimProcessTable — 真实 ConvertTo-Json 形态（单对象 + 数组 + 空）
test("F028 T5 · parseCimProcessTable extracts pid/ppid/epoch-ms from /Date()/ form", () => {
  const arrayJson = JSON.stringify([
    { ProcessId: 39288, ParentProcessId: 33404, CreationDate: "/Date(1781117591629)/" },
    { ProcessId: 100, ParentProcessId: 1, CreationDate: "/Date(1700000000100)/" },
  ])
  const rows = parseCimProcessTable(arrayJson)
  assert.deepEqual(rows, [
    { pid: 39288, ppid: 33404, creationDate: "1781117591629" },
    { pid: 100, ppid: 1, creationDate: "1700000000100" },
  ])

  // ConvertTo-Json 单条结果不是数组而是裸对象
  const singleJson = JSON.stringify({
    ProcessId: 7,
    ParentProcessId: 1,
    CreationDate: "\/Date(1781117591629)\/",
  })
  assert.deepEqual(parseCimProcessTable(singleJson), [
    { pid: 7, ppid: 1, creationDate: "1781117591629" },
  ])

  assert.deepEqual(parseCimProcessTable(""), [])
  assert.deepEqual(parseCimProcessTable("not json"), [])
  // CreationDate null（极少数受保护进程）→ 跳过该行不抛
  const withNull = JSON.stringify([{ ProcessId: 4, ParentProcessId: 0, CreationDate: null }])
  assert.deepEqual(parseCimProcessTable(withNull), [])
})

// (2) buildTaskkillArgs
test("F028 T5 · buildTaskkillArgs is a fixed args array", () => {
  assert.deepEqual(buildTaskkillArgs(1234), ["/PID", "1234", "/T", "/F"])
})

// (3) buildSpawnSpec — win32 cmd.exe 固定字面量 / posix 直调；cwd/detached/log/env
test("F028 T5 · buildSpawnSpec win32 uses fixed cmd.exe literal args", () => {
  const env = buildPreviewEnv({ repoRoot: "C:/repo/.worktrees/F028", worktreeName: "F028", apiPort: 8801, webPort: 3101 })
  const spec = buildSpawnSpec("api", { name: "F028", path: "C:/repo/.worktrees/F028" }, env, {
    platform: "win32",
    logDir: "C:/repo/.runtime/worktree-preview-ui",
    baseEnv: { PATH: "x" },
  })
  assert.equal(spec.command, "cmd.exe")
  assert.deepEqual(spec.args, ["/d", "/s", "/c", "pnpm dev:api"])
  assert.equal(spec.cwd, "C:/repo/.worktrees/F028")
  assert.equal(spec.detached, true)
  const id = slugifyWorktreeId("F028")
  assert.ok(spec.logPath.endsWith(`${id}-api.log`))
  assert.equal(spec.env.WORKTREE_PREVIEW, "1") // buildPreviewEnv 注入
  assert.equal(spec.env.API_PORT, "8801")
  assert.equal(spec.env.PATH, "x") // baseEnv 保留
})

test("F028 T5 · buildSpawnSpec posix invokes pnpm directly; web variant", () => {
  const env = buildPreviewEnv({ repoRoot: "/r/w", worktreeName: "w", apiPort: 8801, webPort: 3101 })
  const spec = buildSpawnSpec("web", { name: "feat/w", path: "/r/w" }, env, {
    platform: "linux",
    logDir: "/r/.runtime/worktree-preview-ui",
    baseEnv: {},
  })
  assert.equal(spec.command, "pnpm")
  assert.deepEqual(spec.args, ["dev:web"])
  assert.ok(spec.logPath.endsWith(`${slugifyWorktreeId("feat/w")}-web.log`))
  assert.ok(!spec.logPath.includes("feat/w"), "slug 路径不得含原始名")
})

// (4) parsePortListeners — netstat -ano 真格式（IPv4 + IPv6 + 非 LISTENING 行忽略）
test("F028 T5 · parsePortListeners extracts listener pids for given ports only", () => {
  const netstat = [
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1996",
    "  TCP    0.0.0.0:8801           0.0.0.0:0              LISTENING       4242",
    "  TCP    [::]:8801              [::]:0                 LISTENING       4242",
    "  TCP    127.0.0.1:3101         0.0.0.0:0              LISTENING       5151",
    "  TCP    127.0.0.1:8801         127.0.0.1:54321        ESTABLISHED     9999",
    "  UDP    0.0.0.0:5353           *:*                                    777",
  ].join("\r\n")
  const map = parsePortListeners(netstat, [8801, 3101, 9999])
  assert.deepEqual(map.get(8801), [4242]) // IPv4+IPv6 去重
  assert.deepEqual(map.get(3101), [5151])
  assert.deepEqual(map.get(9999), []) // 无 listener
})

// (5)(6) claim / shutdown worker specs + stdout 解析
// 德彪 r1 P1-1：废 npx .cmd shim（曾迫使 shell:true → cmd.exe 解析 worktree 名 = 注入面）。
// 改 node 可执行文件直跑 tsx cli.mjs（纯 args 数组，shell:false），元字符名当普通字符串。
test("F028 r1-P1-1 · worker specs: node direct, args array, no npx/shell", () => {
  const inputs = {
    nodeExe: "C:/nodejs/node.exe",
    tsxCliPath: "C:/repo/node_modules/tsx/dist/cli.mjs",
    mainRoot: "C:/repo",
    registryPath: "C:/repo/.worktree-ports.json",
    worktreeName: "F028&calc^|evil", // cmd 元字符必须只是普通字符串
  }
  const claim = buildClaimWorkerSpec(inputs)
  assert.equal(claim.command, "C:/nodejs/node.exe")
  assert.equal(claim.args[0], "C:/repo/node_modules/tsx/dist/cli.mjs")
  assert.ok(claim.args[1].replace(/\\/g, "/").endsWith("scripts/worktree-port-registry-claim-worker.ts"))
  assert.deepEqual(claim.args.slice(2), ["C:/repo/.worktree-ports.json", "F028&calc^|evil"])

  const shutdown = buildShutdownWorkerSpec(inputs)
  assert.equal(shutdown.command, "C:/nodejs/node.exe")
  assert.ok(shutdown.args[1].replace(/\\/g, "/").endsWith("scripts/worktree-preview-shutdown-worker.ts"))
  assert.deepEqual(shutdown.args.slice(2), ["C:/repo/.worktree-ports.json", "F028&calc^|evil"])

  const ok = parseClaimWorkerOutput('{"worktreeName":"F028","apiPort":8802,"webPort":3102}')
  assert.deepEqual(ok, { ok: true, entry: { worktreeName: "F028", apiPort: 8802, webPort: 3102 } })
  const bad = parseClaimWorkerOutput("boom not json")
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.ok(bad.error.length > 0)
})

// 德彪 r1 P1-3：taskkill 幂等判定——本机实测（2026-06-13）不存在 pid → exit 128 +
// "ERROR: The process \"4194303\" not found."；中文系统 stderr 本地化，**只认 exit code**。
// access denied 等真失败 → exit 1，必须向上传播。
test("F028 r1-P1-3 · isTaskkillIdempotentMiss: only exit 128 is idempotent", () => {
  assert.equal(isTaskkillIdempotentMiss({ code: 128 }), true)
  assert.equal(isTaskkillIdempotentMiss({ code: 1 }), false)
  assert.equal(isTaskkillIdempotentMiss({ code: 0 }), false)
  assert.equal(isTaskkillIdempotentMiss({ code: "ENOENT" }), false) // spawn errno ≠ exit code
  assert.equal(isTaskkillIdempotentMiss({}), false)
  assert.equal(isTaskkillIdempotentMiss(null), false)
})

// 德彪 r1 P2-1：spawn 后所有权采集失败（CIM 查询挂/进程瞬死二义）→ 回收自己刚
// spawn 的 pid 再抛，不留无状态记录的孤儿 preview
test("F028 r1-P2-1 · captureSpawnOwnership: CIM null → reclaim pid then throw", async () => {
  const killed: number[] = []
  await assert.rejects(
    () =>
      captureSpawnOwnership(4242, {
        probeCreationDate: async () => null,
        killTree: async (pid) => {
          killed.push(pid)
        },
      }),
    /ownership capture failed/,
  )
  assert.deepEqual(killed, [4242])
})

test("F028 r1-P2-1 · captureSpawnOwnership: success returns creationDate, zero kill", async () => {
  const killed: number[] = []
  const cd = await captureSpawnOwnership(4242, {
    probeCreationDate: async () => "1781117591629",
    killTree: async (pid) => {
      killed.push(pid)
    },
  })
  assert.equal(cd, "1781117591629")
  assert.deepEqual(killed, [])
})

test("F028 r1-P2-1 · captureSpawnOwnership: reclaim failure does not mask capture error", async () => {
  await assert.rejects(
    () =>
      captureSpawnOwnership(4242, {
        probeCreationDate: async () => null,
        killTree: async () => {
          throw new Error("kill blew up")
        },
      }),
    /ownership capture failed/,
  )
})
