/**
 * B017: decide whether to keep the CLI-reported session id or clear it, given
 * the turn's outcome. Extracted from message-service.ts for isolated testing.
 *
 * Before B017, message-service required `result.nativeSessionId ===
 * thread.nativeSessionId` (id-unchanged) as a precondition for clearing on an
 * empty+abnormal turn. When Claude's error envelope minted a FRESH junk id
 * (findSessionId used to capture it — see base-runtime.ts B017 note), the
 * precondition silently failed and the junk id was persisted — next --resume
 * repeated the failure, infinite death loop.
 *
 * The fix drops the id-equality precondition. Any empty response that ended
 * with a non-zero exit code is abnormal enough to clear the session, period.
 * The Gemini case (exit=0 + empty + stderr carrying the real error) is handled
 * separately by failure-classifier (B017 Bug 3), not here.
 */
export function computeEffectiveSessionId(args: {
  content: string;
  resultExitCode: number | null;
  resultSessionId: string | null;
  threadSessionId: string | null;
}): string | null {
  const isEmptyAndAbnormal =
    !args.content.trim() &&
    args.resultExitCode !== null &&
    args.resultExitCode !== 0;
  return isEmptyAndAbnormal ? null : args.resultSessionId;
}
