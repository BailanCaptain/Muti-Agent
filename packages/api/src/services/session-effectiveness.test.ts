import assert from "node:assert/strict";
import test from "node:test";
import { computeEffectiveSessionId } from "./session-effectiveness";

// B017: Before the fix, message-service.ts:1180-1185 required the NEW session id
// to equal the OLD session id for emptyAndAbnormal to fire. When Claude's error
// result mints a FRESH session id (Bug 1 scenario), ids differ, emptyAndAbnormal
// is false, the junk id is persisted, and next --resume repeats the failure.
// The fix: drop the id-equality sub-condition. Empty + abnormal exit → clear, period.

test("B017: empty response + exit=1 + new id != old id → MUST clear (was the trap)", () => {
  // This is the exact failure mode from thread 8b43322b 2026-04-18 18:38.
  // Old logic kept result.nativeSessionId = "junk-new-id". Correct behavior = null.
  const effective = computeEffectiveSessionId({
    content: "",
    resultExitCode: 1,
    resultSessionId: "junk-new-id",
    threadSessionId: "original-id"
  });
  assert.equal(effective, null, "empty+abnormal-exit must clear regardless of id drift");
});

test("B017: empty response + exit=1 + same id (old style) → also clears (preserve old path)", () => {
  const effective = computeEffectiveSessionId({
    content: "",
    resultExitCode: 1,
    resultSessionId: "same-id",
    threadSessionId: "same-id"
  });
  assert.equal(effective, null);
});

test("B017: empty response + exit=0 → keep session (Gemini case, not our concern here)", () => {
  // Gemini exits 0 even on error; this path relies on classifier (Bug 3), not this helper.
  // The helper correctly does NOT clear on exit=0 because content emptiness alone is ambiguous.
  const effective = computeEffectiveSessionId({
    content: "",
    resultExitCode: 0,
    resultSessionId: "some-id",
    threadSessionId: "some-id"
  });
  assert.equal(effective, "some-id", "exit=0 path must not rely on this helper to clear");
});

test("B017: non-empty content + exit=1 → keep result session id (mid-reply crash)", () => {
  const effective = computeEffectiveSessionId({
    content: "partial answer here",
    resultExitCode: 1,
    resultSessionId: "partial-session",
    threadSessionId: "partial-session"
  });
  assert.equal(effective, "partial-session", "partial response session id is still meaningful");
});

test("B017: normal success (content + exit=0) → keep result session id", () => {
  const effective = computeEffectiveSessionId({
    content: "full reply",
    resultExitCode: 0,
    resultSessionId: "happy-id",
    threadSessionId: "happy-id"
  });
  assert.equal(effective, "happy-id");
});

test("B017: null exitCode (process killed before exit) → treat as non-abnormal, keep id", () => {
  // If exitCode is null we don't know the outcome; safer to keep session id and
  // let classifier / downstream decide.
  const effective = computeEffectiveSessionId({
    content: "",
    resultExitCode: null,
    resultSessionId: "uncertain-id",
    threadSessionId: "uncertain-id"
  });
  assert.equal(effective, "uncertain-id");
});
