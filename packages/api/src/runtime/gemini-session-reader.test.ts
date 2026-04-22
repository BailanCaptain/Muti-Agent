import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGeminiThoughtsFromSession, formatGeminiThoughts } from "./gemini-session-reader";

const FIXTURE_PATH = join(__dirname, "__fixtures__", "gemini-session-sample.json");

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "gemini-session-test-"));
}

function chatsDirOf(home: string, projectDir: string): string {
  const dir = join(home, ".gemini", "tmp", projectDir, "chats");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Legacy layout: chats/session-<timestamp>-<sessionId前8位>.json, 文件内 sessionId 是完整 UUID. */
function stageLegacy(
  home: string,
  projectDir: string,
  sessionId: string,
  opts: { timestampSlug?: string; overrideBody?: Record<string, unknown> } = {},
): string {
  const chats = chatsDirOf(home, projectDir);
  const sample = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  const body = opts.overrideBody ?? { ...sample, sessionId };
  const slug = opts.timestampSlug ?? "2026-04-21T12-05";
  const shortSid = sessionId.slice(0, 8);
  const filePath = join(chats, `session-${slug}-${shortSid}.json`);
  writeFileSync(filePath, JSON.stringify(body));
  return filePath;
}

/** New layout: chats/<dirName>/<fileName>.json, 文件内 sessionId 是独立字符串. */
function stageNew(
  home: string,
  projectDir: string,
  dirName: string,
  fileName: string,
  body: Record<string, unknown>,
): string {
  const chats = chatsDirOf(home, projectDir);
  const subdir = join(chats, dirName);
  mkdirSync(subdir, { recursive: true });
  const filePath = join(subdir, `${fileName}.json`);
  writeFileSync(filePath, JSON.stringify(body));
  return filePath;
}

describe("readGeminiThoughtsFromSession — real CLI layouts", () => {
  it("legacy layout: matches by file-content sessionId, not by filename", async () => {
    const home = makeHome();
    const sid = "dab662fe-0259-450d-b915-aa938a602db8";
    stageLegacy(home, "multi-agent", sid);

    const thoughts = await readGeminiThoughtsFromSession(sid, {
      home,
      projectDir: "multi-agent",
    });
    assert.equal(thoughts.length, 2);
    assert.equal(thoughts[0].subject, "Analyzing User Request");
    assert.match(thoughts[0].description ?? "", /dissecting the request/);
    assert.equal(thoughts[1].subject, "Planning Response Structure");
  });

  it("legacy layout: picks the correct file when multiple sessions coexist", async () => {
    const home = makeHome();
    const sample = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    const targetSid = "aaaaaaaa-1111-2222-3333-444444444444";
    const otherSid = "bbbbbbbb-9999-8888-7777-666666666666";

    // Other sessions in same directory (wrong content) — must not be returned.
    stageLegacy(home, "multi-agent", otherSid, {
      timestampSlug: "2026-04-20T10-00",
      overrideBody: {
        ...sample,
        sessionId: otherSid,
        messages: [
          {
            id: "g1",
            type: "gemini",
            thoughts: [{ subject: "WRONG", description: "should not appear" }],
          },
        ],
      },
    });
    stageLegacy(home, "multi-agent", targetSid, {
      timestampSlug: "2026-04-21T15-30",
    });

    const thoughts = await readGeminiThoughtsFromSession(targetSid, {
      home,
      projectDir: "multi-agent",
    });
    assert.equal(thoughts.length, 2);
    assert.equal(thoughts[0].subject, "Analyzing User Request");
  });

  it("new layout: matches by file-content sessionId inside UUID subdirectory", async () => {
    const home = makeHome();
    const sid = "hr5vby";
    stageNew(home, "multi-agent", "74094079-bcf8-4ee2-b9ab-79581f6bd69f", "hr5vby", {
      sessionId: sid,
      messages: [
        {
          id: "g1",
          type: "gemini",
          thoughts: [
            { subject: "NewLayout", description: "reads from UUID subdir" },
          ],
        },
      ],
    });

    const thoughts = await readGeminiThoughtsFromSession(sid, {
      home,
      projectDir: "multi-agent",
    });
    assert.equal(thoughts.length, 1);
    assert.equal(thoughts[0].subject, "NewLayout");
  });

  it("returns [] when no file has a matching sessionId", async () => {
    const home = makeHome();
    stageLegacy(home, "multi-agent", "some-other-sid-uuid-xxxx");
    const thoughts = await readGeminiThoughtsFromSession(
      "nonexistent-sid-uuid-yyyy",
      { home, projectDir: "multi-agent" },
    );
    assert.deepEqual(thoughts, []);
  });

  it("returns [] when chats directory itself does not exist", async () => {
    const home = makeHome();
    const thoughts = await readGeminiThoughtsFromSession("any-sid", {
      home,
      projectDir: "never-created",
    });
    assert.deepEqual(thoughts, []);
  });

  it("returns [] when matched file has gemini message without thoughts", async () => {
    const home = makeHome();
    const sid = "cccccccc-1111-2222-3333-444444444444";
    stageLegacy(home, "multi-agent", sid, {
      overrideBody: {
        sessionId: sid,
        messages: [
          { id: "u1", type: "user", content: "hi" },
          { id: "g1", type: "gemini", content: "hello" },
        ],
      },
    });
    const thoughts = await readGeminiThoughtsFromSession(sid, {
      home,
      projectDir: "multi-agent",
    });
    assert.deepEqual(thoughts, []);
  });

  it("skips unparseable JSON files without throwing", async () => {
    const home = makeHome();
    const chats = chatsDirOf(home, "multi-agent");
    writeFileSync(join(chats, "session-2026-04-21T00-00-garbage.json"), "{ not json");
    const sid = "ffffffff-0000-0000-0000-000000000000";
    stageLegacy(home, "multi-agent", sid);

    const thoughts = await readGeminiThoughtsFromSession(sid, {
      home,
      projectDir: "multi-agent",
    });
    assert.equal(thoughts.length, 2);
    assert.equal(thoughts[0].subject, "Analyzing User Request");
  });
});

describe("formatGeminiThoughts — numbered H3 headings (candidate 1)", () => {
  it("renders each thought as '### N. Subject' + blank line + description", () => {
    const out = formatGeminiThoughts([
      { subject: "Analyzing", description: "I'm dissecting..." },
      { subject: "Planning", description: "Next I will..." },
    ]);
    assert.equal(
      out,
      "### 1. Analyzing\n\nI'm dissecting...\n\n### 2. Planning\n\nNext I will...",
    );
  });

  it("handles missing subject (description only, no heading)", () => {
    const out = formatGeminiThoughts([{ description: "just a thought" }]);
    assert.equal(out, "just a thought");
  });

  it("handles missing description (heading only)", () => {
    const out = formatGeminiThoughts([{ subject: "Heading" }]);
    assert.equal(out, "### 1. Heading");
  });

  it("returns empty string for empty array", () => {
    assert.equal(formatGeminiThoughts([]), "");
  });

  it("skips thoughts with both fields empty/whitespace, renumbering sequentially", () => {
    const out = formatGeminiThoughts([
      { subject: "Real", description: "content" },
      { subject: "   ", description: "" },
      { subject: "Second", description: "valid" },
    ]);
    assert.equal(
      out,
      "### 1. Real\n\ncontent\n\n### 2. Second\n\nvalid",
    );
  });
});
