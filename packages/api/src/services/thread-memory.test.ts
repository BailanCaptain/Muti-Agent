import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { appendSession, type ThreadMemory } from "./thread-memory"
import type { ExtractiveDigestV1 } from "./transcript-writer"

const makeDigest = (
  sessionId: string,
  start: string,
  end: string,
  tools: string[],
  files: string[],
  errs: number,
): ExtractiveDigestV1 => ({
  v: 1,
  sessionId,
  threadId: "t1",
  time: { createdAt: start, sealedAt: end },
  invocations: [{ toolNames: tools }],
  filesTouched: files.map((f) => ({ path: f, ops: ["edit"] })),
  errors: Array.from({ length: errs }, (_, i) => ({ at: start, message: `err${i}` })),
})

describe("appendSession (F018 AC2)", () => {
  it("AC2.2: formats new session as single line with time/tools/files/errors", () => {
    const digest = makeDigest(
      "s1",
      "2026-04-17T10:00:00Z",
      "2026-04-17T10:15:00Z",
      ["edit", "bash"],
      ["a.ts", "b.ts"],
      1,
    )
    const result = appendSession(null, digest, 180000)
    assert.match(result.summary, /Session #1.*10:00-10:15.*15min.*edit.*bash.*a\.ts.*b\.ts.*1 errors/)
    assert.equal(result.sessionCount, 1)
    assert.equal(result.lastUpdatedAt, "2026-04-17T10:15:00Z")
  })

  it("prepends new session to existing (newest first)", () => {
    const existing: ThreadMemory = {
      summary: "Session #1 (09:00-09:10, 10min): read. Files: x.ts. 0 errors.",
      sessionCount: 1,
      lastUpdatedAt: "2026-04-17T09:10:00Z",
    }
    const result = appendSession(
      existing,
      makeDigest("s2", "2026-04-17T10:00:00Z", "2026-04-17T10:15:00Z", ["edit"], ["b.ts"], 0),
      180000,
    )
    const lines = result.summary.split("\n")
    assert.ok(lines[0].includes("Session #2"), "newest at top")
    assert.ok(lines[1].includes("Session #1"), "older below")
    assert.equal(result.sessionCount, 2)
  })

  it("AC2.3: token cap formula Math.max(1200, Math.min(3000, floor(maxPrompt * 0.03)))", () => {
    // maxPrompt=40000 → cap = max(1200, min(3000, 1200)) = 1200 tokens ≈ 4800 chars
    let acc: ThreadMemory | null = null
    for (let i = 0; i < 100; i++) {
      const h = String(i % 24).padStart(2, "0")
      acc = appendSession(
        acc,
        makeDigest(`s${i}`, `2026-04-17T${h}:00:00Z`, `2026-04-17T${h}:10:00Z`, ["x"], ["a.ts"], 0),
        40000,
      )
    }
    assert.ok(acc)
    const tokens = Math.ceil(acc!.summary.length / 4)
    assert.ok(tokens <= 1250, `expected <= ~1200, got ${tokens}`)
  })

  it("AC2.4: drops oldest (tail) lines when over cap", () => {
    let acc: ThreadMemory | null = null
    for (let i = 0; i < 100; i++) {
      const h = String(i % 24).padStart(2, "0")
      acc = appendSession(
        acc,
        makeDigest(`s${i}`, `2026-04-17T${h}:00:00Z`, `2026-04-17T${h}:10:00Z`, ["x"], ["a.ts"], 0),
        40000,
      )
    }
    const lineCount = acc!.summary.split("\n").length
    assert.ok(lineCount < 100, `expected < 100 lines (some dropped), got ${lineCount}`)
    // sessionCount 保持为 100 (逻辑计数器)
    assert.equal(acc!.sessionCount, 100)
    // 最旧 Session #1 应已从尾部丢弃；用 \b 防止匹配到 Session #10/11/...
    assert.ok(!/Session #1\b/.test(acc!.summary), "oldest Session #1 should be dropped from tail")
    // 最新 Session #100 应在顶部
    assert.ok(acc!.summary.startsWith("Session #100"), "newest session at top")
  })

  it("AC2.4: truncates single line with ... when still too long", () => {
    // 2000 tools * ~10 chars/tool (" toolXXXX," pattern) > 4800 char cap
    const hugeDigest = makeDigest(
      "s1",
      "2026-04-17T10:00:00Z",
      "2026-04-17T10:15:00Z",
      Array.from({ length: 2000 }, (_, i) => `toolname${i}`),
      [],
      0,
    )
    const result = appendSession(null, hugeDigest, 40000)
    assert.ok(result.summary.endsWith("..."), "single over-cap line must end with ...")
    const tokens = Math.ceil(result.summary.length / 4)
    assert.ok(tokens <= 1200, `truncated line should not exceed cap, got ${tokens}`)
  })

  it("handles null existing (first session)", () => {
    const result = appendSession(
      null,
      makeDigest("s1", "2026-04-17T10:00:00Z", "2026-04-17T10:05:00Z", ["read"], ["a.ts"], 0),
      180000,
    )
    assert.equal(result.sessionCount, 1)
    assert.ok(result.summary.startsWith("Session #1"))
    assert.ok(!result.summary.includes("\n"), "first session is a single line")
  })

  it("AC2.4 Unicode: char-level truncate must not split surrogate pairs (emoji/non-BMP)", () => {
    // Build a single digest whose line is dominated by 4-byte emoji. Target > 4800 char cap
    // so the char-level truncate path fires. Each 🎉 is a surrogate pair (2 UTF-16 code units).
    // Must be unique (formatDigestLine dedupes via Set), so suffix with index.
    const emojiTools = Array.from({ length: 3000 }, (_, i) => `🎉t${i}`)
    const digest = makeDigest(
      "s1",
      "2026-04-17T10:00:00Z",
      "2026-04-17T10:15:00Z",
      emojiTools,
      [],
      0,
    )
    const result = appendSession(null, digest, 40000)
    // Converting to code points then back must not throw / must not contain lone surrogates.
    // `Array.from(str)` iterates by code point and `String.fromCodePoint(...)` round-trips.
    // If truncation cut a surrogate, we'd see a lone high surrogate (0xD800-0xDBFF) here.
    const codePoints = Array.from(result.summary)
    for (const cp of codePoints) {
      const code = cp.codePointAt(0) ?? 0
      assert.ok(
        !(code >= 0xd800 && code <= 0xdfff),
        `lone surrogate found at U+${code.toString(16)} — UTF-16 slice corrupted the string`,
      )
    }
    assert.ok(result.summary.endsWith("..."), "must still end with ... marker")
  })

  it("caps filesTouched at 5 and shows +N overflow marker", () => {
    const many = Array.from({ length: 8 }, (_, i) => `f${i}.ts`)
    const result = appendSession(
      null,
      makeDigest("s1", "2026-04-17T10:00:00Z", "2026-04-17T10:05:00Z", ["edit"], many, 0),
      180000,
    )
    assert.match(result.summary, /\+3\b/, "8 files should show +3 overflow")
  })
})
