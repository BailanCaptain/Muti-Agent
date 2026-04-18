import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiRuntime } from "./gemini-runtime";

function stageSessionFile(opts: {
  projectDir: string;
  sessionId: string;
  messages: unknown[];
}): string {
  const home = mkdtempSync(join(tmpdir(), "gemini-rt-thinking-"));
  const chatsDir = join(home, ".gemini", "tmp", opts.projectDir, "chats");
  mkdirSync(chatsDir, { recursive: true });
  writeFileSync(
    join(chatsDir, `session-${opts.sessionId}.json`),
    JSON.stringify({ sessionId: opts.sessionId, messages: opts.messages }),
  );
  return home;
}

describe("GeminiRuntime.afterRun — thinking from session file", () => {
  it("emits one activity line with formatted thoughts when session has them", async () => {
    const home = stageSessionFile({
      projectDir: "testproj",
      sessionId: "sid-abc",
      messages: [
        { id: "u1", type: "user", content: "hi" },
        {
          id: "g1",
          type: "gemini",
          content: "hello",
          thoughts: [
            { subject: "Greeting", description: "Saying hi back." },
            { subject: "Tone", description: "Keep it friendly." },
          ],
        },
      ],
    });

    const runtime = new GeminiRuntime({ home, projectDir: "testproj" });
    const emitted: string[] = [];
    await runtime.afterRun({ sessionId: "sid-abc" }, (line) => {
      emitted.push(line);
    });

    assert.equal(emitted.length, 1);
    assert.equal(
      emitted[0],
      "### 1. Greeting\n\nSaying hi back.\n\n### 2. Tone\n\nKeep it friendly.",
    );
  });

  it("emits nothing when session file missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-rt-thinking-"));
    const runtime = new GeminiRuntime({ home, projectDir: "none" });
    const emitted: string[] = [];
    await runtime.afterRun({ sessionId: "no-such" }, (line) => {
      emitted.push(line);
    });
    assert.deepEqual(emitted, []);
  });

  it("emits nothing when sessionId is null", async () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-rt-thinking-"));
    const runtime = new GeminiRuntime({ home, projectDir: "x" });
    const emitted: string[] = [];
    await runtime.afterRun({ sessionId: null }, (line) => {
      emitted.push(line);
    });
    assert.deepEqual(emitted, []);
  });

  it("emits nothing when last gemini message has empty thoughts array", async () => {
    const home = stageSessionFile({
      projectDir: "testproj",
      sessionId: "sid-empty",
      messages: [{ id: "g1", type: "gemini", content: "hi", thoughts: [] }],
    });
    const runtime = new GeminiRuntime({ home, projectDir: "testproj" });
    const emitted: string[] = [];
    await runtime.afterRun({ sessionId: "sid-empty" }, (line) => {
      emitted.push(line);
    });
    assert.deepEqual(emitted, []);
  });
});
