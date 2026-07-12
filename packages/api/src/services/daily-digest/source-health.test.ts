import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { beforeEach, describe, it } from "node:test"
import { createFileSourceHealthStore } from "./source-health"
import type { SourceFetchResult } from "./types"

function res(sourceId: string, status: SourceFetchResult["status"]): SourceFetchResult {
  return {
    sourceId,
    status,
    items: [],
    errors: status === "ok" ? [] : ["boom"],
    attempts: 1,
    fetchedAt: "t",
    durationMs: 1,
  }
}

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "f037-health-"))
})

describe("SourceHealthStore（AC8 持久化连续失败）", () => {
  it("record 落盘 + 连续 3 天失败 = 3", () => {
    const h = createFileSourceHealthStore(dir)
    h.record("2026-07-01", [res("espn", "failed")])
    h.record("2026-07-02", [res("espn", "timeout")])
    h.record("2026-07-03", [res("espn", "failed")])
    assert.equal(h.consecutiveFailures("espn", "2026-07-03"), 3)
  })

  it("中间一天 ok 归零截断", () => {
    const h = createFileSourceHealthStore(dir)
    h.record("2026-07-01", [res("espn", "failed")])
    h.record("2026-07-02", [res("espn", "ok")])
    h.record("2026-07-03", [res("espn", "failed")])
    assert.equal(h.consecutiveFailures("espn", "2026-07-03"), 1)
  })

  it("缺文件（未跑的日子）截断计数，不跨缺口累计", () => {
    const h = createFileSourceHealthStore(dir)
    h.record("2026-07-01", [res("espn", "failed")])
    h.record("2026-07-03", [res("espn", "failed")])
    assert.equal(h.consecutiveFailures("espn", "2026-07-03"), 1)
  })

  it("当天 ok = 0；重启后重建实例仍能读（持久化）", () => {
    const h1 = createFileSourceHealthStore(dir)
    h1.record("2026-07-03", [res("espn", "ok"), res("hltv", "failed")])
    const h2 = createFileSourceHealthStore(dir)
    assert.equal(h2.consecutiveFailures("espn", "2026-07-03"), 0)
    assert.equal(h2.consecutiveFailures("hltv", "2026-07-03"), 1)
  })

  it("同日重复 record 覆盖写", () => {
    const h = createFileSourceHealthStore(dir)
    h.record("2026-07-03", [res("espn", "failed")])
    h.record("2026-07-03", [res("espn", "ok")])
    assert.equal(h.consecutiveFailures("espn", "2026-07-03"), 0)
  })
})
