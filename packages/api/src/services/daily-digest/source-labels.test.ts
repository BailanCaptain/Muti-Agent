import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { sourceLabel } from "./source-labels"
import { JSON_SOURCES, RSS_SOURCES } from "./sources/registry"

describe("sourceLabel（骨架 restyle：正文不露内部 id）", () => {
  it("registry 全部静态源都有中文名（防新增源漏配）", () => {
    const ids = [...RSS_SOURCES.map((s) => s.sourceId), ...JSON_SOURCES.map((s) => s.sourceId)]
    for (const id of ids) {
      assert.notEqual(sourceLabel(id), id, `源 ${id} 缺 SOURCE_LABELS 条目`)
    }
  })

  it("动态/未知 id 兜底返回原 id", () => {
    assert.equal(sourceLabel("unknown-src"), "unknown-src")
  })

  it("yt-* 全部带且仅带一个「YouTube · 」前缀（小孙三拍：读者要知道来源；三拍 r1 P3 需求级锁）", () => {
    const ytIds = [...RSS_SOURCES.map((s) => s.sourceId), ...JSON_SOURCES.map((s) => s.sourceId)]
      .filter((id) => id.startsWith("yt-"))
    assert.ok(ytIds.length >= 12, `yt-* 源只剩 ${ytIds.length} 个——registry 被误删？`)
    for (const id of ytIds) {
      const label = sourceLabel(id)
      assert.ok(label.startsWith("YouTube · "), `${id} 缺「YouTube · 」前缀：${label}`)
      assert.ok(
        !label.slice("YouTube · ".length).includes("YouTube ·"),
        `${id} 双前缀：${label}`,
      )
    }
  })
})
