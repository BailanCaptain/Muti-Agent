import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { validatePort } from "./port-validator"

describe("validatePort", () => {
  it("allows a normal user port", () => {
    const result = validatePort(5173)
    assert.strictEqual(result.allowed, true)
  })

  it("rejects ports below 1024", () => {
    const result = validatePort(80)
    assert.strictEqual(result.allowed, false)
    assert.ok(result.reason?.includes("range"))
  })

  it("rejects ports above 65535", () => {
    const result = validatePort(70000)
    assert.strictEqual(result.allowed, false)
  })

  it("rejects NaN port", () => {
    const result = validatePort("abc")
    assert.strictEqual(result.allowed, false)
    assert.ok(result.reason?.includes("valid number"))
  })

  it("rejects non-loopback hosts", () => {
    const result = validatePort(5173, { host: "evil.com" })
    assert.strictEqual(result.allowed, false)
    assert.ok(result.reason?.includes("loopback"))
  })

  it("allows localhost", () => {
    const result = validatePort(5173, { host: "localhost" })
    assert.strictEqual(result.allowed, true)
  })

  it("allows 127.0.0.1", () => {
    const result = validatePort(5173, { host: "127.0.0.1" })
    assert.strictEqual(result.allowed, true)
  })

  it("allows ::1", () => {
    const result = validatePort(5173, { host: "::1" })
    assert.strictEqual(result.allowed, true)
  })

  it("rejects gateway self port (recursive proxy)", () => {
    const result = validatePort(9999, { gatewaySelfPort: 9999 })
    assert.strictEqual(result.allowed, false)
    assert.ok(result.reason?.includes("recursive"))
  })

  it("rejects excluded runtime ports", () => {
    const result = validatePort(6379, { runtimePorts: [6379] })
    assert.strictEqual(result.allowed, false)
    assert.ok(result.reason?.includes("excluded"))
  })

  it("rejects API server port (8787 default)", () => {
    const result = validatePort(8787)
    assert.strictEqual(result.allowed, false)
  })

  it("rejects frontend port (3000 default)", () => {
    const result = validatePort(3000)
    assert.strictEqual(result.allowed, false)
  })

  it("accepts string port that parses to valid number", () => {
    const result = validatePort("5173")
    assert.strictEqual(result.allowed, true)
  })
})
