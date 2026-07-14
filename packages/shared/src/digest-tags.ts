/**
 * F037 日报分栏标签真相源（小孙 07-05 分栏改版）：
 * api 侧（summarizer 打标白名单 + renderer 邮件子栏）与 web 侧（/digest tabs）双端共用，
 * 改类目只动这里。「推理」= 大模型推理/部署/加速/量化/算力（小孙点名专栏）。
 */

/** ai 板块子栏顺序（渲染/展示顺序 = 数组顺序） */
export const DIGEST_AI_TAG_ORDER = [
  "推理",
  "OpenAI",
  "Anthropic",
  "Google",
  "Meta",
  "国产",
  "开源",
  "研究",
  "其他",
] as const

/** hot 板块子栏顺序 */
export const DIGEST_HOT_TAG_ORDER = [
  "科技",
  "财经",
  "社会",
  "民生",
  "体育",
  "娱乐",
  "国际",
  "其他",
] as const

/** X 结构分区：item.topicTag 取值（x-handle-groups 静态映射产出） */
export const DIGEST_X_GROUP_ORG = "公司"
export const DIGEST_X_GROUP_PERSON = "从业者"

/** X 分区展示名（邮件子栏标题 / web tab 文案） */
export const DIGEST_X_TAB_ORG = "科技公司"
export const DIGEST_X_TAB_PERSON = "科技从业者"
export const DIGEST_X_TAB_MORE = "更多动态"

/**
 * 社区动态板块（小孙 07-06「把 X 一手动态改成社区动态，里面放 X 啊 reddit 啊」）：
 * X 之外的社区源按平台结构分组（sourceId → 展示名）；X 账号继续走 org/person 结构分区。
 * 旧归档 category "x" 由读取侧归一为 "community"（normalizeDigestCategory）。
 */
export const DIGEST_COMMUNITY_PLATFORM_TABS: Record<string, string> = {
  "reddit-ai": "Reddit",
  "digg-ai": "Digg",
  "v2ex-hot": "V2EX",
  xiaohongshu: "小红书",
}
export const DIGEST_COMMUNITY_TAB_FALLBACK = "更多社区"

/** 社区板块子栏顺序（邮件子栏 / web tabs 同源）：X 三组在前，平台组随后 */
export const DIGEST_COMMUNITY_TAB_ORDER = [
  DIGEST_X_TAB_ORG,
  DIGEST_X_TAB_PERSON,
  DIGEST_X_TAB_MORE,
  "Reddit",
  "Digg",
  "V2EX",
  "小红书",
  DIGEST_COMMUNITY_TAB_FALLBACK,
] as const

/** 旧归档兼容：07-06 前的 summary.json/items.jsonl 里 X 板块 category 是 "x" */
export function normalizeDigestCategory(category: string): string {
  return category === "x" ? "community" : category
}

/** GitHub 四榜在日报中的固定总名；榜种名称仍由 DIGEST_GH_KINDS 单独定义。 */
export const DIGEST_GITHUB_SECTION_LABEL = "开源榜单"

/** GitHub 榜种（顺序 = 展示顺序）；sourceId 与 sources/github-trending.ts 对齐 */
export const DIGEST_GH_KINDS = [
  { sourceId: "github-trending-daily", label: "增长榜 · 今日" },
  { sourceId: "github-trending-weekly", label: "周榜" },
  { sourceId: "github-ai-newcomers", label: "新秀 · 7 天新仓" },
  { sourceId: "github-trending-monthly", label: "月榜" },
] as const
