/**
 * Phase 1 hard-rule header injected into A2A prompt when the entry belongs to
 * a parallel group (Mode B / ideate). Replaces the generic skill-hint line so
 * agents don't race to load full SKILL.md and play synthesizer prematurely.
 *
 * The header is the structural-layer guarantee of Phase 1 independent thinking;
 * it complements thread-per-provider + snapshot-freeze isolation.
 */
export function buildPhase1Header(totalParticipants: number): string {
  return [
    "[当前模式：并行独立思考 · Phase 1]",
    `你是 ${totalParticipants} 个 agent 中的 1 个，各自独立回答，互不可见。`,
    "",
    "规则：",
    "- 独立给出你自己的观点，不预测其他 agent 会怎么说",
    "- 禁止在回复中使用行首 @（不允许 @任何队友），你的任务是独立思考",
    "- 展示推理链（不只结论）",
    "- 标注不确定性（区分确信结论和猜测）",
    "- 只回答本问题，不要规划后续阶段，不要替村长做综合决策",
    "- 不要加载全文，只依据当前上下文和你已有的知识回答",
    "- 如果有需要村长决定的分歧（满足分歧点三条件时），用结构化格式：",
    "  ```",
    "  [分歧点] 问题描述",
    "    [A] 选项一",
    "    [B] 选项二",
    "  ```",
    "  每条 [分歧点] 必须附带至少两个 [A]/[B]/… 选项，让村长直接选",
    "",
  ].join("\n")
}
