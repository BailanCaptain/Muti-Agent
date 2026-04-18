import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGeminiThoughtsFromSession, formatGeminiThoughts } from "./gemini-session-reader";

const FIXTURE_PATH = join(__dirname, "__fixtures__", "gemini-session-sample.json");

function stageFixture(projectDir: string, sessionId: string): string {
  const home = mkdtempSync(join(tmpdir(), "gemini-session-test-"));
  const chatsDir = join(home, ".gemini", "tmp", projectDir, "chats");
  mkdirSync(chatsDir, { recursive: true });
  const sample = readFileSync(FIXTURE_PATH, "utf8");
  writeFileSync(join(chatsDir, `session-${sessionId}.json`), sample);
  return home;
}

describe("readGeminiThoughtsFromSession", () => {
  it("extracts thoughts[] from the last gemini message in session JSON", async () => {
    const home = stageFixture("multi-agent", "fixture-abc-123");
    const thoughts = await readGeminiThoughtsFromSession("fixture-abc-123", {
      home,
      projectDir: "multi-agent",
    });
    assert.equal(thoughts.length, 2);
    assert.equal(thoughts[0].subject, "Analyzing User Request");
    assert.match(thoughts[0].description ?? "", /dissecting the request/);
    assert.equal(thoughts[1].subject, "Planning Response Structure");
  });

  it("returns empty array when session file missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-session-test-"));
    const thoughts = await readGeminiThoughtsFromSession("no-such-session", {
      home,
      projectDir: "anywhere",
    });
    assert.deepEqual(thoughts, []);
  });

  it("returns empty array when last gemini message has no thoughts field", async () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-session-test-"));
    const chatsDir = join(home, ".gemini", "tmp", "x", "chats");
    mkdirSync(chatsDir, { recursive: true });
    writeFileSync(
      join(chatsDir, "session-sid.json"),
      JSON.stringify({
        sessionId: "sid",
        messages: [
          { id: "u1", type: "user", content: "hi" },
          { id: "g1", type: "gemini", content: "hello" },
        ],
      }),
    );
    const thoughts = await readGeminiThoughtsFromSession("sid", {
      home,
      projectDir: "x",
    });
    assert.deepEqual(thoughts, []);
  });
});

describe("formatGeminiThoughts", () => {
  it("joins subject + description with markdown formatting", () => {
    const out = formatGeminiThoughts([
      { subject: "Analyzing", description: "I'm dissecting..." },
      { subject: "Planning", description: "Next I will..." },
    ]);
    assert.equal(
      out,
      "**Analyzing**\nI'm dissecting...\n\n**Planning**\nNext I will...",
    );
  });

  it("handles missing subject (description only)", () => {
    const out = formatGeminiThoughts([{ description: "just a thought" }]);
    assert.equal(out, "just a thought");
  });

  it("handles missing description (subject only)", () => {
    const out = formatGeminiThoughts([{ subject: "Heading" }]);
    assert.equal(out, "**Heading**");
  });

  it("returns empty string for empty array", () => {
    assert.equal(formatGeminiThoughts([]), "");
  });

  it("skips thoughts with both fields empty/whitespace", () => {
    const out = formatGeminiThoughts([
      { subject: "Real", description: "content" },
      { subject: "   ", description: "" },
      { subject: "Second", description: "valid" },
    ]);
    assert.equal(out, "**Real**\ncontent\n\n**Second**\nvalid");
  });
});
