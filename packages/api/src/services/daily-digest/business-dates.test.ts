import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  formatBusinessDate,
  isFirstOfMonthInTz,
  isMondayBusinessDate,
  isMondayInTz,
  isWeekendBusinessDate,
  prevBusinessDate,
  weekendRangeForMonday,
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

  it("业务日期星期判断：周末停发，周一映射到刚过去的周六/周日", () => {
    assert.equal(isWeekendBusinessDate("2026-07-25"), true)
    assert.equal(isWeekendBusinessDate("2026-07-26"), true)
    assert.equal(isWeekendBusinessDate("2026-07-27"), false)
    assert.equal(isMondayBusinessDate("2026-07-27"), true)
    assert.equal(isMondayBusinessDate("2026-07-28"), false)
    assert.deepEqual(weekendRangeForMonday("2026-07-27"), {
      start: "2026-07-25",
      end: "2026-07-26",
    })
    assert.equal(weekendRangeForMonday("2026-07-28"), null)
  })
})
