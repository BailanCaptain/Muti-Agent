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
    "- 展示推理链（不只结论）",
    "- 标注不确定性（区分确信结论和猜测）",
    "- 回复格式：证据 → 分析 → 结论 → 置信度",
    "- 只回答本问题，不要规划后续阶段，不要替村长做综合决策",
    "- 如果有需要村长拍板的选项/取舍，单独一行以 `[拍板]` 开头列出该问题；每条一行，保持简短",
    "",
    "参考 skill: collaborative-thinking（不要加载全文，按本 header 执行）",
  ].join("\n")
}
