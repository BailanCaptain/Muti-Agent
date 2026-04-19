import assert from "node:assert/strict";
import test from "node:test";
import { findSessionId } from "./base-runtime";

// B017: Claude CLI emits a fresh random session_id inside `{type:"result",
// subtype:"error_during_execution", is_error:true, num_turns:0, session_id:"<junk>"}`
// whenever --resume is given a missing session id. findSessionId used to capture
// that junk id recursively and our turn loop persisted it as thread.nativeSessionId,
// feeding it back to --resume next turn → infinite death loop.
// Guard: the function must skip session_id inside error-result envelopes.

test("B017: findSessionId returns null for result event with is_error=true and num_turns=0", () => {
  const event = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    num_turns: 0,
    session_id: "junk-id-minted-by-claude-for-error-payload"
  };
  assert.equal(findSessionId(event), null, "error-result junk session_id must not be captured");
});

test("B017: findSessionId skips nested error-result (recursive case)", () => {
  const event = {
    outer: true,
    payload: {
      type: "result",
      is_error: true,
      num_turns: 0,
      session_id: "nested-junk"
    }
  };
  assert.equal(findSessionId(event), null, "nested error-result junk session_id must not be captured");
});

test("B017: findSessionId still returns session_id from a normal successful result", () => {
  const event = {
    type: "result",
    is_error: false,
    num_turns: 3,
    session_id: "real-success-id"
  };
  assert.equal(findSessionId(event), "real-success-id", "successful result session_id must still be captured");
});

test("B017: findSessionId still returns session_id from system init event", () => {
  const event = {
    type: "system",
    subtype: "init",
    session_id: "real-init-id"
  };
  assert.equal(findSessionId(event), "real-init-id", "system-init session_id must still be captured");
});

test("B017: findSessionId skips is_error=true even when num_turns is missing (defensive)", () => {
  // Some CLIs might omit num_turns. Any is_error:true result event should be
  // untrusted regardless — its session_id is never the authoritative one.
  const event = {
    type: "result",
    is_error: true,
    session_id: "junk-without-num-turns"
  };
  assert.equal(findSessionId(event), null, "any error-result session_id must not be captured");
});

test("B017: plain session_id at top level (non-result event) still works", () => {
  // Delta / partial message events carry session_id directly; must not be affected.
  const event = { session_id: "plain-top-level" };
  assert.equal(findSessionId(event), "plain-top-level");
});
