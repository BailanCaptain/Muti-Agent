import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildTitlePromptFromRecentMessages } from "./build-title-prompt"

type Msg = { createdAt: string; role: string; content: string; messageType: string }

function makeRepo(messages: Msg[]) {
  return {
    listThreadsByGroup: (_id: string) => [
      { id: "t1", provider: "claude", alias: "claude" },
    ],
    listMessages: (_threadId: string) => messages,
  } as unknown as Parameters<typeof buildTitlePromptFromRecentMessages>[1]
}

describe("buildTitlePromptFromRecentMessages (AC-14d/14e prefix classification)", () => {
  const repo = makeRepo([
    { createdAt: "2026-04-20T00:00:00Z", role: "user", content: "帮我写个登录页", messageType: "final" },
    { createdAt: "2026-04-20T00:00:01Z", role: "assistant", content: "好的，先做 form", messageType: "final" },
  ])

  it("includes classification labels F/B/D/Q", () => {
    const prompt = buildTitlePromptFromRecentMessages("g1", repo)
    assert.match(prompt, /F-|F\{编号\}-/, "missing F label")
    assert.match(prompt, /B-|B\{编号\}-/, "missing B label")
    assert.match(prompt, /D-/, "missing D- label")
    assert.match(prompt, /Q-/, "missing Q- label")
  })

  it("instructs Haiku to fall back to D- when unsure", () => {
    const prompt = buildTitlePromptFromRecentMessages("g1", repo)
    assert.match(prompt, /判不准.*D-/s, "missing D- fallback instruction")
  })

  it("AC-14e: instructs Haiku to preserve F\\d+/B\\d+ ids from conversation", () => {
    const prompt = buildTitlePromptFromRecentMessages("g1", repo)
    assert.match(prompt, /F\\d\+|F\{编号\}/, "missing F\\d+ id rule")
    assert.match(prompt, /B\\d\+|B\{编号\}/, "missing B\\d+ id rule")
    assert.match(prompt, /原样照抄|照抄/, "missing verbatim-id instruction")
  })

  it("AC-14e: instructs that unfiled F/B fall back to D- (no bare F-/B-)", () => {
    const prompt = buildTitlePromptFromRecentMessages("g1", repo)
    assert.match(prompt, /没有.*编号.*D-/s, "missing unfiled-F/B fallback rule")
  })

  it("specifies output format {prefix}-{description} with ≤8 char description", () => {
    const prompt = buildTitlePromptFromRecentMessages("g1", repo)
    assert.match(prompt, /\{前缀\}-/, "missing output format template")
    assert.match(prompt, /≤\s*8\s*字/, "missing 8-char description constraint")
  })

  it("still includes recent transcript messages", () => {
    const prompt = buildTitlePromptFromRecentMessages("g1", repo)
    assert.match(prompt, /帮我写个登录页/)
    assert.match(prompt, /好的，先做 form/)
  })

  it("handles empty transcript gracefully", () => {
    const empty = makeRepo([])
    const prompt = buildTitlePromptFromRecentMessages("g1", empty)
    assert.match(prompt, /无有效消息|F-|D-/)
  })
})
