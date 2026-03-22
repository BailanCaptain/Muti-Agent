import assert from "node:assert/strict"
import test from "node:test"
import { InvocationRegistry } from "./invocation-registry"

test("verifyInvocation fails immediately after invalidateInvocation is called", () => {
  const registry = new InvocationRegistry<{ cancel: () => void }>()
  const identity = registry.createInvocation("thread-1", "agent-1")

  registry.invalidateInvocation(identity.invocationId)

  const verified = registry.verifyInvocation(identity.invocationId, identity.callbackToken)
  assert.equal(verified, null, "Expected identity to be invalidated immediately")
})

test("revokeInvocation removes callback access while leaving the thread lock untouched", () => {
  const registry = new InvocationRegistry<{ cancel: () => void }>()
  const identity = registry.createInvocation("thread-1", "agent-1")
  const run = { cancel: () => {} }
  registry.attachRun("thread-1", identity.invocationId, run)

  registry.revokeInvocation(identity.invocationId)

  const verified = registry.verifyInvocation(identity.invocationId, identity.callbackToken)
  assert.equal(verified, null, "Expected callback identity to be revoked immediately")
  assert.equal(
    registry.has("thread-1"),
    true,
    "Revoking callback access must not clear the active run lock",
  )
})

test("createInvocation expires identities automatically after TTL even without callback traffic", async () => {
  const registry = new InvocationRegistry<{ cancel: () => void }>(5)
  const identity = registry.createInvocation("thread-1", "agent-1")

  await new Promise((resolve) => globalThis.setTimeout(resolve, 25))

  const verified = registry.verifyInvocation(identity.invocationId, identity.callbackToken)
  assert.equal(verified, null, "Expired identities should be removed automatically")
})
