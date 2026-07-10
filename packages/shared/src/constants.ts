export const PROVIDERS = ["codex", "claude", "gemini"] as const

export type Provider = (typeof PROVIDERS)[number]

/**
 * Agent 档案 —— 每个 provider 的身份、角色、协作信息。
 * 单一真相源：修改此文件 = prompt / 路由 / UI 同步更新。
 */
export type AgentProfile = {
  provider: Provider
  /** 人名（也是 @ 路由的唯一别名，也是 UI 展示的 label） */
  name: string
  /** 角色定位 */
  role: string
  /** 性格特质（帮助 agent 保持回答风格一致） */
  personality: string
  /** 擅长什么（写进队友名册） */
  strengths: string
  /** 协作注意事项（写进队友名册） */
  caution: string
}

export const AGENT_PROFILES: Record<Provider, AgentProfile> = {
  claude: {
    provider: "claude",
    name: "黄仁勋",
    role: "主架构师 / 核心开发",
    personality: "深度思考、严谨架构、注重长期设计",
    strengths: "架构决策、代码设计、技术选型、code review",
    caution: "不确定时必须问，不能硬猜",
  },
  codex: {
    provider: "codex",
    name: "范德彪",
    role: "Code Review / 安全 / 测试 / 工程实现",
    personality: "严谨执行、挑战假设、直言不讳",
    strengths: "重构、实现、测试、自动化脚本、代码审查",
    caution: "控制工具调用轮次，先输出结论再动手验证",
  },
  gemini: {
    provider: "gemini",
    name: "桂芬",
    role: "视觉设计师 / 创意师 / 前端体验",
    personality: "热血活泼、创意丰富、表达力强",
    strengths: "UI 交互、视觉设计、前端实现、可视化",
    caution: "@ 后面必须写真实人名，不是文件路径、不是 provider 代号",
  },
}

/**
 * 真人用户（产品负责人）档案。
 */
export type HumanOwnerProfile = {
  name: string
  role: string
  /** 什么情况下应该 @ 问 ta */
  whenToAsk: readonly string[]
}

export const HUMAN_OWNER: HumanOwnerProfile = {
  name: "小孙",
  role: "产品负责人 / CVO",
  whenToAsk: ["需求边界 / 优先级 / 产品目标", "方向不确定的重大决策", "P0 不可逆操作前的最后确认"],
}

/**
 * 向后兼容：provider → 主名 简单映射。
 * 新代码优先使用 AGENT_PROFILES[provider].name。
 */
export const PROVIDER_ALIASES: Record<Provider, string> = {
  codex: AGENT_PROFILES.codex.name,
  claude: AGENT_PROFILES.claude.name,
  gemini: AGENT_PROFILES.gemini.name,
}

/**
 * 预防性 session seal 阈值。
 * 当一个 turn 结束时 usedTokens / contextWindow >= action，我们把 native_session_id
 * 清空，下一轮让 CLI 开新 session。可以避免 Gemini 撞上 429 MODEL_CAPACITY_EXHAUSTED
 * 之后陷入 10 次 5-30s 的重试循环；同样也能在 Codex/Claude 侧阻止 context 窗口静默打满。
 *
 * 阈值参考 clowder-ai 的 per-provider 调参：Gemini 上下文窗口虽大，但接近极限时性能退化更早，
 * 所以阈值更激进；Codex/Claude 上下文表现线性，阈值更靠近满值。
 */
export const SEAL_THRESHOLDS_BY_PROVIDER: Record<Provider, { warn: number; action: number }> = {
  // F004: relax Gemini's preventive seal. 0.55/0.65 on a 1M-token window was overly
  // aggressive — it sealed sessions at ~650k tokens for no real benefit, and each seal
  // threw away the native session id. Direct-turn history injection now makes seals
  // cheaper (history survives via prompt), but we'd rather avoid unnecessary seals
  // entirely since Gemini's 1M window has plenty of headroom before real degradation.
  gemini: { warn: 0.7, action: 0.8 },
  codex: { warn: 0.75, action: 0.85 },
  claude: { warn: 0.8, action: 0.9 },
}

/**
 * CLI 不一定在事件里回显 contextWindowSize（尤其是 Codex 的 turn.completed 只给 usage）。
 * 这里按 model 名字前缀做兜底。查不到就返回 null —— 让上游跳过预防性 seal，不要瞎猜。
 */
const CONTEXT_WINDOW_FALLBACKS: ReadonlyArray<{ match: RegExp; window: number }> = [
  // Gemini 3.x 家族：1M tokens
  { match: /^gemini-3/i, window: 1_048_576 },
  // F043 AC0（07-10 实测）：gemini-2.5 家族 1M。此前无条目 → snapshot 永不生成
  { match: /^gemini-2\.5/i, window: 1_048_576 },
  // F043 AC0（07-10 实测）：opus-4-8 账户生效窗口 1M（modelUsage.contextWindow 探针实证），
  // 与 4-7 沿革值并入一条；必须排在通用 Claude 4 之前
  { match: /^claude-opus-4-[78]/i, window: 1_000_000 },
  // 其他 Claude 4.x（Opus 4.6-、Sonnet 4.x、Haiku 4.x）：200k
  { match: /^claude-(opus|sonnet|haiku)-4/i, window: 200_000 },
  { match: /^claude-/i, window: 200_000 },
  // OpenAI reasoning 家族。F043 AC0：codex 窗口随 CLI 换代漂移（07-06 gpt-5.5 rollout
  // 自报 258,400 / 07-10 gpt-5.6-sol 自报 353,400），本表只是 rollout 回读失败时的
  // 实测快照 —— 主路径是 CodexRuntime.resolveUsage 读 rollout model_context_window。
  { match: /^gpt-5\.6/i, window: 353_400 },
  { match: /^gpt-5\.5/i, window: 258_400 },
  { match: /^gpt-5/i, window: 400_000 },
  { match: /^gpt-4/i, window: 128_000 },
  { match: /^o3/i, window: 200_000 },
]

export function getContextWindowForModel(model: string | null | undefined): number | null {
  if (!model) {
    return null
  }
  for (const { match, window } of CONTEXT_WINDOW_FALLBACKS) {
    if (match.test(model)) {
      return window
    }
  }
  return null
}

/**
 * 单轮 token 明细（F043 P1 展示 + 落库用）。统一契约（P1-2 德彪 r1）：
 * inputTokens = 非缓存输入 —— 三列互斥不重叠，展示层可安全求和为输入侧全量。
 * claude 原生即此语义（input / cache_read / cache_creation 互斥）；
 * codex 原生 input_tokens 含 cached（cached ⊆ input），由 adapter 归一化拆开，
 * 否则 input+cacheRead 求和会把缓存双计。
 */
export type UsageDetail = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

/**
 * 单轮结束时汇总的 token 使用情况，用于决定是否 seal session。
 * F043 口径翻正：usedTokens = 当前上下文真实足迹，不再是累计计费值 ——
 * claude = 末次 message_start 的 input+cache_read+cache_creation；
 * codex  = rollout 末条 last_token_usage.total_tokens（流内退化 = input_tokens 单值）；
 * gemini = CLI 累计值（未修净，恒 approx，seal 判定 fail-open 只 warn）。
 * windowTokens 是上下文窗口大小。
 * source 语义升级为整体快照质量：exact 仅当分子为真足迹且窗口来自 CLI 自报；
 * 任一来自兜底/估计 → approx（前端据此标注）。
 */
export type TokenUsageSnapshot = {
  usedTokens: number
  windowTokens: number
  source: "exact" | "approx"
  detail?: UsageDetail
}
