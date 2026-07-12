import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { beforeEach, describe, it } from "node:test"
import { createFileDigestLedger } from "./digest-ledger"

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "f037-ledger-"))
})

describe("DigestLedger（D10：attempted 计数 + sent 唯一终态）", () => {
  it("初始 read 为空", () => {
    const l = createFileDigestLedger(dir)
    const s = l.read("2026-07-03")
    assert.equal(s.attempts.length, 0)
    assert.equal(s.sent, null)
  })

  it("recordAttempt 递增且带 note", () => {
    const l = createFileDigestLedger(dir)
    l.recordAttempt("2026-07-03", "first")
    l.recordAttempt("2026-07-03", "retry_after_unknown(可能重复)")
    const s = l.read("2026-07-03")
    assert.equal(s.attempts.length, 2)
    assert.equal(s.attempts[1].note, "retry_after_unknown(可能重复)")
    assert.ok(s.attempts[0].at)
  })

  it("recordSent 后 sent 非空；重复 recordSent 幂等（保留首次）", () => {
    const l = createFileDigestLedger(dir)
    l.recordAttempt("2026-07-03", "first")
    l.recordSent("2026-07-03", { messageId: "m1", to: "a@b.c" })
    l.recordSent("2026-07-03", { messageId: "m2", to: "a@b.c" })
    const s = l.read("2026-07-03")
    assert.equal(s.sent?.messageId, "m1")
  })

  it("不同 businessDate 互不影响", () => {
    const l = createFileDigestLedger(dir)
    l.recordAttempt("2026-07-03", "first")
    assert.equal(l.read("2026-07-04").attempts.length, 0)
  })

  it("损坏 JSON → 视为空状态不抛（kill -9 容错）", () => {
    const l = createFileDigestLedger(dir)
    fs.mkdirSync(path.join(dir, "ledger"), { recursive: true })
    fs.writeFileSync(path.join(dir, "ledger", "2026-07-03.json"), "{broken")
    const s = l.read("2026-07-03")
    assert.equal(s.attempts.length, 0)
    assert.equal(s.sent, null)
  })

  it("写入原子：目录里无 tmp 残留", () => {
    const l = createFileDigestLedger(dir)
    l.recordAttempt("2026-07-03", "first")
    l.recordSent("2026-07-03", { messageId: "m", to: "a@b.c" })
    const files = fs.readdirSync(path.join(dir, "ledger"))
    assert.deepEqual(files, ["2026-07-03.json"])
  })
})
