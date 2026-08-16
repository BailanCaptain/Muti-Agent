import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import type { ContentBlock } from "@multi-agent/shared"
import {
  type AgentMediaCallbackDependencies,
  createAgentMediaCallbacks,
} from "./agent-media-callbacks"

const uploadsDir = mkdtempSync(path.join(tmpdir(), "multi-agent-media-callbacks-"))
after(() => rmSync(uploadsDir, { recursive: true, force: true }))

function makeHarness() {
  const persisted: Array<{ messageId: string; block: ContentBlock }> = []
  const broadcasts: Parameters<AgentMediaCallbackDependencies["broadcast"]>[0][] = []
  const callbacks = createAgentMediaCallbacks({
    uploadsDir,
    getApiBaseUrl: () => "http://100.120.213.33:8787",
    captureScreenshot: async () => ({
      url: "/uploads/screenshot-1.png",
      filename: "screenshot-1.png",
      width: 1440,
      height: 900,
    }),
    listMessages: () => [
      { id: "assistant-old", role: "assistant" },
      { id: "user-latest", role: "user" },
    ],
    appendContentBlock: (messageId, block) => persisted.push({ messageId, block }),
    broadcast: (event) => broadcasts.push(event),
  })

  return { callbacks, persisted, broadcasts }
}

function mediaBlockUrl(block: ContentBlock | undefined): string {
  assert.ok(block)
  assert.notEqual(block.type, "text")
  return (block as Exclude<ContentBlock, { type: "text" }>).url
}

describe("server agent media callback persistence", () => {
  it("takeScreenshot persists and broadcasts a root-relative block while returning an absolute callback URL", async () => {
    const { callbacks, persisted, broadcasts } = makeHarness()

    const result = await callbacks.takeScreenshot({
      threadId: "thread-1",
      sessionGroupId: "group-1",
      url: "data:text/html,<h1>capture</h1>",
      alt: "Captured page",
    })

    assert.deepEqual(result, {
      ok: true,
      imageUrl: "http://100.120.213.33:8787/uploads/screenshot-1.png",
    })
    assert.equal(persisted[0]?.messageId, "assistant-old")
    assert.equal(mediaBlockUrl(persisted[0]?.block), "/uploads/screenshot-1.png")
    assert.equal(mediaBlockUrl(broadcasts[0]?.payload.block), "/uploads/screenshot-1.png")
  })

  it("sendFile persists and broadcasts a root-relative block while returning an absolute callback URL", async () => {
    const { callbacks, persisted, broadcasts } = makeHarness()

    const result = await callbacks.sendFile({
      threadId: "thread-1",
      sessionGroupId: "group-1",
      filename: "report.md",
      content: "portable attachment",
    })

    assert.match(result.fileUrl, /^http:\/\/100\.120\.213\.33:8787\/uploads\/agent-.*\.md$/)
    const relativeUrl = new URL(result.fileUrl).pathname
    assert.equal(result.name, "report.md")
    assert.equal(persisted[0]?.messageId, "assistant-old")
    assert.equal(mediaBlockUrl(persisted[0]?.block), relativeUrl)
    assert.equal(mediaBlockUrl(broadcasts[0]?.payload.block), relativeUrl)
    assert.equal(readFileSync(path.join(uploadsDir, path.basename(relativeUrl)), "utf8"), "portable attachment")
  })
})
