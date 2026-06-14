/**
 * F027 收尾修1 · createDriftWarningsWriter 测试
 *
 * 覆盖 DriftDetectionResult → warning 文件（drift_alert）的映射：
 *   - 0 开 0 失败 → 不写（无 drift 不打扰，对齐 NHC 0-findings）
 *   - 开了 draft → drift_alert 文件 + frontmatter（source/generated_by=drift-detector）+ 标题列出条目
 *   - 有失败 → severity=critical + 失败区块列出 ref/error
 *   - 事件 path = wiki/warnings/drift-detector-<date>.md
 *   - leader term=null → 跳过事件，文件照写
 */

import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import {
  type DriftDetectionResult,
  type DriftTrigger,
  buildUpdateDraft,
} from "./drift-detector"
import { createDriftWarningsWriter } from "./drift-warnings-writer"

function makeRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "drift-warnings-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function makeEventsStub() {
  const appended: Array<Record<string, unknown>> = []
  const committed: number[] = []
  return {
    appended,
    committed,
    repo: {
      appendPending: (input: Record<string, unknown>) => {
        appended.push(input)
        return { id: 13 }
      },
      commit: (eventId: number) => {
        committed.push(eventId)
        return true
      },
    },
  }
}

const CLOCK = () => new Date("2026-06-14T10:00:00Z")
const STUB_LEADER = { currentLeaderTerm: () => "3", newFencingToken: () => "tok" }

function result(overrides: Partial<DriftDetectionResult> = {}): DriftDetectionResult {
  return {
    scannedAt: "2026-06-14T09:30:00Z",
    triggers: [],
    draftsOpened: [],
    failed: [],
    skippedDuplicate: 0,
    ...overrides,
  }
}

const T_LESSON: DriftTrigger = { kind: "new_lesson", ref: "LL-040", detail: "新教训" }
const T_HANDOFF: DriftTrigger = { kind: "handoff_failure", ref: "ho-9", detail: "交接失败" }

describe("createDriftWarningsWriter", () => {
  it("0 开 0 失败 → 不写文件（无 drift 不打扰）", async () => {
    const { root, cleanup } = makeRoot()
    try {
      const events = makeEventsStub()
      const write = createDriftWarningsWriter({
        wikiRoot: root,
        events: events.repo as never,
        leaderContext: STUB_LEADER,
        clock: CLOCK,
      })
      await write(result())
      assert.equal(existsSync(path.join(root, "warnings")), false, "无 drift 不该写文件")
      assert.equal(events.appended.length, 0)
    } finally {
      cleanup()
    }
  })

  it("开了 draft → drift_alert 文件 + frontmatter + 标题列条目 + 事件 path", async () => {
    const { root, cleanup } = makeRoot()
    try {
      const events = makeEventsStub()
      const write = createDriftWarningsWriter({
        wikiRoot: root,
        events: events.repo as never,
        leaderContext: STUB_LEADER,
        clock: CLOCK,
      })
      await write(result({ draftsOpened: [buildUpdateDraft(T_LESSON)] }))
      const file = path.join(root, "warnings", "drift-detector-2026-06-14.md")
      assert.ok(existsSync(file), "drift warning 文件应落盘")
      const c = readFileSync(file, "utf-8")
      assert.ok(c.includes("subtype: drift_alert"))
      assert.ok(c.includes("source: drift-detector"))
      assert.ok(c.includes("severity: warn"), "纯开 draft（无失败）→ warn")
      assert.ok(
        c.includes("generated_by: drift-detector"),
        "generated_by 防 NHC 回环（isDerivedView 豁免）",
      )
      assert.ok(c.includes("LL-040"), "正文应列出 draft 条目")
      assert.equal(events.appended.length, 1)
      assert.equal(events.appended[0]?.path, "wiki/warnings/drift-detector-2026-06-14.md")
      assert.equal(events.appended[0]?.alias, "drift-detector")
    } finally {
      cleanup()
    }
  })

  it("有失败 → severity=critical + 失败区块列 ref/error", async () => {
    const { root, cleanup } = makeRoot()
    try {
      const write = createDriftWarningsWriter({ wikiRoot: root, clock: CLOCK })
      await write(
        result({
          draftsOpened: [buildUpdateDraft(T_LESSON)],
          failed: [{ trigger: T_HANDOFF, error: "lease held" }],
        }),
      )
      const c = readFileSync(
        path.join(root, "warnings", "drift-detector-2026-06-14.md"),
        "utf-8",
      )
      assert.ok(c.includes("severity: critical"), "有失败 → critical")
      assert.ok(c.includes("ho-9"), "失败区块应列 ref")
      assert.ok(c.includes("lease held"), "失败区块应列 error")
    } finally {
      cleanup()
    }
  })

  it("纯失败（0 开 + failed>0）→ 也写 critical warning", async () => {
    const { root, cleanup } = makeRoot()
    try {
      const write = createDriftWarningsWriter({ wikiRoot: root, clock: CLOCK })
      await write(result({ failed: [{ trigger: T_HANDOFF, error: "boom" }] }))
      const c = readFileSync(
        path.join(root, "warnings", "drift-detector-2026-06-14.md"),
        "utf-8",
      )
      assert.ok(c.includes("severity: critical"))
      assert.ok(c.includes("ho-9"))
    } finally {
      cleanup()
    }
  })

  it("leader term=null（无身份）→ 跳过事件，文件照写", async () => {
    const { root, cleanup } = makeRoot()
    try {
      const events = makeEventsStub()
      const write = createDriftWarningsWriter({
        wikiRoot: root,
        events: events.repo as never,
        leaderContext: { currentLeaderTerm: () => null, newFencingToken: () => "t" },
        clock: CLOCK,
        warn: () => {},
      })
      await write(result({ draftsOpened: [buildUpdateDraft(T_LESSON)] }))
      assert.equal(events.appended.length, 0, "无身份不写事件")
      assert.ok(existsSync(path.join(root, "warnings", "drift-detector-2026-06-14.md")), "文件照写")
    } finally {
      cleanup()
    }
  })
})
