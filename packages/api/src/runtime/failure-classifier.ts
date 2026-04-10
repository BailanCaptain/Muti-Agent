/**
 * Reactive self-heal: classify a failed turn's error signature so we can give the user an
 * actionable hint and decide what state to reset. This is the safety net beneath Phase 1
 * (liveness probe) and Phase 2 (preventive seal) — when neither caught the problem, we
 * still want to clear obviously-broken state and not keep retrying into the same wall.
 *
 * The classifier is deliberately a thin pattern matcher. It runs against the turn's
 * stderr + thrown-error message (lowercased) and is provider-agnostic, because every CLI
 * surfaces rate-limit / quota / session-recovery failures through a slightly different
 * wire format but with very similar English keywords.
 */

export type FailureClass =
  /** 429 / RESOURCE_EXHAUSTED / QUOTA — wait, don't hammer. */
  | "rate_limited"
  /** CLI couldn't resume a saved session (id unknown / expired / corrupted). */
  | "session_corrupt"
  /** Context window filled past the point the CLI can continue. */
  | "context_exhausted"
  /** Phase 1 liveness probe force-killed the child. */
  | "stall_killed"
  /** Auth / credential failure — fresh session won't help, user needs to re-auth. */
  | "auth_failed"
  /** Couldn't match any known pattern. Treat as a transient error. */
  | "unknown";

export type FailureClassification = {
  class: FailureClass;
  /**
   * True if we should drop the thread's native_session_id so the next turn starts fresh.
   * False when resetting the session wouldn't help (auth failure, rate limit against
   * the account as a whole).
   */
  shouldClearSession: boolean;
  /**
   * True if retrying the same prompt is reasonable. False when user must act (wait,
   * re-auth, reduce payload).
   */
  safeToRetry: boolean;
  /** Short Chinese sentence to surface in the chat. */
  userMessage: string;
};

// Ordered by specificity — stall patterns run first so a stall-killed turn isn't
// mistaken for "unknown".
const PATTERNS: Array<{ match: RegExp; cls: FailureClass }> = [
  {
    match: /\[runtime\][^\n]*(卡住|睡着|异常退出)/,
    cls: "stall_killed"
  },
  // Capacity / quota / context — checked BEFORE rate_limited on purpose: when the raw
  // stderr carries BOTH "429 too many requests" and "RESOURCE_EXHAUSTED", capacity wins
  // because clearing session is strictly safer (fixes context-driven cases and is a
  // free no-op on account-level quota). B002.
  // Intentionally no naked "429" here — it's ambiguous; plain RPS 429s fall through to
  // rate_limited below.
  {
    match:
      /(resource[_ ]exhausted|model[_ ]capacity[_ ]exhausted|capacity[_ ]exhausted|quota[_ ](exceeded|exhausted)|context[_ ](window|length)[^\n]{0,40}(exceed|limit|full|too)|token[_ ]limit[^\n]{0,20}exceed|prompt is too long)/i,
    cls: "context_exhausted"
  },
  {
    match:
      /(unauthorized|forbidden|authentication[_ ]failed|invalid[_ ]api[_ ]key|oauth.{0,20}(expired|invalid)|403 forbidden|401 unauthorized)/i,
    cls: "auth_failed"
  },
  {
    match:
      /session[^\n]{0,40}(not found|expired|corrupt|invalid|cannot resume|could not resume|does not exist)/i,
    cls: "session_corrupt"
  },
  // True account-level RPS: session-agnostic, clearing wouldn't help.
  // Runs AFTER context_exhausted so capacity/quota wording is caught first.
  {
    match: /(too many requests|rpm.{0,10}exceeded|rate[_ ]?limit(?!.*exhausted))/i,
    cls: "rate_limited"
  }
];

export function classifyFailure(
  rawStderr: string,
  errorMessage: string
): FailureClassification {
  const haystack = `${rawStderr}\n${errorMessage}`;

  for (const { match, cls } of PATTERNS) {
    if (match.test(haystack)) {
      return resolve(cls);
    }
  }

  return resolve("unknown");
}

function resolve(cls: FailureClass): FailureClassification {
  switch (cls) {
    case "rate_limited":
      return {
        class: cls,
        shouldClearSession: false,
        safeToRetry: false,
        userMessage: "上游限流了（配额/QPS 被打满），先等 1-2 分钟再试；session 先保留，等解除限流继续。"
      };
    case "session_corrupt":
      return {
        class: cls,
        shouldClearSession: true,
        safeToRetry: true,
        userMessage: "CLI 说这个 session 找不到或已失效，已自动清空，下一轮会开新 session。"
      };
    case "context_exhausted":
      return {
        class: cls,
        shouldClearSession: true,
        safeToRetry: true,
        userMessage: "上游报告容量/配额耗尽（可能是 session 上下文过长，也可能是 Gemini 日配额）。已清空 session，下一轮开新房间带摘要继续；如果仍然失败，通常是日配额，次日恢复。"
      };
    case "stall_killed":
      return {
        class: cls,
        shouldClearSession: true,
        safeToRetry: true,
        userMessage: "进程被判定卡死已强制终止，session 已重置，请重试一次。"
      };
    case "auth_failed":
      return {
        class: cls,
        shouldClearSession: false,
        safeToRetry: false,
        userMessage: "CLI 认证失败（token 过期或无效），请手动重新登录后再试；清 session 也救不了。"
      };
    case "unknown":
      return {
        class: cls,
        shouldClearSession: true,
        safeToRetry: true,
        userMessage: "这一轮出错了，已清空 session 以防连锁失败，可以直接重试。"
      };
  }
}
