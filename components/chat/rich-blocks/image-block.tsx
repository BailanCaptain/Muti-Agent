"use client"

import { useState, useCallback } from "react"
import type { ImageBlock } from "@/lib/blocks"

export function ImageBlockComponent({ block }: { block: ImageBlock }) {
  const [expanded, setExpanded] = useState(false)
  const toggle = useCallback(() => setExpanded((v) => !v), [])

  return (
    <>
      <figure className="my-2 max-w-full">
        <button type="button" onClick={toggle} className="cursor-zoom-in">
          <img
            src={block.url}
            alt={block.alt ?? ""}
            className="max-h-64 rounded-lg border border-zinc-700 object-contain"
          />
        </button>
        {block.alt && (
          <figcaption className="mt-1 text-xs text-zinc-500">{block.alt}</figcaption>
        )}
        {block.meta?.viewport && (
          <span className="text-[10px] text-zinc-600">
            {block.meta.viewport.width}&times;{block.meta.viewport.height}
          </span>
        )}
      </figure>

      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={toggle}
          onKeyDown={(e) => e.key === "Escape" && toggle()}
          role="button"
          tabIndex={0}
        >
          <img
            src={block.url}
            alt={block.alt ?? ""}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
          />
        </div>
      )}
    </>
  )
}
