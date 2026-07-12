import { DIGEST_AI_TAG_ORDER, DIGEST_HOT_TAG_ORDER } from "@multi-agent/shared"

/**
 * 分栏标签守卫（小孙 07-05 改版 #4/#5）：类目清单真相源在 @multi-agent/shared digest-tags
 * （api 打标/邮件子栏 + web /digest tabs 双端共用），这里只做 api 侧再导出与白名单守卫。
 * 「推理」= 大模型推理技术：优化/部署/加速/量化/serving（小孙点名的专栏；07-12 收紧——
 * 仅限技术内容，GPU/算力商业新闻（融资/股价/采购）不算，prompt 规则 6 同步）；公司标签收模型/产品/公司动态；
 * 国产 = 中国厂商生态；开源/研究兜住生态与学界。
 */

/** ai 板块子栏顺序（渲染顺序 = 数组顺序；空组不渲染） */
export const AI_TAG_ORDER = DIGEST_AI_TAG_ORDER

/** hot 板块子栏顺序 */
export const HOT_TAG_ORDER = DIGEST_HOT_TAG_ORDER

export const AI_TAGS: ReadonlySet<string> = new Set(AI_TAG_ORDER)
export const HOT_TAGS: ReadonlySet<string> = new Set(HOT_TAG_ORDER)

/** LLM 打标白名单：板块外/未知类目返回 undefined（渲染层落「其他」组） */
export function sanitizeTag(category: string, tag: unknown): string | undefined {
  if (typeof tag !== "string") return undefined
  const t = tag.trim()
  if (category === "ai" && AI_TAGS.has(t)) return t
  if (category === "hot" && HOT_TAGS.has(t)) return t
  // community 板块用结构先验分组（X 走 x-handle-groups topicTag、其余按平台），LLM 标签一律忽略
  return undefined
}
