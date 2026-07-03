import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig, devices } from "@playwright/test"
import { buildE2eEnv } from "./packages/shared/src/e2e-env"

/**
 * F038 · 前端 E2E harness（单一真相源）
 *
 * `pnpm test:e2e` 自动起隔离 API + Web，跑完自动杀，无需手动管 server。
 *
 * 隔离面（Iron Law 1 + 德彪设计审 r1 P1-1/P1-2）：
 * - 数据全落 os.tmpdir() 一次性目录（SQLITE/uploads/runtime-events/wiki-root），
 *   API 冷启动 CREATE TABLE IF NOT EXISTS 自建 schema，主库/preview 库零接触
 * - scheduler / docs-watcher / wiki reindex 全关（buildE2eEnv 注入 kill-switch env）
 * - API 命令刻意不用 `pnpm dev:api`：无 tsx watch（Windows tree-kill 残留面）、
 *   无 mount-skills --prune 副作用；shared 构建单独前置
 * - reuseExistingServer: false — 端口 ready ≠ 是本轮 temp DB 的 server，
 *   复用会把断言写进别人的库（fail-closed：端口被占直接报错，用 env 换端口）
 *
 * 端口纪律：默认 3999/8999，避开主库 :3000/:8787 与 F024 preview 段 :3100+/:8800+；
 * 并行跑（多 worktree）用 E2E_WEB_PORT / E2E_API_PORT 错开。
 */

const webPort = Number(process.env.E2E_WEB_PORT ?? 3999)
const apiPort = Number(process.env.E2E_API_PORT ?? 8999)

// 每次 config 求值各建一个 temp 目录；只有主进程那份被 webServer 使用，
// 其余为空目录靠 OS 临时区回收。teardown 不强删——Windows 下被杀进程可能短暂持
// WAL 锁，清理失败不应把测试判红（best-effort，见德彪 r1 P2-1）。
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-e2e-"))
const env = buildE2eEnv({ apiPort, webPort, runRoot })

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results",
  timeout: 60_000,
  // golden rules: retries CI=2 本地=0；trace 只在重试时采集
  retries: process.env.CI ? 2 : 0,
  // 种子用例含「新建会话」这类全局态交互，串行跑消除 test 间干扰
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${webPort}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // shared 先物化 dist（API 以 package main=dist 解析），再一次性 tsx 起 API
      command: "pnpm exec tsc -p packages/shared/tsconfig.json && pnpm exec tsx packages/api/src/index.ts",
      url: `http://localhost:${apiPort}/api/bootstrap`,
      reuseExistingServer: false,
      timeout: 180_000,
      env,
    },
    {
      command: `pnpm exec next dev --port ${webPort}`,
      url: `http://localhost:${webPort}`,
      reuseExistingServer: false,
      timeout: 180_000,
      env,
    },
  ],
})
