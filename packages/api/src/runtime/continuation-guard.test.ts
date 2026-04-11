import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContinuationGuard } from "./continuation-guard";

describe("ContinuationGuard", () => {
  it("allows first continuation on truncated", () => {
    const guard = new ContinuationGuard();
    assert.equal(guard.shouldContinue("truncated", "substantial content"), true);
  });

  it("allows continuation on aborted", () => {
    const guard = new ContinuationGuard();
    assert.equal(guard.shouldContinue("aborted", ""), true);
  });

  it("does not continue on complete", () => {
    const guard = new ContinuationGuard();
    assert.equal(guard.shouldContinue("complete", ""), false);
  });

  it("does not continue on refused", () => {
    const guard = new ContinuationGuard();
    assert.equal(guard.shouldContinue("refused", ""), false);
  });

  it("does not continue on null", () => {
    const guard = new ContinuationGuard();
    assert.equal(guard.shouldContinue(null, "stuff"), false);
  });

  it("stops after 2 consecutive short continuations", () => {
    const guard = new ContinuationGuard();
    guard.recordContinuation("short");
    guard.recordContinuation("tiny");
    assert.equal(guard.shouldContinue("truncated", "third"), false);
  });

  it("resets repeat counter when a long continuation appears", () => {
    const guard = new ContinuationGuard();
    guard.recordContinuation("short");
    guard.recordContinuation("x".repeat(100));
    guard.recordContinuation("short");
    assert.equal(guard.shouldContinue("truncated", "next"), true);
  });

  it("counts whitespace-only content as short", () => {
    const guard = new ContinuationGuard();
    guard.recordContinuation("   ");
    guard.recordContinuation("\n\n  ");
    assert.equal(guard.shouldContinue("truncated", "third"), false);
  });

  it("reset clears consecutiveShort state", () => {
    const guard = new ContinuationGuard();
    guard.recordContinuation("a");
    guard.recordContinuation("b");
    guard.reset();
    assert.equal(guard.shouldContinue("truncated", "more"), true);
  });
});
