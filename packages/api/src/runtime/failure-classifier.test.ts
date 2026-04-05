import assert from "node:assert/strict";
import test from "node:test";
import { classifyFailure } from "./failure-classifier";

test("classifyFailure detects Gemini 429 MODEL_CAPACITY_EXHAUSTED from stderr", () => {
  const stderr = `
[API Error] 429 Too Many Requests — Status: RESOURCE_EXHAUSTED
You exceeded your current quota. Please retry after 47s.
Details: MODEL_CAPACITY_EXHAUSTED
`;
  const result = classifyFailure(stderr, "");
  assert.equal(result.class, "rate_limited");
  assert.equal(result.shouldClearSession, false, "rate-limit is not a session problem");
  assert.equal(result.safeToRetry, false, "user must wait before retrying");
  assert.match(result.userMessage, /限流/);
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
  assert.equal(result.shouldClearSession, true, "unknown defaults to safe session reset");
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
  assert.equal(result.class, "rate_limited");
});

test("classifyFailure is case-insensitive for English patterns", () => {
  assert.equal(classifyFailure("RESOURCE_EXHAUSTED", "").class, "rate_limited");
  assert.equal(classifyFailure("Rate Limit Exceeded", "").class, "rate_limited");
  assert.equal(classifyFailure("SESSION NOT FOUND", "").class, "session_corrupt");
});

test("classifyFailure ignores 'session' in unrelated contexts", () => {
  // e.g. "session started", "new session", "current session" — not failures.
  const result = classifyFailure("starting new session...", "");
  assert.equal(result.class, "unknown");
});
