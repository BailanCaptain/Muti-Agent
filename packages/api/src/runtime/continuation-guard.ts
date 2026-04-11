import type { StopReason } from "./base-runtime";

const SHORT_THRESHOLD = 50;
const MAX_CONSECUTIVE_SHORT = 2;

export class ContinuationGuard {
  private consecutiveShort = 0;

  shouldContinue(stopReason: StopReason | null, _previousContent: string): boolean {
    if (stopReason !== "truncated" && stopReason !== "aborted") return false;
    return this.consecutiveShort < MAX_CONSECUTIVE_SHORT;
  }

  recordContinuation(appendedContent: string): void {
    const effective = appendedContent.trim().length;
    if (effective < SHORT_THRESHOLD) {
      this.consecutiveShort += 1;
    } else {
      this.consecutiveShort = 0;
    }
  }

  reset(): void {
    this.consecutiveShort = 0;
  }
}
