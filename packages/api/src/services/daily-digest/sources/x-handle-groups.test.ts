import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { X_GROUP_ORG, X_GROUP_PERSON, xHandleGroup } from "./x-handle-groups"

// 与 .env MULTI_AGENT_DIGEST_X_HANDLES 35 验活账号（主表 §4）同步的显式清单——
// 新账号进 env 必须同步进映射，本测试即同步锁
const ORGS = [
  "OpenAI",
  "AnthropicAI",
  "claudeai",
  "claudeDevs",
  "GoogleDeepMind",
  "AIatMeta",
  "MistralAI",
  "xai",
  "NVIDIAAI",
  "GoogleAI",
  "cohere",
  "StabilityAI",
  "perplexity_ai",
  "huggingface",
  "deepseek_ai",
  "Alibaba_Qwen",
  "TheRundownAI",
]
const PEOPLE = [
  "karpathy",
  "sama",
  "ylecun",
  "DrJimFan",
  "AndrewYNg",
  "gdb",
  "ilyasut",
  "demishassabis",
  "JeffDean",
  "fchollet",
  "hardmaru",
  "_jasonwei",
  "ClementDelangue",
  "alexandr_wang",
  "drfeifei",
  "rowancheung",
  "emollick",
  "swyx",
]

describe("xHandleGroup（X 分栏 #3：机构/从业者静态映射）", () => {
  it("35 验活账号全覆盖：17 机构 + 18 从业者", () => {
    assert.equal(ORGS.length, 17)
    assert.equal(PEOPLE.length, 18)
    for (const h of ORGS) assert.equal(xHandleGroup(h), X_GROUP_ORG, h)
    for (const h of PEOPLE) assert.equal(xHandleGroup(h), X_GROUP_PERSON, h)
  })

  it("归一化：@ 前缀剥离 + 大小写不敏感 + 首尾空白", () => {
    assert.equal(xHandleGroup("@OpenAI"), X_GROUP_ORG)
    assert.equal(xHandleGroup("KARPATHY"), X_GROUP_PERSON)
    assert.equal(xHandleGroup(" sama "), X_GROUP_PERSON)
  })

  it("清单外账号 → undefined（渲染层落「更多动态」，不误标）", () => {
    assert.equal(xHandleGroup("someone_new"), undefined)
    assert.equal(xHandleGroup(""), undefined)
  })
})
