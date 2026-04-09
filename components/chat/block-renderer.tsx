"use client"

import type { Block } from "@/lib/blocks"
import type { Provider } from "@multi-agent/shared"
import { CardBlockComponent } from "./rich-blocks/card-block"
import { DiffBlockComponent } from "./rich-blocks/diff-block"
import { MarkdownMessage } from "./markdown-message"

type BlockRendererProps = {
  blocks: Block[]
  provider: Provider
}

export function BlockRenderer({ blocks, provider }: BlockRendererProps) {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "markdown":
            return <MarkdownMessage key={index} content={block.content} />
          case "thinking":
            // Thinking is still rendered independently by message-bubble.tsx
            // (collapsible panel UI). We skip it here intentionally.
            return null
          case "card":
            return <CardBlockComponent key={index} block={block} />
          case "diff":
            return <DiffBlockComponent key={index} block={block} />
        }
      })}
    </>
  )
}
