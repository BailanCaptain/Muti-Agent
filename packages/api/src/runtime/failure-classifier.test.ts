import assert from "node:assert/strict";
import test from "node:test";
import { classifyFailure } from "./failure-classifier";

test("classifyFailure routes Gemini RESOURCE_EXHAUSTED to context_exhausted (B002)", () => {
  // B002 root cause: the CLI-level fast-fail error that reaches the classifier is
  // injected by formatFastFailMessage as "Google API RESOURCE_EXHAUSTED（配额/容量耗尽）".
  // We can't distinguish account-level quota from context-length exhaustion from this
  // string alone, so we err on the side of clearing session — strictly safer (either
  // fixes context-driven exhaustion or is a free no-op on account-level limits).
  const message = "Agent CLI 触发已知的致命错误（Google API RESOURCE_EXHAUSTED（配额/容量耗尽）），已提前终止避免陷入长时间重试循环。请重试一次。";
  const result = classifyFailure("", message);
  assert.equal(result.class, "context_exhausted");
  assert.equal(result.shouldClearSession, true, "B002: must clear session so next turn starts fresh with rolling summary");
  assert.equal(result.safeToRetry, true);
});

test("classifyFailure routes raw Gemini CLI stderr (429 + MODEL_CAPACITY_EXHAUSTED) to context_exhausted", () => {
  const stderr = `
[API Error] 429 Too Many Requests — Status: RESOURCE_EXHAUSTED
You exceeded your current quota. Please retry after 47s.
Details: MODEL_CAPACITY_EXHAUSTED
`;
  const result = classifyFailure(stderr, "");
  assert.equal(result.class, "context_exhausted");
  assert.equal(result.shouldClearSession, true);
  assert.equal(result.safeToRetry, true);
});

test("classifyFailure detects session-not-found on Claude resume failure", () => {
  const stderr = "Error: session does not exist: abc-123";
  const result = classifyFailure(stderr, "");
  assert.equal(result.class, "session_corrupt");
  assert.equal(result.shouldClearSession, true);
  assert.equal(result.safeToRetry, true);
});

test("classifyFailure detects context window exhaustion", () => {
  const stderr = "Error: context window exceeded (150000 > 128000)";
  const result = classifyFailure(stderr, "");
  assert.equal(result.class, "context_exhausted");
  assert.equal(result.shouldClearSession, true);
});

test("classifyFailure detects stall-killed error from runtime marker", () => {
  const message =
    "[runtime] Agent 进程看起来已卡住（CPU 空转，无新输出 ≥ 180 秒）。请重试一次。";
  const result = classifyFailure("", message);
  assert.equal(result.class, "stall_killed");
  assert.equal(result.shouldClearSession, true);
});

test("classifyFailure detects auth failure — fresh session cannot help", () => {
  const stderr = "401 Unauthorized: Invalid API key";
  const result = classifyFailure(stderr, "");
  assert.equal(result.class, "auth_failed");
  assert.equal(result.shouldClearSession, false, "clearing session doesn't help auth failures");
  assert.equal(result.safeToRetry, false);
});

test("classifyFailure falls through to 'unknown' for unrecognized errors", () => {
  const result = classifyFailure("generic network glitch", "");
  assert.equal(result.class, "unknown");
  assert.equal(result.shouldClearSession, false, "F004: unknown must preserve session — clearing throws away history");
  assert.equal(result.safeToRetry, true);
});

test("unknown failures no longer clear session (F004/AC4)", () => {
  // F004 reversal of B002-era behavior: any error that doesn't match a known pattern
  // used to clear native_session_id "just in case". That turned every unrecognized
  // transient network blip into an amnesia event, because direct-turn prompts relied
  // on --resume as the only memory channel. Post-F004, direct-turn injects history
  // from SQLite, so clearing session on 'unknown' throws away history for no gain.
  const result = classifyFailure("some random gibberish that matches nothing", "");
  assert.equal(result.class, "unknown");
  assert.equal(result.shouldClearSession, false, "unknown errors must preserve session");
  assert.equal(result.safeToRetry, true);
});

test("classifyFailure prioritises stall over generic rate-limit wording", () => {
  // Both patterns could theoretically match ("卡住" + "too many requests"), but a stall kill
  // is the more specific/actionable classification — the CPU-flat kill is stronger signal.
  const stderr = "[runtime] Agent 进程看起来已卡住；also 429 too many requests earlier";
  const result = classifyFailure(stderr, "");
  assert.equal(result.class, "stall_killed");
});

test("classifyFailure handles both haystacks (stderr + errorMessage) together", () => {
  const stderr = "...lots of retry spam...";
  const errorMessage = "Error: quota exceeded for this project";
  const result = classifyFailure(stderr, errorMessage);
  assert.equal(result.class, "context_exhausted", "quota exhaustion is capacity-like, clear session to be safe");
  assert.equal(result.shouldClearSession, true);
});

test("classifyFailure is case-insensitive for English patterns", () => {
  assert.equal(classifyFailure("RESOURCE_EXHAUSTED", "").class, "context_exhausted");
  assert.equal(classifyFailure("Rate Limit Exceeded", "").class, "rate_limited", "plain RPS rate-limit stays in rate_limited");
  assert.equal(classifyFailure("SESSION NOT FOUND", "").class, "session_corrupt");
});

test("classifyFailure keeps true RPS signals in rate_limited (shouldClearSession=false)", () => {
  // Pure "too many requests" with no exhaustion wording → account-level RPS,
  // not a session/context problem. Clearing session wouldn't help; let user wait.
  const result = classifyFailure("", "HTTP 429: too many requests, please slow down");
  assert.equal(result.class, "rate_limited");
  assert.equal(result.shouldClearSession, false);
  assert.equal(result.safeToRetry, false);
});

test("classifyFailure ignores 'session' in unrelated contexts", () => {
  // e.g. "session started", "new session", "current session" — not failures.
  const result = classifyFailure("starting new session...", "");
  assert.equal(result.class, "unknown");
});

// B017: three CLI families emit DIFFERENT phrasing when --resume can't find the
// session on disk. The classifier was provider-agnostic in intent but the regex
// only caught "session ... (not found|...)" — Claude's actual wording has
// "session" AFTER "found", so it fell to unknown and (post-F004) didn't clear.
// These tests pin the real stderr strings captured by probing each CLI on
// 2026-04-18 with a synthetic bad UUID — see docs/bugReport/B017-*.md.

test("B017: Claude CLI 'No conversation found with session ID' → session_corrupt", () => {
  const stderr = "No conversation found with session ID: 00000000-0000-0000-0000-000000000000";
  const result = classifyFailure(stderr, "");
  assert.equal(result.class, "session_corrupt", "must catch Claude's actual wording");
  assert.equal(result.shouldClearSession, true);
  assert.equal(result.safeToRetry, true);
});

test("B017: Claude CLI structured error_during_execution subtype → session_corrupt", () => {
  // The result envelope itself carries subtype:"error_during_execution" — a
  // structural signal that's harder to break than English text.
  const stderr = '{"subtype":"error_during_execution","errors":["some claude internal"]}';
  const result = classifyFailure(stderr, "");
  assert.equal(result.class, "session_corrupt");
  assert.equal(result.shouldClearSession, true);
});

test("B017: Codex CLI 'no rollout found for thread id' → session_corrupt", () => {
  const stderr = "Error: thread/resume: thread/resume failed: no rollout found for thread id 00000000-0000-0000-0000-000000000000";
  const result = classifyFailure(stderr, "");
  assert.equal(result.class, "session_corrupt", "must catch Codex 'no rollout' wording");
  assert.equal(result.shouldClearSession, true);
});

test("B017: Gemini CLI 'Invalid session identifier' → session_corrupt", () => {
  // Gemini exits 0 so this is the ONLY line of defence for Gemini; miss it and
  // Gemini enters the death loop.
  const stderr = 'Error resuming session: Invalid session identifier "00000000-0000-0000-0000-000000000000". Searched for sessions in ...';
  const result = classifyFailure(stderr, "");
  assert.equal(result.class, "session_corrupt", "must catch Gemini 'invalid session identifier' wording (Gemini's only defence)");
  assert.equal(result.shouldClearSession, true);
});

test("B017: existing 'session does not exist' wording still caught (no regression)", () => {
  const result = classifyFailure("Error: session does not exist: abc-123", "");
  assert.equal(result.class, "session_corrupt");
});
