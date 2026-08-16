import crypto from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ContentBlock } from "@multi-agent/shared"
import { resolveUploadUrl } from "../preview/resolve-upload-url"
import type { ScreenshotResult } from "../preview/screenshot-service"
import { prepareAgentFile } from "./agent-file"

type AssistantMessage = { id: string; role: string }

type AssistantContentBlockEvent = {
  type: "assistant_content_block"
  payload: {
    sessionGroupId: string
    messageId: string
    block: ContentBlock
  }
}

export type AgentMediaCallbackDependencies = {
  uploadsDir: string
  getApiBaseUrl: () => string | undefined
  captureScreenshot: (uploadsDir: string, url?: string) => Promise<ScreenshotResult>
  listMessages: (threadId: string) => AssistantMessage[]
  appendContentBlock: (messageId: string, block: ContentBlock) => void
  broadcast: (event: AssistantContentBlockEvent) => void
}

export function createAgentMediaCallbacks(deps: AgentMediaCallbackDependencies) {
  function persistBlock(threadId: string, sessionGroupId: string, block: ContentBlock) {
    const lastAssistant = [...deps.listMessages(threadId)]
      .reverse()
      .find((message) => message.role === "assistant")
    if (!lastAssistant) return

    deps.appendContentBlock(lastAssistant.id, block)
    deps.broadcast({
      type: "assistant_content_block",
      payload: {
        sessionGroupId,
        messageId: lastAssistant.id,
        block,
      },
    })
  }

  return {
    takeScreenshot: async (params: {
      threadId: string
      sessionGroupId: string
      url?: string
      alt?: string
    }) => {
      const result = await deps.captureScreenshot(deps.uploadsDir, params.url)
      const absoluteUrl = resolveUploadUrl(result.url, deps.getApiBaseUrl())
      const block: ContentBlock = {
        type: "image",
        url: result.url,
        alt: params.alt ?? "Screenshot",
        meta: {
          source: "agent_screenshot",
          timestamp: new Date().toISOString(),
          viewport: { width: result.width, height: result.height },
        },
      }

      persistBlock(params.threadId, params.sessionGroupId, block)
      return { ok: true as const, imageUrl: absoluteUrl }
    },

    sendFile: async (params: {
      threadId: string
      sessionGroupId: string
      filename?: string
      content: string
    }) => {
      const { storedName, displayName } = prepareAgentFile(
        params.filename,
        () => crypto.randomUUID(),
        () => Date.now(),
      )
      mkdirSync(deps.uploadsDir, { recursive: true })
      writeFileSync(path.join(deps.uploadsDir, storedName), params.content, "utf8")
      const relativeUrl = `/uploads/${storedName}`
      const absoluteUrl = resolveUploadUrl(relativeUrl, deps.getApiBaseUrl())
      const block: ContentBlock = {
        type: "file",
        url: relativeUrl,
        name: displayName,
        size: Buffer.byteLength(params.content, "utf8"),
      }

      persistBlock(params.threadId, params.sessionGroupId, block)
      return { ok: true as const, fileUrl: absoluteUrl, name: displayName }
    },
  }
}
