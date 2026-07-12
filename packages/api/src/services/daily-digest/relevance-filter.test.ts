import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildNormalizedItem } from "./feed-parsers"
import {
  isCommunityNoiseItem,
  isPoliticalItem,
  isTechTopicItem,
  isUnsafeItem,
} from "./relevance-filter"
import type { NormalizedItem } from "./types"

function item(title: string, snippet = ""): NormalizedItem {
  return buildNormalizedItem("test-src", "hot", title, "https://example.com/a", null, snippet)
}

describe("isPoliticalItem（E2 政治词表硬滤）", () => {
  it("纯政治事件命中：选举/战争冲突/政局/恐袭（中英）", () => {
    const hits = [
      "某国大选进入最后冲刺",
      "议会通过对总理的弹劾动议",
      "边境地区遭无人机袭击",
      "加沙地带停火谈判破裂",
      "首都爆发大规模示威游行",
      "Ceasefire talks collapse again",
      "Parliament backs impeachment vote",
      "Drone strikes hit the border region",
    ]
    for (const t of hits) assert.equal(isPoliticalItem(item(t)), true, t)
  })

  it("科技产业政策不误杀：AI 监管/芯片出口管制是小孙要看的产业信息", () => {
    const passes = [
      "欧盟 AI 法案正式落地，大模型厂商迎合规大考",
      "美国收紧对华芯片出口管制，英伟达 H20 受影响",
      "白宫发布 AI 行政令，要求前沿模型备案",
      "vLLM 发布 v0.10：吞吐提升 40%",
      "OpenAI elects new board members",
    ]
    for (const t of passes) assert.equal(isPoliticalItem(item(t)), false, t)
  })

  it("扫描面 = 标题 + 摘要前 400 字符（尾部长正文不扫）", () => {
    assert.equal(isPoliticalItem(item("科技新闻", "开头正常。巴以局势……")), true)
    const longTail = `${"x".repeat(400)}巴以`
    assert.equal(isPoliticalItem(item("科技新闻", longTail)), false)
  })

  it("英文词界不误伤子串：election 不吃 selection", () => {
    assert.equal(isPoliticalItem(item("Feature selection in ML pipelines")), false)
    assert.equal(isPoliticalItem(item("Elections postponed amid unrest")), true)
  })
})

describe("isUnsafeItem（07-11 未成年人内容防护硬滤，与政治词表同机制）", () => {
  it("色情/赌博/毒品/暴力犯罪细节命中（中英）", () => {
    const hits = [
      "某平台色情直播产业链调查",
      "线上博彩 App 卷走数亿资金",
      "警方破获跨境贩毒网络",
      "凶杀案现场细节曝光",
      "Casino apps top the revenue chart",
      "Gambling ads flood social media",
    ]
    for (const t of hits) assert.equal(isUnsafeItem(item(t)), true, t)
  })

  it("科技治理/AI 安全类不误杀：未成年人保护、内容审核是产业新闻", () => {
    const passes = [
      "Character.AI 上线未成年人保护模式",
      "AI 内容审核系统识别有害信息准确率提升",
      "OpenAI 发布模型安全评估报告",
      "GPU 加速药物分子筛选研究",
      "Meta expands teen safety features",
    ]
    for (const t of passes) assert.equal(isUnsafeItem(item(t)), false, t)
  })

  it("英文治理语境词交语义层不硬杀（德彪 sixq-r1 P2-3 三例）；\\bporn\\b 不吃 pornography", () => {
    const passes = [
      "New AI system detects child abuse material",
      "Researchers release a pornography-detection model",
      "AI helps investigators combat human trafficking",
    ]
    for (const t of passes) assert.equal(isUnsafeItem(item(t)), false, t)
    // 裸词仍命中（非治理语境的纯不宜内容）
    assert.equal(isUnsafeItem(item("Free porn site traffic surges")), true)
  })

  it("扫描面与政治词表同口径：标题 + 摘要前 400 字符", () => {
    assert.equal(isUnsafeItem(item("平台新闻", "开头正常。网赌团伙……")), true)
    const longTail = `${"x".repeat(400)}网赌`
    assert.equal(isUnsafeItem(item("平台新闻", longTail)), false)
  })
})

describe("isTechTopicItem（E2 v2ex 社区聚焦正向词表）", () => {
  it("AI/科技贴保留", () => {
    const keeps = [
      "用 Claude Code 重构了公司的老系统",
      "自建 NAS 求推荐方案",
      "大模型本地部署显卡怎么选",
      "程序员远程办公三年的体会",
      "鸿蒙生态开发一年感受",
    ]
    for (const t of keeps) assert.equal(isTechTopicItem(item(t)), true, t)
  })

  it("生活/职场/理财贴滤掉（宁缺勿滥）", () => {
    const drops = [
      "30 岁裸辞去大理的生活",
      "体检查出结节怎么办",
      "房贷提前还清值不值",
      "相亲遇到的奇葩经历",
    ]
    for (const t of drops) assert.equal(isTechTopicItem(item(t)), false, t)
  })
})

describe("isCommunityNoiseItem（07-12 社区噪声负向词表：性质维度，补话题表管不住的求助/处境帖）", () => {
  it("求助/处境/学生/生活帖命中（含小孙点名实案：话题科技但性质是个人求助）", () => {
    const hits = [
      "专科大二，喜欢底层开发，但有点迷茫想听听建议", // 07-12 实案：正文带科技词穿透话题表
      "两个 offer 怎么选，求各位给点建议",
      "转行做程序员一年，越来越焦虑",
      "研一在读，方向纠结中",
      "年薪 40w 但天天加班，值不值",
      "吐槽一下公司的技术栈",
      "毕业第一年租房踩的坑",
    ]
    for (const t of hits) assert.equal(isCommunityNoiseItem(item(t)), true, t)
  })

  it("研究/进展/深度讨论不误杀；产业人事/薪酬报道刻意不进词表（交语义层）", () => {
    const passes = [
      "vLLM 推理优化实践：吞吐翻倍的三个技巧",
      "Anthropic 发布模型可解释性新研究",
      "Llama 4 本地部署体验报告",
      "开源社区对 MoE 架构的深度讨论",
      "DeepSeek 新模型技术报告解读",
      "OpenAI 首席科学家官宣离职创业", // 「离职」是产业新闻用词，词表不收
      "Meta 天价薪资挖角 AI 人才引热议", // 「薪资」同理
    ]
    for (const t of passes) assert.equal(isCommunityNoiseItem(item(t)), false, t)
  })

  it("只扫标题（与话题表 title+snippet 口径刻意不同）：技术帖正文带情绪词不误杀", () => {
    assert.equal(
      isCommunityNoiseItem(item("自研推理框架的架构演进", "维护老代码让我焦虑但新框架真香……")),
      false,
    )
    assert.equal(isCommunityNoiseItem(item("越写代码越焦虑", "")), true)
  })

  it("英文求助/发泄帖命中；\\b 词界不误伤（Grant 不吃 rant）", () => {
    assert.equal(isCommunityNoiseItem(item("Need advice: switching to ML from web dev")), true)
    assert.equal(isCommunityNoiseItem(item("[Rant] Ollama defaults are terrible")), true)
    assert.equal(isCommunityNoiseItem(item("Grant program for open-source AI research")), false)
    assert.equal(isCommunityNoiseItem(item("Scaling laws for sparse models explained")), false)
  })
})
