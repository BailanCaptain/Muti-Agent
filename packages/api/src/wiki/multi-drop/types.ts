/**
 * F027 P4.5 · multi-drop cross-correlation · 共享类型
 * 真相源：docs/plans/V16.5-final.md chap 7 行 808-836
 * AC：AC-P1-5 —— 7 天滑动窗口；同 series_id sim ≥ 0.8 自动归 series；
 *      不同 series sim ≥ 0.7 → chained_suspect 警告
 *
 * Phase 1 设计（无 DB）：
 *   - 纯 in-memory 函数：caller 负责取 7 天窗口的历史 drops + embedding
 *   - DB 接入留 P6 IngestModal 时再做（见 F027 phase plan Week 4 P6）
 *   - LLM 二次审计 hook 留接口（默认 no-op；P4.6 LLM compile 上线后再接）
 */

/** 单条 drop 记录（in-memory 形态；DB schema 在 P0 完整定稿后再对齐） */
export interface DropRecord {
  /** 全局唯一 id（用于 reference link 检测和 candidate 标识） */
  id: string
  /**
   * 经 sanitizeRawDrop 后的安全文本。
   * 注意：keyword-chain / reference-link 检测都跑在 sanitized text 上，
   * 因为前 4 层防御已剥离同形字 / base64 等同形字攻击向量。
   */
  rawContent: string
  /** ingest 时间（unix ms）— 用于 7 天滑动窗口过滤 */
  ingestedAt: number
  /** 投稿者标识（agent 名 / room 角色 / human handle） */
  contributedBy: string
  /** 来源 IP（可选，做 source match） */
  ip?: string
  /** 来源 user-agent（可选，做 source match） */
  userAgent?: string
  /**
   * 系列 id：小孙 mark "这批是同一组 drops"（如分多次投长 paper）。
   * 同 series_id 高 sim → 归 series（白名单）；不同 series 高 sim → chained_suspect。
   * V16.5 chap 7 行 834-836 ："/ingest --series <series-id>" 命令组合。
   */
  seriesId?: string
  /**
   * 该 drop 的 embedding 向量（来自 F018 EmbeddingService）。
   * 缺失（生成失败 / 模型未加载）时 similarity 视为 0；
   * 不影响 keyword/reference 链路检测。
   */
  embedding?: number[]
}

export interface CrossCorrelateOptions {
  /** 滑动窗口（天）。默认 7（V16.5 chap 7 行 819）。 */
  windowDays?: number
  /**
   * 同 series 阈值。current.seriesId === candidate.seriesId 且 sim ≥ 此值
   * → series_member（白名单，不报 chained）。默认 0.8（AC-P1-5）。
   */
  seriesSimThreshold?: number
  /**
   * chained 阈值。不同 series（或都无 series）且 sim ≥ 此值
   * → chained_suspect (high_sim_diff_series)。默认 0.7（AC-P1-5）。
   */
  chainSimThreshold?: number
  /**
   * top-k 候选数。仅取 similarity 最高的前 k 个 drop 做后续 chain pattern 检测，
   * 避免 N×M 全扫；不影响 verdict 正确性（其余的 sim 必然更低）。默认 5。
   */
  topK?: number
  /**
   * LLM 二次审计 hook（V16.5 chap 7 行 826）。Phase 1 默认 no-op；
   * P4.6 LLM compile 上线后注入：把 current + candidates 一起送 LLM，
   * 问 "这组 drops 合起来是否构成指令链？"
   */
  auditCallback?: (
    current: DropRecord,
    candidates: DropRecord[],
  ) => Promise<{ isChain: boolean; reason?: string }>
}

/** 单个候选 drop 的关联评分 */
export interface CorrelationCandidate {
  drop: DropRecord
  /** cosine similarity（embedding 缺失则 0） */
  similarity: number
  /** 来源相似 flag（V16.5 chap 7 行 820） */
  sourceMatch: {
    contributedBy: boolean
    ip: boolean
    userAgent: boolean
  }
  /** 命中的跨 drop 指令链关键词模式（如 "wait+execute" pair） */
  keywordChainHits: string[]
  /** 命中的 drop reference link（current 显式 ref candidate.id） */
  referenceLinks: string[]
}

/** chained_suspect 触发原因 */
export interface ChainedTrigger {
  reason:
    | "high_sim_diff_series" // 不同 series sim ≥ chainSimThreshold
    | "keyword_chain" // wait/execute 跨 drop 配对
    | "reference_link" // current 显式 ref candidate
    | "llm_audit" // LLM hook 判定 isChain
  detail: string
  /** 触发该 trigger 的 candidate drop id（llm_audit 可能多 candidate） */
  candidateId?: string
}

export type CorrelationVerdict =
  | { kind: "isolated"; reason: string }
  | {
      kind: "series_member"
      seriesId: string
      siblings: CorrelationCandidate[]
    }
  | {
      kind: "chained_suspect"
      triggers: ChainedTrigger[]
    }

export interface CrossCorrelateResult {
  current: DropRecord
  /** 滑动窗口起点（unix ms） */
  windowStart: number
  /** 滑动窗口终点（unix ms）= current.ingestedAt */
  windowEnd: number
  /** top-k 候选 + 评分（按 similarity 降序） */
  candidates: CorrelationCandidate[]
  verdict: CorrelationVerdict
  /** verdict.kind === "chained_suspect" 的 shortcut */
  chainedSuspect: boolean
}
