import { claimPorts } from "./worktree-port-registry"
import { shutdownPreview } from "./worktree-preview"

const [, , registryPath, worktreeName] = process.argv
if (!registryPath || !worktreeName) {
  console.error("usage: shutdown-worker <registryPath> <worktreeName>")
  process.exit(2)
}

void (async () => {
  await claimPorts(registryPath, worktreeName)
  await shutdownPreview({
    registryPath,
    worktreeName,
    dotenvHandle: null,
    killers: [],
  })
  process.exit(0)
})()
