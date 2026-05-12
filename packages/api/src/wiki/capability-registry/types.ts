/**
 * F027 P9 · alias-aware capability registry · 共享类型
 * 真相源：docs/plans/V16.5-final.md chap 13 行 1447-1525
 * AC：AC-P1-13 —— handoff 中性改写：sender alias 黄仁勋 → @桂芬 时
 *   receiver 看到的 prompt 不暴露 sender risks。
 *
 * 设计：
 *   - 6 槽位强制：role / tools_limits / must_do / must_not / top_risks /
 *     handoff_contract / capability_digest_for_self
 *   - handoff envelope 给 receiver 的形态严格 3 字段：
 *     { task, receiver_capability_digest, collaboration_contract }
 *   - sender 的 top_risks / must_not / must_do / capability_digest_for_self
 *     绝不出现在 envelope 里（V16.5 chap 13 行 1492 "risks 严禁暴露给 receiver"）
 */

/** 单个 agent 的 capability（6 槽位 + role） */
export interface AgentCapability {
  /** 角色 / 职责（自由文本） */
  role: string
  /** 工具限制：CLI / provider / 跨 provider 限制等 */
  tools_limits: string[]
  /** 必做项（agent 自身约束） */
  must_do: string[]
  /** 禁做项（agent 自身约束） */
  must_not: string[]
  /**
   * 顶层风险点：每条含 id（LL-XX 格式）+ text 描述。
   * 严禁暴露给 receiver — 攻击者拿到 sender risks 可针对性构造攻击向量。
   */
  top_risks: Array<{ id: string; text: string }>
  /** 接 / 交 handoff 时的契约（中性改写时按 receiver 视角抽取） */
  handoff_contract: string[]
  /** wake-up 时注入 self prompt 的 digest（150-250 token 摘要） */
  capability_digest_for_self: string
}

/** Registry：name → capability */
export interface CapabilityRegistry {
  /**
   * agent 名 → 6 槽位。loader 会保证 4 个固定 agent
   * （小孙 / 黄仁勋 / 范德彪 / 桂芬）都存在且 6 槽位齐全。
   */
  agents: Map<string, AgentCapability>
  /** 加载源 path（debug / error 提示用） */
  sourcePath: string
}

/** sender 端写的 raw handoff（给 rewriter 输入） */
export interface SenderHandoff {
  /** 派发人 alias（仅 metadata，不暴露 sender 内部状态） */
  senderAlias: string
  /** 接收人 alias（决定 receiver_capability_digest 取谁的） */
  receiverAlias: string
  /** 任务摘要（自由文本，但会被 sanitize 防 injection） */
  task: string
  /**
   * 上下文摘要（可选）。若提供，会进 collaboration_contract.context_summary。
   * 注意：sender 内部状态（unresolved threads / token budget / 当前 LL-XX 触发等）
   * 不能写在这里 —— rewriter 不做语义判定，只能靠 sender 自己自律 +
   * leak-detector 做 fixture 验证。
   */
  contextSummary?: string
  /**
   * 给 receiver 的额外 evidence 要求（可选）。会被 dedupe 进
   * collaboration_contract.expected_evidence。例：
   *   ["涉及 F018 schema 的结论需要 commit hash 佐证"]
   */
  expectedEvidence?: string[]
}

/** 中性改写后的 envelope（给 receiver 看的） */
export interface ReceiverHandoffEnvelope {
  /** 派发人 alias（metadata only） */
  sender_alias: string
  /** 接收人 alias */
  receiver_alias: string
  /** 任务摘要（已 sanitize） */
  task: string
  /** receiver 的 capability_digest（从 registry 拿，不含 sender 任何字段） */
  receiver_capability_digest: string
  /**
   * 协作契约 —— 严格 4 字段（V16.5 chap 13 行 1480-1490）：
   *   sender_alias / context_summary / expected_evidence /
   *   receiver_must_do / do_not_section
   * 不允许出现 sender_top_risks / sender_must_not / sender_capability 等任何 sender 内部字段。
   */
  collaboration_contract: CollaborationContract
}

export interface CollaborationContract {
  sender_alias: string
  context_summary: string
  /** 中性化的 evidence 要求（不暴露 sender 内部 risk） */
  expected_evidence: string[]
  /** 中性化抽自 receiver.must_do（这是 receiver 自己的纪律，可见无碍） */
  receiver_must_do: string[]
  /**
   * V16.5 chap 13 行 1489："任何 do_not 都不暴露"。
   * 这个字段恒空数组，留作 schema 占位 + future 政策扩展（如 receiver 的 hard ban）。
   */
  do_not_section: never[]
}

/** Registry 加载错误类 */
export class CapabilityRegistryError extends Error {
  readonly sourcePath: string
  readonly missingFields?: string[]
  readonly missingAgents?: string[]
  constructor(
    msg: string,
    args: { sourcePath: string; missingFields?: string[]; missingAgents?: string[] },
  ) {
    super(msg)
    this.name = "CapabilityRegistryError"
    this.sourcePath = args.sourcePath
    this.missingFields = args.missingFields
    this.missingAgents = args.missingAgents
  }
}

/** Handoff rewrite 错误：receiver 不在 registry */
export class UnknownReceiverError extends Error {
  readonly receiverAlias: string
  readonly knownAliases: string[]
  constructor(receiverAlias: string, knownAliases: string[]) {
    super(
      `cannot rewrite handoff: receiver "${receiverAlias}" not in capability registry. Known: ${knownAliases.join(", ")}`,
    )
    this.name = "UnknownReceiverError"
    this.receiverAlias = receiverAlias
    this.knownAliases = knownAliases
  }
}

/**
 * 范-r1 P1：dispatch 实际派发目标与 envelope.receiver_alias 不一致。
 * 攻击场景：attacker 把 envelope.receiver_alias spoof 成 "黄仁勋" 但实际派给桂芬，
 * leak-detector 会跳过黄的 risks。caller (P5/P6/runtime dispatch) 拿到实际
 * dispatch target 后必须调 assertEnvelopeReceiverConsistent 兜底。
 */
export class EnvelopeReceiverMismatchError extends Error {
  readonly envelopeReceiver: string
  readonly actualReceiver: string
  constructor(envelopeReceiver: string, actualReceiver: string) {
    super(
      `envelope.receiver_alias "${envelopeReceiver}" != actual dispatch target "${actualReceiver}"; ` +
        `possible spoofing — leak-detector will skip wrong agent's risks. caller must reject.`,
    )
    this.name = "EnvelopeReceiverMismatchError"
    this.envelopeReceiver = envelopeReceiver
    this.actualReceiver = actualReceiver
  }
}
