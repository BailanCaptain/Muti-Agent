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

// F026 P1 Wiring · T5 post-final lockout (R-205+R-048 双发根因)
// LLM CLI sometimes re-emits its final answer via MCP `post_message` after
// the natural final has already been persisted. Prefix-dedup (T4) only catches
// verbatim resends; "美化重发" (whitespace/emoji edits) sneaks past it. The
// invocation registry now tracks finalEmittedAt so callbacks.ts can hard-noop
// any post_message arriving after the invocation has produced its final.

test("isFinalEmitted defaults to false for a fresh invocation", () => {
  const registry = new InvocationRegistry<{ cancel: () => void }>()
  const identity = registry.createInvocation("thread-1", "agent-1")

  assert.equal(registry.isFinalEmitted(identity.invocationId), false)
})

test("markFinalEmitted flips isFinalEmitted to true and persists across calls", () => {
  const registry = new InvocationRegistry<{ cancel: () => void }>()
  const identity = registry.createInvocation("thread-1", "agent-1")

  registry.markFinalEmitted(identity.invocationId)

  assert.equal(registry.isFinalEmitted(identity.invocationId), true)
  // Repeat-safe: marking twice should remain true (no throw, no flip).
  registry.markFinalEmitted(identity.invocationId)
  assert.equal(registry.isFinalEmitted(identity.invocationId), true)
})

test("isFinalEmitted returns false for unknown invocationId without throwing", () => {
  const registry = new InvocationRegistry<{ cancel: () => void }>()
  // No throw on unknown id; returns false so callers can treat as "not yet final".
  assert.equal(registry.isFinalEmitted("nonexistent"), false)
})

test("markFinalEmitted on unknown invocationId is a noop (does not throw)", () => {
  const registry = new InvocationRegistry<{ cancel: () => void }>()
  assert.doesNotThrow(() => registry.markFinalEmitted("nonexistent"))
  assert.equal(registry.isFinalEmitted("nonexistent"), false)
})

test("revokeInvocation clears finalEmitted state (cleanup invariant)", () => {
  const registry = new InvocationRegistry<{ cancel: () => void }>()
  const identity = registry.createInvocation("thread-1", "agent-1")

  registry.markFinalEmitted(identity.invocationId)
  assert.equal(registry.isFinalEmitted(identity.invocationId), true)

  registry.revokeInvocation(identity.invocationId)
  assert.equal(
    registry.isFinalEmitted(identity.invocationId),
    false,
    "Revoking an invocation must drop its finalEmitted flag along with the identity",
  )
})
