"use client"

import { resolveApiResourceUrl } from "@/lib/api-endpoints"
import { useEffect, useState } from "react"

export function useApiResourceUrl(resourceUrl: string): string | undefined {
  const [resolved, setResolved] = useState<{ source: string; url: string }>()

  useEffect(() => {
    setResolved({ source: resourceUrl, url: resolveApiResourceUrl(resourceUrl) })
  }, [resourceUrl])

  return resolved?.source === resourceUrl ? resolved.url : undefined
}
