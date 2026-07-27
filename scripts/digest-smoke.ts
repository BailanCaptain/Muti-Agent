/**
 * F037 真网只读 smoke（手动跑，不进 CI）：
 *   npx tsx scripts/digest-smoke.ts
 * 抓常驻源 → 源健康表 → 清单版渲染落盘 .runtime/daily-digest/smoke/（不发邮件、不写 ledger/health）。
 * 用途：活体源探测 + 邮件 HTML 预览产物。
 */
import fs from "node:fs"
import path from "node:path"
import { createDigestFetchImpl } from "../packages/api/src/services/daily-digest/boot"
import { formatBusinessDate } from "../packages/api/src/services/daily-digest/business-dates"
import { resolveDigestEnv } from "../packages/api/src/services/daily-digest/email-sender"
import { runAllSources } from "../packages/api/src/services/daily-digest/orchestrator"
import { renderDigest } from "../packages/api/src/services/daily-digest/renderer"
import { createSafeHttpClient } from "../packages/api/src/net/safe-http-client"
import {
  makeGithubDailySource,
  makeGithubMonthlySource,
  makeGithubNewcomersSource,
  makeGithubWeeklySource,
} from "../packages/api/src/services/daily-digest/sources/github-trending"
import { makeRedditAiSource } from "../packages/api/src/services/daily-digest/sources/reddit-shreddit"
import {
  buildAllSources,
  deriveOutboundAllowlist,
} from "../packages/api/src/services/daily-digest/sources/registry"
import { buildFallbackSummary } from "../packages/api/src/services/daily-digest/summarizer"

async function main(): Promise<void> {
  const env = resolveDigestEnv()
  const clientBase = {
    allowedHosts: deriveOutboundAllowlist(),
    trustedBaseUrls: env.rsshubBase ? [env.rsshubBase] : [],
  }
  const proxyFetch = createDigestFetchImpl(env.proxy, (m) => console.log(m))
  const http = createSafeHttpClient({ ...clientBase, fetchImpl: proxyFetch })
  const httpDirect = proxyFetch ? createSafeHttpClient(clientBase) : undefined
  const sources = [
    ...buildAllSources(),
    makeRedditAiSource(),
    makeGithubDailySource(),
    makeGithubWeeklySource(),
    makeGithubNewcomersSource(),
    makeGithubMonthlySource(),
  ]

  console.log(`[smoke] ${sources.length} sources, fetching (per-source timeout 45s)...`)
  const started = Date.now()
  const { results, items } = await runAllSources(sources, { http, httpDirect })

  console.log("\n=== 源健康表 ===")
  for (const r of [...results].sort((a, b) => a.sourceId.localeCompare(b.sourceId))) {
    const icon = r.status === "ok" ? "✅" : "❌"
    const err = r.errors[0] ? ` — ${r.errors[0].slice(0, 120)}` : ""
    console.log(
      `${icon} ${r.sourceId.padEnd(24)} ${String(r.items.length).padStart(3)} items ${String(r.durationMs).padStart(6)}ms [${r.status}]${err}`,
    )
  }

  const githubItems = items.filter((i) => i.category === "github")
  const contentItems = items.filter((i) => i.category !== "github")
  const byCat = new Map<string, number>()
  for (const i of contentItems) byCat.set(i.category, (byCat.get(i.category) ?? 0) + 1)
  console.log(
    `\n[smoke] 总计 ${items.length} 条（去重后）：${[...byCat].map(([c, n]) => `${c}=${n}`).join(" ")} github=${githubItems.length}`,
  )

  const businessDate = formatBusinessDate(new Date())
  const summary = buildFallbackSummary(contentItems)
  const rendered = renderDigest({
    businessDate,
    summary,
    items: contentItems,
    results,
    githubItems,
    notes: ["smoke 预览（清单版，未走 LLM）"],
  })
  const outDir = path.join(process.cwd(), ".runtime", "daily-digest", "smoke")
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, "digest.html"), rendered.html)
  fs.writeFileSync(path.join(outDir, "digest.md"), rendered.markdown)
  console.log(`[smoke] 渲染落盘 ${outDir} · 总耗时 ${Date.now() - started}ms`)

  const failed = results.filter((r) => r.status !== "ok")
  process.exitCode = failed.length > results.length / 2 ? 1 : 0
}

main().catch((err) => {
  console.error("[smoke] fatal:", err)
  process.exitCode = 1
})
