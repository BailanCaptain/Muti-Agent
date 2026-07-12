import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { beforeEach, describe, it } from "node:test"
import { loadShownKeys, shiftBusinessDate, writeShownLedger } from "./shown-ledger"

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "f037-shown-"))
})

describe("shiftBusinessDate", () => {
  it("跨月/跨年边界正确（UTC 日历语义）", () => {
    assert.equal(shiftBusinessDate("2026-07-07", -1), "2026-07-06")
    assert.equal(shiftBusinessDate("2026-07-01", -1), "2026-06-30")
    assert.equal(shiftBusinessDate("2026-01-01", -1), "2025-12-31")
    assert.equal(shiftBusinessDate("2026-03-01", -1), "2026-02-28")
  })
})

describe("shown-ledger（E1 跨日已见账本）", () => {
  it("写读回环：近 30 天并集，不含当日；键去重排序落盘", () => {
    writeShownLedger(dir, "2026-07-05", ["k1", "k2", "k1"])
    writeShownLedger(dir, "2026-07-06", ["k2", "k3"])
    writeShownLedger(dir, "2026-07-07", ["k-today"])
    const keys = loadShownKeys(dir, "2026-07-07")
    assert.deepEqual([...keys].sort(), ["k1", "k2", "k3"])
    assert.equal(keys.has("k-today"), false, "当日账本不参与（force 重发与首发一致）")
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, "2026-07-05", "shown.json"), "utf8"),
    ) as { keys: string[] }
    assert.deepEqual(onDisk.keys, ["k1", "k2"])
  })

  it("回看窗口边界：第 30 天算，第 31 天不算（P2-2：无日期条目唯一靠账本压回流）", () => {
    writeShownLedger(dir, "2026-06-07", ["in-window"]) // 07-07 往回第 30 天
    writeShownLedger(dir, "2026-06-06", ["out-of-window"]) // 第 31 天
    const keys = loadShownKeys(dir, "2026-07-07")
    assert.equal(keys.has("in-window"), true)
    assert.equal(keys.has("out-of-window"), false)
  })

  it("同日两次写=并集（P1-2：force 重发不覆盖首发已见）", () => {
    writeShownLedger(dir, "2026-07-07", ["a", "b"])
    writeShownLedger(dir, "2026-07-07", ["b", "c"])
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, "2026-07-07", "shown.json"), "utf8"),
    ) as { keys: string[] }
    assert.deepEqual(onDisk.keys, ["a", "b", "c"], "首发 {a,b} 与重发 {b,c} 都留住")
  })

  it("缺文件/坏 JSON/坏结构 fail-open 当无历史", () => {
    fs.mkdirSync(path.join(dir, "2026-07-06"), { recursive: true })
    fs.writeFileSync(path.join(dir, "2026-07-06", "shown.json"), "{oops")
    fs.mkdirSync(path.join(dir, "2026-07-05"), { recursive: true })
    fs.writeFileSync(
      path.join(dir, "2026-07-05", "shown.json"),
      JSON.stringify({ keys: [1, "good", null] }),
    )
    const keys = loadShownKeys(dir, "2026-07-07")
    assert.deepEqual([...keys], ["good"], "坏 JSON 跳过；keys 里非字符串逐个丢")
  })
})
