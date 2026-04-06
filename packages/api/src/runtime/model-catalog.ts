export type AgentKind = "claude" | "codex" | "gemini"

export type ModelEntry = {
  name: string
  label: string
}

export type AgentCatalog = {
  models: ModelEntry[]
  /**
   * 真实 CLI 可接受的推理强度取值。空数组表示该 CLI 不支持 effort 参数。
   * 来源：实测各 CLI 的 --help 或错误消息（2026-04 验证）。
   */
  efforts: string[]
}

export type ModelCatalog = Record<AgentKind, AgentCatalog>

export const MODEL_CATALOG: ModelCatalog = {
  claude: {
    models: [
      { name: "claude-opus-4-6", label: "Opus 4.6（最强推理）" },
      { name: "claude-sonnet-4-6", label: "Sonnet 4.6（平衡）" },
      { name: "claude-haiku-4-5", label: "Haiku 4.5（快速）" },
    ],
    // 来源：`claude --help` 明文输出
    efforts: ["low", "medium", "high", "max"],
  },
  codex: {
    models: [
      { name: "gpt-5.4", label: "GPT-5.4" },
      { name: "gpt-5", label: "GPT-5" },
      { name: "gpt-5-mini", label: "GPT-5 mini" },
    ],
    // 来源：codex 对非法值报错返回的完整 variant 列表
    efforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
  },
  gemini: {
    models: [
      { name: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
      { name: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
    ],
    // Gemini CLI 无 reasoning/effort flag
    efforts: [],
  },
}
