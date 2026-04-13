import { ContinuationGuard } from "./continuation-guard";
import type { RunTurnResult } from "./cli-orchestrator";

export type ContinuationRunHandle = {
  cancel: () => void;
  promise: Promise<RunTurnResult>;
};

export type RunContinuationLoopOptions = {
  initialUserMessage: string;
  createRun: (userMessage: string) => ContinuationRunHandle;
  emitStatus: (message: string) => void;
  onIterationContent: (accumulatedContent: string, latest: RunTurnResult) => void;
  onRunCreated?: (handle: ContinuationRunHandle) => void;
};

export type ContinuationStopReason =
  | "complete"
  | "guard_exhausted"
  | "sealed"
  | "sealed_auto_resumed";

export type RunContinuationLoopResult = {
  accumulatedContent: string;
  lastResult: RunTurnResult;
  iterations: number;
  stoppedReason: ContinuationStopReason;
};

const CONTINUATION_PROMPT_TEMPLATE =
  "你上一轮被截断（stop_reason=%REASON%），请无缝续写。不要重复上一轮已经输出的内容，直接接着写。";

export async function runContinuationLoop(
  options: RunContinuationLoopOptions,
): Promise<RunContinuationLoopResult> {
  const guard = new ContinuationGuard();
  let accumulatedContent = "";
  let lastResult: RunTurnResult | null = null;
  let iterations = 0;
  let loopUserMessage = options.initialUserMessage;
  let stoppedReason: ContinuationStopReason = "complete";

  while (true) {
    const handle = options.createRun(loopUserMessage);
    options.onRunCreated?.(handle);
    const result = await handle.promise;
    iterations += 1;
    lastResult = result;
    accumulatedContent += result.content;
    options.onIterationContent(accumulatedContent, result);

    if (result.sealDecision?.shouldSeal) {
      const pct = Math.round(result.sealDecision.fillRatio * 100);
      options.emitStatus(`上下文已用 ${pct}%，自动封存，续写中止。`);
      stoppedReason = "sealed";
      break;
    }

    // Record THIS turn's content against the short-content counter first, so the
    // "2 consecutive shorts → stop" rule triggers on the second short (not the third).
    guard.recordContinuation(result.content);

    if (!guard.shouldContinue(result.stopReason, accumulatedContent)) {
      if (result.stopReason === "truncated" || result.stopReason === "aborted") {
        stoppedReason = "guard_exhausted";
        options.emitStatus(
          "续写连续多次仅追加极少内容，为避免死循环已中止。",
        );
      } else {
        stoppedReason = "complete";
      }
      break;
    }

    loopUserMessage = CONTINUATION_PROMPT_TEMPLATE.replace(
      "%REASON%",
      result.stopReason ?? "unknown",
    );
    options.emitStatus(`续写中（第 ${iterations} 次）...`);
  }

  return {
    accumulatedContent,
    lastResult: lastResult!,
    iterations,
    stoppedReason,
  };
}
