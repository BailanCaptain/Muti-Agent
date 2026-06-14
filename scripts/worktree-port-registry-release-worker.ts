import { releasePorts } from "./worktree-port-registry"

/**
 * F028 续作 AC12 · 纯 registry 条目释放 worker（清理收口用）。
 * 只做 releasePorts（proper-lockfile 串行），**不**碰进程/dotenv——UI 清理路径的
 * 进程停止由 orchestrator.stop 复用 D7 预检负责，绝不在此重抄 kill。
 * node 直跑 tsx（shell:false），worktreeName 只是普通 argv 字符串（AC6 禁 shell 拼接）。
 */
const [, , registryPath, worktreeName] = process.argv
if (!registryPath || !worktreeName) {
  console.error("usage: release-worker <registryPath> <worktreeName>")
  process.exit(2)
}

void (async () => {
  await releasePorts(registryPath, worktreeName)
  process.exit(0)
})()
