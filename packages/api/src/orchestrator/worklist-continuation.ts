/**
 * F026 P2 Step 1B.4 / 1B.6 · worklist 续推 prompt 合成（纯函数）。
 *
 * 当 worklist 进入 done 终态后，message-service 触发 parent agent 续推整合
 * reply。本函数把"已完成的 children alias 列表"合成为给 parent 看的
 * continuation prompt，作为 runThreadTurn 的 content 参数注入 parent thread。
 *
 * 1B.6 Fix-2（选项 Y · 纯指针化）：
 *   prompt **不再 inline child reply 内容** —— 因为 directTurn envelope 已经
 *   把整个 sessionGroup 历史送进 LLM（含 children 刚发的 reply），inline 一份
 *   就是双倍冗余。LLM 看到指针 + 历史后就能正确关联。
 *
 *   多人版（N≥2）：
 *     [桂芬、范德彪 已完成你之前 [Call: @桂芬] [Call: @范德彪] 派发的任务，
 *     他们的回复在你刚才的对话历史里。
 *     请基于此整合最终给用户的回复。]
 *
 *   单人版（N=1）：
 *     [桂芬 已完成你之前 [Call: @桂芬] 派发的任务，
 *     他的回复在你刚才的对话历史里。
 *     请基于此整合最终给用户的回复。]
 *
 * 设计原则：
 *   - 用 [Call: @X] 协议词触发 parent 的"我之前调用过这个 child" 上下文记忆
 *     （F003 旧 return-path-payload 也用类似模式，spec line 248 取代历史）
 *   - 一句话指令 "请基于此整合最终给用户的回复" 让 parent 知道这是 chain
 *     最后一程而不是新一轮独立 turn
 *   - 不夹塞 system prompt 元数据（保持"A2A 对 agent 透明"原则,
 *     spec line 16 + ADR-004）
 *   - 不 inline child reply（Y 选项核心）—— prompt 长度恒定，N children 也只增 [Call:@] 标签
 *
 * Pure — no side effects — 单测易写。
 */
export function buildWorklistContinuationPrompt(input: {
  childAliases: string[]
}): string {
  const list = (input.childAliases ?? [])
    .map((alias) => (alias ?? "").trim())
    .filter((alias) => alias.length > 0)

  if (list.length === 0) {
    // Defensive 兜底：空 alias 列表（生产路径不该走到这；register 时 queued 空已被 skip）。
    // 给 parent 一个最小可读 prompt，避免空 content runThreadTurn。
    return "请基于刚才的对话历史整合最终给用户的回复。"
  }

  const callTags = list.map((alias) => `[Call: @${alias}]`).join(" ")
  const aliasJoin = list.join("、")
  const subject = list.length === 1 ? "他的回复" : "他们的回复"
  return [
    `[${aliasJoin} 已完成你之前 ${callTags} 派发的任务，${subject}在你刚才的对话历史里。`,
    "请基于此整合最终给用户的回复。]",
  ].join("\n")
}
