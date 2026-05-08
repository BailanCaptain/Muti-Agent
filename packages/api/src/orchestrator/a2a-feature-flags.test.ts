import assert from "node:assert/strict"
import test from "node:test"
import {
  A2A_PAYLOAD_MAX_TOKENS_DEFAULT,
  A2A_PAYLOAD_MAX_TOKENS_ENV,
  A2A_PAYLOAD_MAX_TOKENS_MAX,
  A2A_PAYLOAD_MAX_TOKENS_MIN,
  getA2APayloadMaxTokens,
} from "./a2a-feature-flags"

test("F026 P3 · A2A_PAYLOAD_MAX_TOKENS defaults to 16384 when unset", () => {
  const env = { ...process.env }
  delete env[A2A_PAYLOAD_MAX_TOKENS_ENV]
  assert.equal(getA2APayloadMaxTokens(env), A2A_PAYLOAD_MAX_TOKENS_DEFAULT)
  assert.equal(A2A_PAYLOAD_MAX_TOKENS_DEFAULT, 16384)
})

test("F026 P3 · A2A_PAYLOAD_MAX_TOKENS clamps to default when out of [4096, 65536]", () => {
  assert.equal(A2A_PAYLOAD_MAX_TOKENS_MIN, 4096)
  assert.equal(A2A_PAYLOAD_MAX_TOKENS_MAX, 65536)
  assert.equal(
    getA2APayloadMaxTokens({ [A2A_PAYLOAD_MAX_TOKENS_ENV]: "100" }),
    A2A_PAYLOAD_MAX_TOKENS_DEFAULT,
  )
  assert.equal(
    getA2APayloadMaxTokens({ [A2A_PAYLOAD_MAX_TOKENS_ENV]: "100000" }),
    A2A_PAYLOAD_MAX_TOKENS_DEFAULT,
  )
  assert.equal(
    getA2APayloadMaxTokens({ [A2A_PAYLOAD_MAX_TOKENS_ENV]: "0" }),
    A2A_PAYLOAD_MAX_TOKENS_DEFAULT,
  )
  assert.equal(
    getA2APayloadMaxTokens({ [A2A_PAYLOAD_MAX_TOKENS_ENV]: "-5" }),
    A2A_PAYLOAD_MAX_TOKENS_DEFAULT,
  )
  assert.equal(
    getA2APayloadMaxTokens({ [A2A_PAYLOAD_MAX_TOKENS_ENV]: "abc" }),
    A2A_PAYLOAD_MAX_TOKENS_DEFAULT,
  )
})

test("F026 P3 · A2A_PAYLOAD_MAX_TOKENS accepts boundary values 4096 and 65536", () => {
  assert.equal(getA2APayloadMaxTokens({ [A2A_PAYLOAD_MAX_TOKENS_ENV]: "4096" }), 4096)
  assert.equal(getA2APayloadMaxTokens({ [A2A_PAYLOAD_MAX_TOKENS_ENV]: "65536" }), 65536)
  assert.equal(getA2APayloadMaxTokens({ [A2A_PAYLOAD_MAX_TOKENS_ENV]: "32768" }), 32768)
})

test("F026 P3 · A2A_PAYLOAD_MAX_TOKENS hot-reload — 每次调用读 env，不缓存", () => {
  const env: NodeJS.ProcessEnv = { [A2A_PAYLOAD_MAX_TOKENS_ENV]: "8192" }
  assert.equal(getA2APayloadMaxTokens(env), 8192)
  env[A2A_PAYLOAD_MAX_TOKENS_ENV] = "16384"
  assert.equal(getA2APayloadMaxTokens(env), 16384)
  env[A2A_PAYLOAD_MAX_TOKENS_ENV] = "4096"
  assert.equal(getA2APayloadMaxTokens(env), 4096)
})
