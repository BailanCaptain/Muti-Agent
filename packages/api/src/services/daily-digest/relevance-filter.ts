import type { NormalizedItem } from "./types"

/**
 * E2 内容相关性过滤（07-07 小孙「政治内容去除」「社区动态应聚焦 AI/科技」）。
 *
 * 双层设计：这里是**结构层硬滤**（词表命中即从选材视野剔除，速览行同步干净）；
 * summarizer 提示词里另有**语义层红线**做双保险（词表抓不住的表述交给 LLM 判断）。
 *
 * 词表刻意保守——只收「纯政治事件」词（选举/党争/战争冲突/政局动荡/恐袭）。
 * AI 监管、芯片出口管制这类**科技产业政策**不进词表（白宫 AI 行政令、欧盟 AI 法案
 * 是小孙要看的产业信息），由 LLM 按「核心是否科技产业」语义把关。
 * 误杀成本 > 漏杀成本（漏的还有 LLM 层兜底），拿不准的词不进表。
 */
export const POLITICAL_CONTENT_RE: RegExp = new RegExp(
  [
    // 选举/党争
    "大选|总统选举|总统候选|竞选|选票|计票|党魁|执政党|反对党|在野党|弹劾",
    // 政局动荡/社会对立
    "政变|戒严|示威游行|游行示威|抗议集会|政治庇护|难民潮",
    // 战争冲突（具体冲突名 + 军事动作；「前线/战况」类比喻词高误杀不收）
    "停火|宣战|空袭|炮击|导弹袭击|无人机袭击|巴以|加沙|哈马斯|真主党|胡塞|俄乌|乌军|俄军|以军|军演|核试验|核武",
    // 恐袭
    "恐怖袭击|恐袭",
    // 英文同口径（\b 词界防误伤子串）
    "\\b(elections?|ballot|impeachment?|coup|martial law|ceasefire|air ?strikes?|artillery|missile strikes?|drone strikes?|gaza|hamas|hezbollah|houthi|kremlin|frontline|refugee crisis|terror attacks?)\\b",
  ].join("|"),
  "i",
)

/** 标题+摘要前 400 字符扫描（摘要尾部是长文正文，扫全文误杀率高收益低） */
export function isPoliticalItem(item: NormalizedItem): boolean {
  return POLITICAL_CONTENT_RE.test(`${item.title} ${item.rawSnippet.slice(0, 400)}`)
}

/**
 * 未成年人内容防护（07-11 小孙问 3，与政治词表同机制同姿态）：色情/赌博/毒品/暴力犯罪
 * 细节类硬滤，summarizer 规则 7 语义层双保险。同样保守——只收高置信「纯不宜内容」词；
 * 「自杀/枪击」类新闻词刻意不进硬表（AI 安全责任事件如聊天机器人涉诉是小孙要看的产业
 * 信息），交 LLM 按「核心是否科技产业」把关。英文治理语境高频词（pornography /
 * child abuse / human trafficking——「AI 检测 CSAM」「反拐卖 AI」类产业新闻的标准
 * 用词，德彪 sixq-r1 P2-3 三例实锤）同样不进硬表交语义层；`\bporn\b` 词界不吃
 * pornography。「未成年人保护/内容审核」类治理新闻不会命中本表。
 */
export const UNSAFE_CONTENT_RE: RegExp = new RegExp(
  [
    // 色情
    "色情|淫秽|裸聊|艳照|卖淫|嫖娼|援交",
    // 赌博
    "赌博|赌场|博彩|网赌",
    // 毒品
    "毒品|吸毒|贩毒|冰毒|海洛因|摇头丸",
    // 暴力犯罪细节
    "凶杀|碎尸|分尸|虐杀|性侵|强奸|虐童|拐卖",
    // 英文同口径（\b 词界防误伤子串；治理语境高频词见 doc comment，不收）
    "\\b(porn|nsfw|onlyfans|prostitution|gambling|casinos?|narcotics?|heroin|methamphetamine|homicide|rapes?)\\b",
  ].join("|"),
  "i",
)

/** 与 isPoliticalItem 同口径：标题+摘要前 400 字符 */
export function isUnsafeItem(item: NormalizedItem): boolean {
  return UNSAFE_CONTENT_RE.test(`${item.title} ${item.rawSnippet.slice(0, 400)}`)
}

/**
 * 科技话题正向词表（v2ex-hot keepIf）：V2EX 全站热议含大量生活/职场/理财贴，
 * 社区板块只留 AI/科技向——正向匹配宁缺勿滥（选不满没关系，小孙 07-07 拍）。
 * 中英混排：V2EX 标题中文为主，术语常英文。
 */
export const TECH_TOPIC_RE: RegExp = new RegExp(
  [
    "人工智能|大模型|智能体|机器人|自动驾驶|算法|算力|芯片|显卡|服务器|数据库|爬虫|编程|程序员|开发者|代码|软件|硬件|开源|前端|后端|全栈|架构|部署|运维|网络安全|漏洞|加密|区块链|操作系统|鸿蒙|数码|显示器|笔记本|键盘|路由器|域名|云服务|云计算",
    "\\b(AI|LLM|GPT|Claude|Gemini|DeepSeek|Qwen|Kimi|Copilot|ChatGPT|Cursor|CUDA|GPU|NPU|API|Docker|K8s|Kubernetes|Linux|macOS|Windows|iOS|Android|NAS|OpenAI|Anthropic|Nvidia|AMD|Intel)\\b",
    "苹果|谷歌|微软|英伟达|华为|小米|字节|腾讯|阿里",
  ].join("|"),
  "i",
)

/** v2ex 等泛社区源的科技相关判定（title+snippet 前 400） */
export function isTechTopicItem(item: NormalizedItem): boolean {
  return TECH_TOPIC_RE.test(`${item.title} ${item.rawSnippet.slice(0, 400)}`)
}

/**
 * 社区噪声负向词表（07-12 小孙「社区动态要的是 AI 研究/讨论/进展，不是抱怨和求助」）。
 * TECH_TOPIC_RE 管**话题域**（是不是科技），管不了**内容性质**——「专科大二想听听建议」
 * 正文带「编程/代码」就穿透正向表。这里补性质维度：个人求助/处境倾诉/职业咨询/生活杂事。
 *
 * 与政治词表同为双层设计的结构层：summarizer 提示词（规则 1 收紧 + communityDropIds
 * 反选）是语义层，兜词表抓不住的（名人轶闻八卦类无稳定特征词，全靠语义层）。
 *
 * 只挂 community 板块（job 预滤链限定 category）——「程序员薪资报告」类产业新闻走
 * ai/hot 板块不受影响。社区板块宁缺勿滥（小孙 07-07 拍过），词表可比政治表激进。
 */
export const COMMUNITY_NOISE_RE: RegExp = new RegExp(
  [
    // 求助/征询（V2EX 帖标题即问题本身）
    "求助|请教|求推荐|求建议|想听听|帮我看看|怎么办|该怎么|怎么选|哪个好|值不值|要不要",
    // 处境/情绪倾诉
    "迷茫|纠结|焦虑|吐槽|抱怨|后悔|烦恼|破防",
    // 个人职业——只收个人叙事强特征词；「离职/跳槽/薪资」类产业报道也用（Ilya 离职、
    // 天价薪资挖角是必看新闻），刻意不收，交语义层
    "入行|转行|裸辞|应届|校招|秋招|春招|面经|简历|求职",
    // 学生身份（个人处境帖强特征——本案「专科大二」）
    "大一|大二|大三|大四|研一|研二|研三|专科",
    // 生活杂事（正向表被正文科技词穿透时的补刀）
    "相亲|结婚|彩礼|房贷|买房|租房|装修|理财|存款",
    // 英文同口径（Reddit 求助/发泄帖；\b 词界，只收高置信词组）
    "\\b(any advice|need advice|career advice|feeling lost|newbie|beginner question|rant|venting)\\b",
  ].join("|"),
  "i",
)

/**
 * 社区源个人求助/水帖判定。**只扫标题**（与话题表的 title+snippet 口径刻意不同）：
 * 性质词几乎必在标题（社区帖标题=问题本身），而技术长文正文顺嘴提「工资/买房」
 * 很常见——扫正文误杀率高收益低。
 */
export function isCommunityNoiseItem(item: NormalizedItem): boolean {
  return COMMUNITY_NOISE_RE.test(item.title)
}
