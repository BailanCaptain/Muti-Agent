"use client"

import type { Block } from "@/lib/blocks"
import type { Provider } from "@multi-agent/shared"
import { CardBlockComponent } from "./rich-blocks/card-block"
import { ChecklistBlockComponent } from "./rich-blocks/checklist-block"
import { DiffBlockComponent } from "./rich-blocks/diff-block"
import { FileBlockComponent } from "./rich-blocks/file-block"
import { ImageBlockComponent } from "./rich-blocks/image-block"
import { ProgressBlockComponent } from "./rich-blocks/progress-block"
import { TableBlockComponent } from "./rich-blocks/table-block"
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
          case "checklist":
            return <ChecklistBlockComponent key={index} block={block} />
          case "diff":
            return <DiffBlockComponent key={index} block={block} />
          case "image":
            return <ImageBlockComponent key={index} block={block} />
          case "file":
            return <FileBlockComponent key={index} block={block} />
          case "table":
            return <TableBlockComponent key={index} block={block} />
          case "progress":
            return <ProgressBlockComponent key={index} block={block} />
        }
      })}
    </>
  )
}
