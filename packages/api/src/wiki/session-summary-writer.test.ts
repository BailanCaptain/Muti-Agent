/**
 * F027 #285 S1 · SessionSummaryWikiWriter —— 会话滚动摘要双写进 wiki 文件。
 *
 * 背景（深迁移 plan .runtime/reviews/F285-deep-migration-plan.md）：session_memories 表
 * 是旧 3 工具（get_room_summary / search_room_memories / get_memory）唯一后端，4 件套
 * 覆盖不到 → 工具退不掉。本 writer 把每次滚动摘要落 `wiki/rooms/<roomId>/session-summary.md`
 * （RoomCompiler 派生视图同款 writeFileAtomic 直写），search_wiki / read_wiki 即可接管职能。
 *
 * 契约：
 *   - 表仍是 source of truth（MemoryService 写表后 fail-soft 调本 writer）；
 *   - 无 canonical_owner_path marker → isCompiledMemoryEntity 排除 → 不进全局索引（不污染）；
 *   - roomId 白名单清洗（防 path 注入），缺 canonical roomId 用 sessionGroupId 兜底；
 *   - 任何写失败 warn 一次不抛（摘要主链路不受影响）。
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createSessionSummaryWikiWriter } from "./session-summary-writer"

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "f285-session-summary-"))
}

test("S1 · write → rooms/<roomId>/session-summary.md 落盘（frontmatter + body）", () => {
  const root = makeTmpRoot()
  try {
    const writer = createSessionSummaryWikiWriter({
      wikiRoot: root,
      resolveRoomId: () => "R-201",
    })
    writer.write({
      sessionGroupId: "group-1",
      summary: "## 话题\n- F027 收尾",
      keywords: "F027,backfill",
      createdAt: "2026-06-10T08:00:00.000Z",
    })
    const file = path.join(root, "rooms", "R-201", "session-summary.md")
    assert.ok(fs.existsSync(file), "文件应落在 rooms/<roomId>/session-summary.md")
    const content = fs.readFileSync(file, "utf8")
    assert.match(content, /generated_by: memory-service/)
    assert.match(content, /session_group_id: group-1/)
    assert.match(content, /keywords: F027,backfill/)
    assert.match(content, /updated_at: 2026-06-10T08:00:00\.000Z/)
    assert.ok(content.includes("## 话题"), "body = 摘要原文")
    assert.ok(
      !content.includes("canonical_owner_path"),
      "派生视图不得带 canonical_owner_path（否则进全局索引污染）",
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("S1 · resolveRoomId 返 null → sessionGroupId 兜底作目录名", () => {
  const root = makeTmpRoot()
  try {
    const writer = createSessionSummaryWikiWriter({
      wikiRoot: root,
      resolveRoomId: () => null,
    })
    writer.write({
      sessionGroupId: "group-xyz",
      summary: "s",
      keywords: "",
      createdAt: "2026-06-10T08:00:00.000Z",
    })
    assert.ok(fs.existsSync(path.join(root, "rooms", "group-xyz", "session-summary.md")))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("S1 · roomId 路径注入（../escape）→ 清洗后仍困在 rooms/ 树内", () => {
  const root = makeTmpRoot()
  try {
    const writer = createSessionSummaryWikiWriter({
      wikiRoot: root,
      resolveRoomId: () => "../../evil",
    })
    writer.write({
      sessionGroupId: "group-1",
      summary: "s",
      keywords: "",
      createdAt: "2026-06-10T08:00:00.000Z",
    })
    assert.ok(
      !fs.existsSync(path.join(root, "..", "evil", "session-summary.md")) &&
        !fs.existsSync(path.join(path.dirname(root), "evil")),
      "禁止逃出 rooms/ 树",
    )
    const roomsDir = path.join(root, "rooms")
    const dirs = fs.existsSync(roomsDir) ? fs.readdirSync(roomsDir) : []
    assert.ok(
      dirs.every((d) => !d.includes("..")),
      `rooms/ 下目录名不得含 ..（实际: ${dirs.join(",")}）`,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("S1 · 写失败（wikiRoot 处是文件非目录）→ warn 一次不抛", () => {
  const root = makeTmpRoot()
  try {
    const blocked = path.join(root, "not-a-dir")
    fs.writeFileSync(blocked, "x") // rooms/ 的父路径是个文件 → mkdir 必炸
    const warns: string[] = []
    const writer = createSessionSummaryWikiWriter({
      wikiRoot: blocked,
      resolveRoomId: () => "R-201",
      warn: (msg) => warns.push(msg),
    })
    assert.doesNotThrow(() =>
      writer.write({
        sessionGroupId: "group-1",
        summary: "s",
        keywords: "",
        createdAt: "2026-06-10T08:00:00.000Z",
      }),
    )
    assert.equal(warns.length, 1, "fail-soft 应 warn 一次（不静默退化）")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("S1 · resolveRoomId 抛错 → fail-soft 走 sessionGroupId 兜底（不抛）", () => {
  const root = makeTmpRoot()
  try {
    const writer = createSessionSummaryWikiWriter({
      wikiRoot: root,
      resolveRoomId: () => {
        throw new Error("resolver crash")
      },
    })
    assert.doesNotThrow(() =>
      writer.write({
        sessionGroupId: "group-fallback",
        summary: "s",
        keywords: "",
        createdAt: "2026-06-10T08:00:00.000Z",
      }),
    )
    assert.ok(fs.existsSync(path.join(root, "rooms", "group-fallback", "session-summary.md")))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ─── #285 receive 德彪 r1 P1-1 · 写成功后通知 reindex（FTS 不滞后）───
//
// 德彪实证：writeFileAtomic 直写不产 wiki_events → WikiCompilerDebounce 不触发 →
// wiki_entity_index 只在 boot/别的 commit 时更新 → search_wiki 读不到新摘要,
// "接管 search_room_memories" 不成立。修：onWritten 回调,server 接 fireWikiCommit
// （走与 updateWiki commit 同一条 5s debounce → reindexWiki 链）。

const onWrittenTestInput = {
  sessionGroupId: "group-1",
  summary: "s",
  keywords: "",
  createdAt: "2026-06-10T08:00:00.000Z",
}

test("P1-1 · 写成功 → onWritten 调一次（server 接 fireWikiCommit 触发 reindex debounce）", () => {
  const root = makeTmpRoot()
  try {
    let notified = 0
    const writer = createSessionSummaryWikiWriter({
      wikiRoot: root,
      resolveRoomId: () => "R-201",
      onWritten: () => notified++,
    })
    writer.write(onWrittenTestInput)
    assert.equal(notified, 1, "落盘成功必须通知（否则 FTS 永远滞后到下次 boot）")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("P1-1 · 写失败 → onWritten 不调（不空触发 reindex）", () => {
  const root = makeTmpRoot()
  try {
    const blocked = path.join(root, "not-a-dir")
    fs.writeFileSync(blocked, "x")
    let notified = 0
    const writer = createSessionSummaryWikiWriter({
      wikiRoot: blocked,
      resolveRoomId: () => "R-201",
      warn: () => {},
      onWritten: () => notified++,
    })
    writer.write(onWrittenTestInput)
    assert.equal(notified, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("P1-1 · onWritten 自身抛错 → fail-soft warn 不上抛（通知失败不毁摘要链路）", () => {
  const root = makeTmpRoot()
  try {
    const warns: string[] = []
    const writer = createSessionSummaryWikiWriter({
      wikiRoot: root,
      resolveRoomId: () => "R-201",
      warn: (msg) => warns.push(msg),
      onWritten: () => {
        throw new Error("debounce crashed")
      },
    })
    assert.doesNotThrow(() => writer.write(onWrittenTestInput))
    assert.equal(warns.length, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
