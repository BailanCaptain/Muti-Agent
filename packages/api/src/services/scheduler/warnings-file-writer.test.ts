/**
 * F027 收尾修1 · writeWarningFile 共享原语测试
 *
 * NHC（health-warnings-writer.test.ts）已通过委托覆盖 fencing / fail-soft / commit-false 路径。
 * 本测试锁**原语自身的契约**：任意 subtype/source/alias/title/body 的 spec → frontmatter 映射 +
 * 事件 path/alias 编码（NHC 固定值不变，原语必须忠实透传 drift 等其他生产者的值）。
 */

import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { type WarningFileSpec, writeWarningFile } from "./warnings-file-writer"

function makeRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "warnings-file-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function makeEventsStub(opts: { throwOnAppend?: boolean; commitResult?: boolean } = {}) {
  const appended: Array<Record<string, unknown>> = []
  const committed: number[] = []
  return {
    appended,
    committed,
    repo: {
      appendPending: (input: Record<string, unknown>) => {
        if (opts.throwOnAppend) throw new Error("events boom")
        appended.push(input)
        return { id: 99 }
      },
      commit: (eventId: number) => {
        committed.push(eventId)
        return opts.commitResult ?? true
      },
    },
  }
}

const CLOCK = () => new Date("2026-06-14T10:00:00Z")
const STUB_LEADER = { currentLeaderTerm: () => "5", newFencingToken: () => "tok" }

function sampleSpec(overrides: Partial<WarningFileSpec> = {}): WarningFileSpec {
  return {
    subtype: "drift_alert",
    severity: "warn",
    source: "drift-detector",
    detectedAt: "2026-06-14T09:00:00Z",
    alias: "drift-detector",
    fileName: "drift-detector-2026-06-14.md",
    title: "Drift Detection — 2 draft(s) opened（2026-06-14）",
    body: "正文一行\n\n## 区块\n- 条目",
    diffSummary: "draftsOpened=2, failed=0",
    reason: "drift detector: 2 drafts opened",
    ...overrides,
  }
}

describe("writeWarningFile · 原语契约", () => {
  it("spec → frontmatter 七字段忠实透传 + 标题 + 正文（非 NHC 固定值）", async () => {
    const { root, cleanup } = makeRoot()
    try {
      await writeWarningFile(sampleSpec(), { wikiRoot: root, clock: CLOCK })
      const file = path.join(root, "warnings", "drift-detector-2026-06-14.md")
      assert.ok(existsSync(file), "warning 文件应落盘")
      const c = readFileSync(file, "utf-8")
      assert.ok(c.startsWith("---"), "frontmatter 开头")
      assert.ok(c.includes("type: warning"))
      assert.ok(c.includes("subtype: drift_alert"))
      assert.ok(c.includes("severity: warn"))
      assert.ok(c.includes("source: drift-detector"))
      assert.ok(c.includes("detected_at: 2026-06-14T09:00:00Z"))
      assert.ok(c.includes("raised_by: drift-detector"))
      assert.ok(
        c.includes("generated_by: drift-detector"),
        "generated_by 必须落（NHC isDerivedView 豁免，防回环）",
      )
      assert.ok(c.includes("# Drift Detection — 2 draft(s) opened（2026-06-14）"), "标题渲染成 # title")
      assert.ok(c.includes("## 区块"), "正文透传")
    } finally {
      cleanup()
    }
  })

  it("注入 events + 捕获 term → wiki_events warning_raised（path/alias/action 按 spec 编码）", async () => {
    const { root, cleanup } = makeRoot()
    try {
      const events = makeEventsStub()
      await writeWarningFile(sampleSpec(), {
        wikiRoot: root,
        events: events.repo as never,
        leaderContext: STUB_LEADER,
        clock: CLOCK,
      })
      assert.equal(events.appended.length, 1)
      assert.equal(events.appended[0]?.action, "warning_raised")
      assert.equal(events.appended[0]?.path, "wiki/warnings/drift-detector-2026-06-14.md")
      assert.equal(events.appended[0]?.alias, "drift-detector")
      assert.equal(events.appended[0]?.reason, "drift detector: 2 drafts opened")
      assert.equal(events.appended[0]?.leaderTerm, "5")
      assert.deepEqual(events.committed, [99])
    } finally {
      cleanup()
    }
  })

  it("leader term=null（无身份）→ 跳过事件，文件照写（禁超级 term 兜底，r3 同纪律）", async () => {
    const { root, cleanup } = makeRoot()
    try {
      const events = makeEventsStub()
      const warns: string[] = []
      await writeWarningFile(sampleSpec(), {
        wikiRoot: root,
        events: events.repo as never,
        leaderContext: { currentLeaderTerm: () => null, newFencingToken: () => "t" },
        clock: CLOCK,
        warn: (m) => warns.push(m),
      })
      assert.equal(events.appended.length, 0, "无身份不写事件")
      assert.ok(existsSync(path.join(root, "warnings", "drift-detector-2026-06-14.md")), "文件照写")
      assert.ok(warns.some((w) => w.includes("skip warning_raised")))
    } finally {
      cleanup()
    }
  })

  it("文件写失败（wikiRoot 是文件）→ 事件仍写（两路独立 fail-soft）", async () => {
    const { root, cleanup } = makeRoot()
    try {
      const fileAsRoot = path.join(root, "not-a-dir")
      writeFileSync(fileAsRoot, "x")
      const events = makeEventsStub()
      await writeWarningFile(sampleSpec(), {
        wikiRoot: fileAsRoot,
        events: events.repo as never,
        leaderContext: STUB_LEADER,
        clock: CLOCK,
        warn: () => {},
      })
      assert.equal(events.appended.length, 1, "fs 故障不连坐取消事件")
      assert.deepEqual(events.committed, [99])
    } finally {
      cleanup()
    }
  })

  it("缺 events → 只落文件不抛", async () => {
    const { root, cleanup } = makeRoot()
    try {
      await writeWarningFile(sampleSpec(), { wikiRoot: root, clock: CLOCK })
      assert.ok(existsSync(path.join(root, "warnings", "drift-detector-2026-06-14.md")))
    } finally {
      cleanup()
    }
  })
})
