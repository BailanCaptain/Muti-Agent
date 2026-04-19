import { claimPorts } from "./worktree-port-registry"

const [, , registryPath, worktreeName] = process.argv
if (!registryPath || !worktreeName) {
  console.error("usage: claim-worker <registryPath> <worktreeName>")
  process.exit(2)
}

void (async () => {
  const entry = await claimPorts(registryPath, worktreeName)
  process.stdout.write(JSON.stringify(entry))
})()
