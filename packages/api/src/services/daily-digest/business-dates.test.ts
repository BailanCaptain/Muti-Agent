import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  formatBusinessDate,
  isFirstOfMonthInTz,
  isMondayInTz,
  prevBusinessDate,
} from "./business-dates"

describe("business-dates（Asia/Shanghai 语义）", () => {
  it("UTC 深夜跨日：UTC 23:00 = 上海次日 07:00", () => {
    assert.equal(formatBusinessDate(new Date("2026-07-02T23:00:00Z")), "2026-07-03")
  })
  it("prevBusinessDate 跨月", () => {
    assert.equal(prevBusinessDate("2026-07-01"), "2026-06-30")
    assert.equal(prevBusinessDate("2026-07-03", 3), "2026-06-30")
  })
  it("isMondayInTz：2026-07-06 是周一", () => {
    assert.equal(isMondayInTz(new Date("2026-07-06T00:30:00Z")), true)
    assert.equal(isMondayInTz(new Date("2026-07-03T00:30:00Z")), false)
  })
  it("isFirstOfMonthInTz：上海 1 号（含 UTC 前月末深夜）", () => {
    assert.equal(isFirstOfMonthInTz(new Date("2026-08-01T08:00:00+08:00")), true)
    assert.equal(isFirstOfMonthInTz(new Date("2026-07-31T17:00:00Z")), true) // 上海 08-01 01:00
    assert.equal(isFirstOfMonthInTz(new Date("2026-07-15T08:00:00+08:00")), false)
  })
})
