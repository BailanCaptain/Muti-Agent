"use client"

import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"

/** /digest 落地页：取最新归档日重定向；没有归档给引导空态 */
export default function DigestIndexPage() {
  const router = useRouter()
  const [empty, setEmpty] = useState(false)

  useEffect(() => {
    const apiBase = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"
    let cancelled = false
    fetch(`${apiBase}/api/daily-digest/dates`)
      .then(async (res) => (res.ok ? ((await res.json()) as { dates: string[] }).dates : []))
      .then((dates) => {
        if (cancelled) return
        if (dates.length > 0) router.replace(`/digest/${dates[0]}`)
        else setEmpty(true)
      })
      .catch(() => {
        if (!cancelled) setEmpty(true)
      })
    return () => {
      cancelled = true
    }
  }, [router])

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken">
      <p className="text-sm text-slate-500">
        {empty ? "还没有日报归档——首封日报发出后这里会亮起来。" : "正在打开最新一期…"}
      </p>
    </div>
  )
}
