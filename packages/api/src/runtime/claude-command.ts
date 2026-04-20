import { existsSync } from "node:fs"
import path from "node:path"
import { resolveNpmRoot } from "./base-runtime"

export interface ClaudeCommandRuntime {
  command: string
  prefixArgs: string[]
  shell: boolean
}

/**
 * 解析本机 claude CLI 的执行入口。三种安装方式顺序：
 *   1. npm 全局安装 → `node <npmRoot>/node_modules/@anthropic-ai/claude-code/cli.js`
 *   2. PowerShell / standalone → `~/.local/bin/claude.exe`
 *   3. 兜底 shell mode → `claude`（shell=true，有 --append-system-prompt 换行截断风险）
 *
 * 被 ClaudeRuntime（多轮 stream-json）和 HaikuRunner（--print 单轮）共享。
 */
export function resolveClaudeCommand(): ClaudeCommandRuntime {
  const npmRoot = resolveNpmRoot()
  const cliJs = npmRoot
    ? path.join(npmRoot, "node_modules", "@anthropic-ai", "claude-code", "cli.js")
    : ""
  if (cliJs && existsSync(cliJs)) {
    return { command: process.execPath, prefixArgs: [cliJs], shell: false }
  }

  const homeDir = process.env.USERPROFILE || process.env.HOME || ""
  const standaloneExe = path.join(homeDir, ".local", "bin", "claude.exe")
  if (existsSync(standaloneExe)) {
    return { command: standaloneExe, prefixArgs: [], shell: false }
  }

  return { command: "claude", prefixArgs: [], shell: true }
}
