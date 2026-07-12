import { DIGEST_X_GROUP_ORG, DIGEST_X_GROUP_PERSON } from "@multi-agent/shared"

/**
 * X 账号 → 分栏组静态映射（小孙 07-05 分栏改版 #3：X 分「最热/科技公司/科技从业者」）。
 * 「最热」不是分区——LLM 首选即焦点卡；这里只管结构分区：机构号 vs 个人号。
 * 与 .env MULTI_AGENT_DIGEST_X_HANDLES 的 35 验活账号（主表 §4）同步维护；
 * 清单外的新账号返回 undefined，渲染层落「更多动态」组（可见、不误标）。
 */

export const X_GROUP_ORG = DIGEST_X_GROUP_ORG
export const X_GROUP_PERSON = DIGEST_X_GROUP_PERSON

/** 机构/公司/媒体号（17） */
const ORG_HANDLES = new Set([
  "openai",
  "anthropicai",
  // 07-10 小孙点名加 Claude 双官方号（RSSHub 验活：claudeai=产品号显示名 Claude、
  // claudeDevs=开发者号在发限流公告；⚠ 裸 "claude" 是路人 Claude R Perrin 别用）
  "claudeai",
  "claudedevs",
  "googledeepmind",
  "aiatmeta",
  "mistralai",
  "xai",
  "nvidiaai",
  "googleai",
  "cohere",
  "stabilityai",
  "perplexity_ai",
  "huggingface",
  "deepseek_ai",
  "alibaba_qwen",
  "therundownai",
])

/** 从业者/研究者个人号（18） */
const PERSON_HANDLES = new Set([
  "karpathy",
  "sama",
  "ylecun",
  "drjimfan",
  "andrewyng",
  "gdb",
  "ilyasut",
  "demishassabis",
  "jeffdean",
  "fchollet",
  "hardmaru",
  "_jasonwei",
  "clementdelangue",
  "alexandr_wang",
  "drfeifei",
  "rowancheung",
  "emollick",
  "swyx",
])

export function xHandleGroup(handle: string): string | undefined {
  const h = handle.trim().replace(/^@/, "").toLowerCase()
  if (ORG_HANDLES.has(h)) return X_GROUP_ORG
  if (PERSON_HANDLES.has(h)) return X_GROUP_PERSON
  return undefined
}
