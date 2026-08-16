"use client"

import type { ImageBlock } from "@/lib/blocks"
import { useCallback, useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { useApiResourceUrl } from "./use-api-resource-url"

function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
      role="button"
      tabIndex={0}
    >
      <img
        src={src}
        alt={alt}
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  )
}

export function ImageBlockComponent({ block }: { block: ImageBlock }) {
  const [expanded, setExpanded] = useState(false)
  const imageUrl = useApiResourceUrl(block.url)
  const open = useCallback(() => setExpanded(true), [])
  const close = useCallback(() => setExpanded(false), [])

  return (
    <>
      <figure className="my-2 max-w-full">
        <button type="button" onClick={open} className="cursor-zoom-in">
          <img
            src={imageUrl}
            alt={block.alt ?? ""}
            className="max-h-64 max-w-full rounded-lg border border-slate-200 object-contain transition hover:border-slate-400 hover:shadow-md"
          />
        </button>
        {block.alt && <figcaption className="mt-1 text-xs text-slate-500">{block.alt}</figcaption>}
        {block.meta?.viewport && (
          <span className="text-micro text-slate-600">
            {block.meta.viewport.width}&times;{block.meta.viewport.height}
          </span>
        )}
      </figure>

      {expanded && imageUrl && (
        <ImageLightbox src={imageUrl} alt={block.alt ?? ""} onClose={close} />
      )}
    </>
  )
}
