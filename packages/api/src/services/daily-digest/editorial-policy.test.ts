import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { resolveDisplayTag } from "./editorial-policy"
import type { EditorialAssessment } from "./types"

const assessment = (overrides: Partial<EditorialAssessment> = {}): EditorialAssessment => ({
  itemId: "item-1",
  sourceCategory: "ai",
  reviewState: "eligible",
  topicTags: [],
  organizationTags: [],
  ecosystemTags: [],
  regionTags: [],
  contentKind: "engineering",
  confidence: 0.9,
  ...overrides,
})

describe("B027 编辑策略：推理是技术主题，不是商业同义词", () => {
  it("GPU 融资即使被请求标成推理，也必须降到其他", () => {
    const actual = resolveDisplayTag(
      assessment({ contentKind: "finance", topicTags: ["inference"] }),
      "推理",
    )
    assert.equal(actual, "其他")
  })

  it("推理技术同时具有国产/开源属性时只取一个展示标签，推理优先", () => {
    const actual = resolveDisplayTag(
      assessment({
        topicTags: ["inference", "research"],
        ecosystemTags: ["open_source"],
        regionTags: ["cn"],
      }),
      "国产",
    )
    assert.equal(actual, "推理")
  })

  it("非推理研究不得因为板块强调推理而被改成推理", () => {
    const actual = resolveDisplayTag(
      assessment({ contentKind: "research", topicTags: ["research"] }),
      "研究",
    )
    assert.equal(actual, "研究")
  })
})
