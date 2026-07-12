/**
 * sourceId → 读者可见中文名（骨架 restyle：正文不再露内部 id）。
 * 与 sources/registry.ts 的 id 清单用测试锁同步（source-labels.test.ts）。
 */
const SOURCE_LABELS: Record<string, string> = {
  // AI
  "smol-ai": "smol.ai 日报",
  "openai-news": "OpenAI",
  "deepmind-blog": "DeepMind",
  "mistral-blog": "Mistral",
  "anthropic-news": "Anthropic",
  "meta-ai-blog": "Meta AI",
  "vllm-blog": "vLLM 博客",
  "sglang-releases": "SGLang 发布",
  "vllm-releases": "vLLM 发布",
  "vllm-ascend-releases": "vLLM Ascend 发布",
  "hf-blog": "HuggingFace 博客",
  "hf-daily-papers": "HF 每日论文",
  "hn-ai": "Hacker News",
  "google-ai-blog": "Google AI",
  "qwen-blog": "Qwen 博客",
  techmeme: "Techmeme",
  "ai-hot": "AI HOT 策展",
  "reddit-ai": "Reddit AI 社区",
  "digg-ai": "Digg AI 1000",
  // #28 YouTube AI 频道（07-05 P1）；「YouTube · 」前缀=小孙 07-11 拍「让读者知道是
  // YouTube 来的」——label 是唯一源名出口（精选卡/速览行/md/网页/设置页全消费这里）
  "yt-two-minute-papers": "YouTube · Two Minute Papers",
  "yt-lex-fridman": "YouTube · Lex Fridman",
  "yt-3blue1brown": "YouTube · 3Blue1Brown",
  "yt-fireship": "YouTube · Fireship",
  "yt-ai-explained": "YouTube · AI Explained",
  "yt-karpathy": "YouTube · Andrej Karpathy",
  // 07-11 扩六频道（小孙「AI 领域影响大的」）
  "yt-dwarkesh": "YouTube · Dwarkesh Patel",
  "yt-yannic-kilcher": "YouTube · Yannic Kilcher",
  "yt-mlst": "YouTube · ML Street Talk",
  "yt-openai": "YouTube · OpenAI 频道",
  "yt-anthropic": "YouTube · Anthropic 频道",
  "yt-deepmind": "YouTube · DeepMind 频道",
  // 热点
  "bbc-zhongwen": "BBC 中文",
  thepaper: "澎湃新闻",
  "zhihu-hot": "知乎热榜",
  "baidu-hot": "百度热搜",
  "toutiao-hot": "头条热榜",
  "v2ex-hot": "V2EX 热议",
  xiaohongshu: "小红书",
  // GitHub / X
  "github-trending-daily": "GitHub 增长榜",
  "github-trending-weekly": "GitHub 周榜",
  "github-trending-monthly": "GitHub 月榜",
  "github-ai-newcomers": "GitHub 新秀",
  "x-firsthand": "X 一手动态",
  // #33 播客速递（07-10）
  "podcast-transcribe": "播客速递",
}

export function sourceLabel(sourceId: string): string {
  return SOURCE_LABELS[sourceId] ?? sourceId
}
