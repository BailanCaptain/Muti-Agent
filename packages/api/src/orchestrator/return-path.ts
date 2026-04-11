import { A2AChainRegistry } from "./a2a-chain";

export type ReturnPathPlanInput = {
  chainRegistry: A2AChainRegistry;
  childInvocationId: string;
  childContent: string;
  queuedOutboundMentionCount: number;
  currentRootMessageId: string;
  activeSkillName: string | null;
};

export type ReturnPathDispatchPlan = {
  parentInvocationId: string;
  parentThreadId: string;
  parentAlias: string;
  parentSessionGroupId: string;
  prompt: string;
  childAlias: string;
};

/**
 * Decide whether a child invocation should synthesize a return-path dispatch
 * back to its parent. Returns the plan when synthesis is warranted, or null
 * when the caller should defer to the natural (outbound mention) path or do
 * nothing at all.
 *
 * Pure function — no side effects — so it can be unit-tested without standing
 * up the full MessageService.
 */
export function planReturnPathDispatch(
  input: ReturnPathPlanInput,
): ReturnPathDispatchPlan | null {
  // Child already enqueued at least one outbound mention → the mention router
  // will deliver it via the normal path; do not synthesize a duplicate.
  if (input.queuedOutboundMentionCount > 0) return null;

  if (!input.childContent.trim()) return null;

  const child = input.chainRegistry.get(input.childInvocationId);
  if (!child) return null;
  if (!child.parentInvocationId) return null;

  const parent = input.chainRegistry.getParent(input.childInvocationId);
  if (!parent) return null;

  // Parent must still be waiting on the same user root; if the user has moved
  // on to a new root message, resuming the old chain would be a surprise.
  if (parent.rootMessageId !== input.currentRootMessageId) return null;

  const skillLabel = input.activeSkillName
    ? ` 的 ${input.activeSkillName} 答复`
    : " 的答复";
  const prompt = `[${child.alias}${skillLabel}]\n\n${input.childContent}\n\n请继续你的流程。`;

  return {
    parentInvocationId: parent.invocationId,
    parentThreadId: parent.threadId,
    parentAlias: parent.alias,
    parentSessionGroupId: parent.sessionGroupId,
    prompt,
    childAlias: child.alias,
  };
}
