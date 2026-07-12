/**
 * 质量层 3 深读：网页正文粗提取（零依赖轻量版；F029 读证据页复用件，复用地图 §8）。
 * 不追求 readability 级精度——喂 LLM 二次提炼用，噪音由 LLM 消化；上限截断控 token。
 */
export function extractMainText(html: string, maxLen = 12_000): string {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ")
  // 有 <article> 取正文块（smol.ai/博客类命中），否则全文
  const scope = cleaned.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? cleaned
  return scope
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen)
}
