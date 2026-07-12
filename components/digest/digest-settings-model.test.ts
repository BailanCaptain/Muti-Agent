import { describe, expect, it } from "vitest"
import {
  type EffectiveSettings,
  type SettingsForm,
  buildSettingsPayload,
  formFromEffective,
  groupSources,
  listToInput,
  outcomeLine,
  parseListInput,
} from "./digest-settings-model"

const SEED: EffectiveSettings = {
  primaryModel: "claude-opus-4-8",
  fallbackModel: "claude-opus-4-7",
  recipients: ["a@x.com"],
  xHandles: ["OpenAI", "sama"],
  xhsKeywords: [],
  disabledSources: [],
  sendTime: "07:30",
  restOverviewRows: 12,
}

describe("parseListInput / listToInput", () => {
  it("逗号/换行/混填都收，trim 去空保序去重", () => {
    expect(parseListInput("a@x.com, b@y.com\n\n a@x.com ,c@z.com")).toEqual([
      "a@x.com",
      "b@y.com",
      "c@z.com",
    ])
    expect(listToInput(["a", "b"])).toBe("a\nb")
  })
})

describe("buildSettingsPayload（与 .env 基线同则省略 → 字段级回落）", () => {
  it("表单全同基线 → null（清段）", () => {
    expect(buildSettingsPayload(formFromEffective(SEED), SEED)).toBeNull()
  })

  it("只动的字段落 payload；@ 前缀归一；清空 X = 空数组显式落", () => {
    const form: SettingsForm = {
      ...formFromEffective(SEED),
      recipientsText: "a@x.com\nnew@y.com",
      xHandlesText: "",
      sendTime: "06:00",
    }
    expect(buildSettingsPayload(form, SEED)).toEqual({
      recipients: ["a@x.com", "new@y.com"],
      xHandles: [],
      sendTime: "06:00",
    })
    const withAt: SettingsForm = { ...formFromEffective(SEED), xHandlesText: "@OpenAI\n@sama" }
    // @ 剥掉后与基线一致 → 字段省略 → 整体 null
    expect(buildSettingsPayload(withAt, SEED)).toBeNull()
  })

  it("禁用源非空才落字段（默认全开省略）", () => {
    const form = { ...formFromEffective(SEED), disabledSources: ["digg-ai", "baidu-hot"] }
    expect(buildSettingsPayload(form, SEED)).toEqual({
      disabledSources: ["baidu-hot", "digg-ai"],
    })
  })
})

describe("groupSources / outcomeLine", () => {
  it("按 ai→hot→x→github 分组，空组不出", () => {
    const groups = groupSources([
      { id: "hn-ai", category: "ai", label: "HN" },
      { id: "github-trending-daily", category: "github", label: "增长榜" },
    ])
    expect(groups.map((g) => g.category)).toEqual(["ai", "github"])
  })

  it("podcast 源有自己的组且排在 hot 与 github 之间（07-11 preview 实截抓漏：ORDER 缺类=源被静默吞）", () => {
    const groups = groupSources([
      { id: "podcast-transcribe", category: "podcast", label: "播客速递" },
      { id: "hn-ai", category: "ai", label: "HN" },
      { id: "zhihu-hot", category: "hot", label: "知乎" },
      { id: "github-trending-daily", category: "github", label: "增长榜" },
    ])
    expect(groups.map((g) => g.category)).toEqual(["ai", "hot", "podcast", "github"])
    expect(groups.find((g) => g.category === "podcast")?.items.map((s) => s.id)).toEqual([
      "podcast-transcribe",
    ])
  })

  it("failed_summarize 人话（07-11 小孙拍：清单版宁缺勿发）", () => {
    expect(
      outcomeLine({
        status: "failed_summarize",
        startedAt: "t",
        finishedAt: "2026-07-11T10:08:30Z",
      }),
    ).toContain("AI 摘要多次尝试全败")
  })

  it("补发结果人话", () => {
    expect(
      outcomeLine({
        status: "ok",
        businessDate: "2026-07-05",
        startedAt: "2026-07-05T10:00:00Z",
        finishedAt: "2026-07-05T10:08:30Z",
      }),
    ).toContain("已发送")
    expect(
      outcomeLine({
        status: "error",
        detail: "boom",
        startedAt: "t",
        finishedAt: "2026-07-05T10:08:30Z",
      }),
    ).toContain("构建异常")
  })
})
