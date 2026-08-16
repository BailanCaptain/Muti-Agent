"use client"

import type { FileBlock } from "@/lib/blocks"
import { FileText } from "lucide-react"
import { useApiResourceUrl } from "./use-api-resource-url"

/** F040 P3 AC16：文件块——文件名 + 大小 + 点击下载（download 属性带回原始名）。 */

function formatSize(bytes?: number): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FileBlockComponent({ block }: { block: FileBlock }) {
  const size = formatSize(block.size)
  const fileUrl = useApiResourceUrl(block.url)
  return (
    <a
      href={fileUrl}
      download={block.name}
      data-testid="file-block"
      className="my-2 flex max-w-sm items-center gap-3 rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2.5 transition hover:border-slate-400 hover:shadow-sm"
    >
      <FileText className="h-8 w-8 shrink-0 text-slate-400" strokeWidth={1.5} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-slate-700">{block.name}</span>
        <span className="block text-xs text-slate-400">{size ? `${size} · ` : ""}点击下载</span>
      </span>
    </a>
  )
}
