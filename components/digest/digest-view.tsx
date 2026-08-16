"use client"

import { getApiHttpBaseUrl } from "@/lib/api-endpoints"
import { DIGEST_GITHUB_SECTION_LABEL } from "@multi-agent/shared"
import { AlertTriangle, ArrowUpRight, ChevronDown, Settings as SettingsIcon } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import {
  ALL_TAB,
  type DigestDayResponse,
  type DigestItem,
  type ResolvedPick,
  buildTabs,
  checkLine,
  filterByTab,
  githubGroups,
  githubMetaLine,
  labelOf,
  overviewOf,
  podcastEpisodes,
  rawItems,
  resolvePicks,
  safeExternalHref,
  splitGhSnippet,
} from "./digest-model"

/**
 * F037 网页版日报（小孙 07-05 分栏改版 #2）：邮件是精选快照，这里是全量分栏——
 * 真可点 tabs（AI 推理/公司、X 公司/从业者、热点分类、GitHub 榜种）+ 每板块全量抓取条目。
 * 视觉走 DESIGN.md token（surface 档 + 暖金 accent），禁裸 hex。
 */

const API_BASE = getApiHttpBaseUrl()

const SECTION_DEFS = [
  { category: "ai", label: "AI · 人工智能", en: "ARTIFICIAL INTELLIGENCE" },
  // 07-06 社区改版：X 一手动态 → 社区动态（X/Reddit/Digg/V2EX/小红书；旧归档 "x" 由 model 层归一）
  { category: "community", label: "社区动态", en: "COMMUNITY PULSE" },
  { category: "hot", label: "今日热点", en: "TRENDING TODAY" },
] as const

interface WeekendEdition {
  coverageLabel: string
  coverageText: string
}

function weekendEditionOf(date: string): WeekendEdition | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return null
  const businessDateUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (new Date(businessDateUtc).getUTCDay() !== 1) return null
  const mmdd = (value: number) => {
    const day = new Date(value)
    return `${String(day.getUTCMonth() + 1).padStart(2, "0")}.${String(day.getUTCDate()).padStart(2, "0")}`
  }
  const coverageLabel = `${mmdd(businessDateUtc - 2 * 86_400_000)}—${mmdd(businessDateUtc - 86_400_000)}`
  return { coverageLabel, coverageText: `${coverageLabel}（周六—周日）` }
}

function TabRow({
  tabs,
  active,
  onPick,
}: {
  tabs: string[]
  active: string
  onPick: (t: string) => void
}) {
  if (tabs.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 pb-3" role="tablist">
      {tabs.map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={t === active}
          onClick={() => onPick(t)}
          className={
            t === active
              ? "rounded-full bg-accent px-3 py-1 text-xs font-medium text-white"
              : "rounded-full border border-slate-200 bg-surface-elevated px-3 py-1 text-xs text-slate-600 hover:border-accent-300 hover:text-accent-600"
          }
        >
          {t}
        </button>
      ))}
    </div>
  )
}

function PickCard({ day, rp }: { day: DigestDayResponse; rp: ResolvedPick }) {
  const title = rp.deep?.titleZh ?? rp.item.title
  const summary = rp.deep?.summaryZh ?? rp.pick.summaryZh
  return (
    <article className="rounded-2xl border border-slate-200 bg-surface-elevated p-4">
      <div className="flex flex-wrap items-center gap-2 pb-1.5 text-[11px] text-accent-600">
        <span className="font-semibold tracking-wide">{labelOf(day, rp.item.sourceId)}</span>
        {rp.item.engagement !== undefined && (
          <span className="text-slate-400">▲ {rp.item.engagement.toLocaleString()}</span>
        )}
        {rp.alsoLabels.length > 0 && (
          <span className="rounded-full bg-accent-50 px-2 py-0.5 text-accent-700">
            ◈ {rp.alsoLabels.length + 1} 源同报 · {rp.alsoLabels.slice(0, 3).join(" · ")}
          </span>
        )}
      </div>
      <a
        href={safeExternalHref(rp.item.canonicalUrl)}
        target="_blank"
        rel="noreferrer"
        className="text-[15px] font-semibold leading-snug text-slate-900 hover:text-accent-600 hover:underline"
      >
        {title}
        <ArrowUpRight className="ml-0.5 inline h-3.5 w-3.5 align-baseline text-slate-400" />
      </a>
      {summary && <p className="pt-1.5 text-[13px] leading-relaxed text-slate-500">{summary}</p>}
    </article>
  )
}

function RawList({ day, category }: { day: DigestDayResponse; category: string }) {
  const all = useMemo(() => rawItems(day, category), [day, category])
  if (all.length === 0) return null
  return (
    <details className="group pt-3">
      <summary className="flex cursor-pointer select-none items-center gap-1 text-xs text-slate-500 hover:text-accent-600">
        <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
        全部抓取条目（{all.length}）
      </summary>
      <ul className="mt-2 max-h-96 space-y-1 overflow-y-auto rounded-xl border border-slate-200 bg-surface p-3">
        {all.map((i) => (
          <li key={i.id} className="flex items-baseline gap-2 text-[13px] leading-relaxed">
            <span className="shrink-0 text-[11px] text-accent-600">{labelOf(day, i.sourceId)}</span>
            <a
              href={safeExternalHref(i.canonicalUrl)}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1 truncate text-slate-700 hover:text-accent-600 hover:underline"
            >
              {i.title}
            </a>
            {i.engagement !== undefined && (
              <span className="shrink-0 text-[11px] text-slate-400">
                ▲ {i.engagement.toLocaleString()}
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  )
}

function Section({
  day,
  category,
  label,
  en,
  showEmpty = false,
}: {
  day: DigestDayResponse
  category: string
  label: string
  en: string
  showEmpty?: boolean
}) {
  const resolved = useMemo(() => resolvePicks(day, category), [day, category])
  const tabs = useMemo(() => buildTabs(category, resolved), [category, resolved])
  const [picked, setPicked] = useState(ALL_TAB)
  // 德彪 r-final P2-4：切日期后旧选中 tab 可能在新日期不存在——派生兜底回「全部」，防假空态
  const active = tabs.includes(picked) ? picked : ALL_TAB
  const shown = filterByTab(category, resolved, active)
  const raw = rawItems(day, category)
  if (resolved.length === 0 && raw.length === 0 && !showEmpty) return null
  return (
    <section className="pt-8">
      <div className="border-l-4 border-accent pl-3">
        <div className="text-[10px] font-bold tracking-[3px] text-accent-600">{en}</div>
        <h2 className="pt-0.5 text-xl font-bold text-slate-900">{label}</h2>
      </div>
      <div className="pt-3">
        <TabRow tabs={tabs} active={active} onPick={setPicked} />
        <div className="grid gap-3 sm:grid-cols-2">
          {shown.map((rp) => (
            <PickCard key={rp.pick.itemId} day={day} rp={rp} />
          ))}
        </div>
        {shown.length === 0 && resolved.length > 0 && (
          <p className="text-sm text-slate-500">该分栏今日无精选。</p>
        )}
        {resolved.length === 0 && raw.length === 0 && showEmpty && (
          <p className="text-sm text-slate-500">本期暂无合资格内容。</p>
        )}
        <RawList day={day} category={category} />
      </div>
    </section>
  )
}

/** #33 播客速递（07-10）：有新集才出现；播客名走 topicTag，rawSnippet=转写提炼要点 */
function PodcastSection({
  day,
  showEmpty = false,
}: { day: DigestDayResponse; showEmpty?: boolean }) {
  const episodes = useMemo(() => podcastEpisodes(day), [day])
  if (episodes.length === 0 && !showEmpty) return null
  return (
    <section className="pt-8">
      <div className="border-l-4 border-accent pl-3">
        <div className="text-[10px] font-bold tracking-[3px] text-accent-600">PODCAST DIGEST</div>
        <h2 className="pt-0.5 text-xl font-bold text-slate-900">播客速递</h2>
      </div>
      <div className="grid gap-3 pt-3">
        {episodes.length === 0 && <p className="text-sm text-slate-500">本期暂无合资格内容。</p>}
        {episodes.map((ep) => (
          <article
            key={ep.id}
            className="rounded-2xl border border-slate-200 bg-surface-elevated p-4"
          >
            {ep.topicTag && (
              <div className="pb-1.5 text-[11px] font-semibold tracking-wide text-accent-600">
                {ep.topicTag}
              </div>
            )}
            <a
              href={safeExternalHref(ep.canonicalUrl)}
              target="_blank"
              rel="noreferrer"
              className="text-[15px] font-semibold leading-snug text-slate-900 hover:text-accent-600 hover:underline"
            >
              {ep.title}
              <ArrowUpRight className="ml-0.5 inline h-3.5 w-3.5 align-baseline text-slate-400" />
            </a>
            {ep.rawSnippet && (
              <p className="pt-1.5 text-[13px] leading-relaxed text-slate-500">{ep.rawSnippet}</p>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}

function GithubSection({
  day,
  showEmpty = false,
}: { day: DigestDayResponse; showEmpty?: boolean }) {
  const groups = useMemo(() => githubGroups(day), [day])
  const [active, setActive] = useState(0)
  if (groups.length === 0 && !showEmpty) return null
  if (groups.length === 0) {
    return (
      <section className="pt-8">
        <div className="border-l-4 border-accent pl-3">
          <div className="text-[10px] font-bold tracking-[3px] text-accent-600">TRENDING REPOS</div>
          <h2 className="pt-0.5 text-xl font-bold text-slate-900">{DIGEST_GITHUB_SECTION_LABEL}</h2>
        </div>
        <p className="pt-3 text-sm text-slate-500">本期暂无合资格内容。</p>
      </section>
    )
  }
  const tabs = groups.map((g) => g.label)
  const current = groups[Math.min(active, groups.length - 1)]
  return (
    <section className="pt-8">
      <div className="border-l-4 border-accent pl-3">
        <div className="text-[10px] font-bold tracking-[3px] text-accent-600">TRENDING REPOS</div>
        <h2 className="pt-0.5 text-xl font-bold text-slate-900">{DIGEST_GITHUB_SECTION_LABEL}</h2>
      </div>
      <div className="pt-3">
        {tabs.length >= 2 && (
          <TabRow
            tabs={tabs}
            active={tabs[Math.min(active, tabs.length - 1)]}
            onPick={(t) => setActive(tabs.indexOf(t))}
          />
        )}
        <ol className="divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-surface-elevated">
          {current.items.map((repo, i) => {
            const gh = splitGhSnippet(repo.rawSnippet)
            const meta = githubMetaLine(repo)
            return (
              <li key={repo.id} className="flex gap-3 p-3.5">
                <span className="w-6 shrink-0 pt-0.5 text-right text-xs font-bold text-accent-600">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0">
                  <a
                    href={safeExternalHref(repo.canonicalUrl)}
                    target="_blank"
                    rel="noreferrer"
                    className="break-words text-[14px] font-semibold text-slate-900 hover:text-accent-600 hover:underline"
                  >
                    {repo.title}
                  </a>
                  {meta && (
                    <div className="pt-0.5 text-[11px] font-medium text-accent-600">{meta}</div>
                  )}
                  {(() => {
                    // 中文化补全（07-06）：翻译 map 命中用中文 desc，缺省回落英文
                    const desc = day.summary?.summary.githubDescZh?.[repo.id] ?? gh.desc
                    return desc ? (
                      <div className="pt-0.5 text-[13px] text-slate-500">{desc}</div>
                    ) : null
                  })()}
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </section>
  )
}

export function DigestView({ date }: { date: string }) {
  const router = useRouter()
  const [day, setDay] = useState<DigestDayResponse | null>(null)
  const [dates, setDates] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setDay(null)
    setError(null)
    fetch(`${API_BASE}/api/daily-digest/${date}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`)
        return (await res.json()) as DigestDayResponse
      })
      .then((d) => {
        if (!cancelled) setDay(d)
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
    fetch(`${API_BASE}/api/daily-digest/dates`)
      .then(async (res) => (res.ok ? ((await res.json()) as { dates: string[] }).dates : []))
      .then((ds) => {
        if (!cancelled) setDates(ds)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [date])

  const failed = (day?.summary?.sourceHealth ?? []).filter((h) => h.status !== "ok")
  const overview = day ? overviewOf(day) : []
  const weekendEdition = weekendEditionOf(date)
  const sectionDefs = weekendEdition
    ? SECTION_DEFS.map((section) =>
        section.category === "hot"
          ? { ...section, label: "周末热点", en: "TRENDING THIS WEEKEND" }
          : section,
      )
    : SECTION_DEFS

  return (
    <div className="min-h-screen bg-surface-sunken">
      <div className="mx-auto max-w-3xl px-4 pb-16 pt-8">
        <header className="rounded-2xl bg-slate-900 p-6 text-white">
          <div className="text-[10px] font-bold tracking-[4px] text-accent-200">
            {weekendEdition ? "MULTI-AGENT · WEEKEND ROUNDUP" : "MULTI-AGENT · DAILY BRIEF"}
          </div>
          <div className="flex flex-wrap items-end justify-between gap-3 pt-1">
            <h1 className="text-3xl font-bold tracking-wide">
              {weekendEdition ? "周末速览" : "每日简报"}
            </h1>
            <div className="flex items-center gap-2">
              {dates.length > 0 && (
                <select
                  value={date}
                  onChange={(e) => router.push(`/digest/${e.target.value}`)}
                  className="rounded-lg border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-white"
                  aria-label="选择日期"
                >
                  {dates.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              )}
              <Link
                href="/digest/settings"
                aria-label="日报设置"
                title="日报设置"
                className="rounded-lg border border-slate-600 bg-slate-800 p-1.5 text-slate-300 hover:border-accent-300 hover:text-accent-200"
              >
                <SettingsIcon className="h-4 w-4" />
              </Link>
            </div>
          </div>
          {day && (
            <div className="pt-2 text-xs tracking-wide text-accent-200">
              {weekendEdition ? `覆盖 ${weekendEdition.coverageText} · ` : ""}
              {checkLine(day)}
              {day.summary?.degraded ? " · 清单版" : ""}
            </div>
          )}
        </header>

        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-700">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            这一天没有日报归档（{error}）。
          </div>
        )}
        {!day && !error && <p className="pt-6 text-sm text-slate-500">加载中…</p>}

        {day && failed.length > 0 && (
          <div className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-700">
            <div className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-4 w-4" /> 信源异常 {failed.length} 个
            </div>
            <ul className="pt-1 text-[13px]">
              {failed.map((f) => (
                <li key={f.sourceId}>
                  {labelOf(day, f.sourceId) || f.sourceId}：{f.error ?? f.status}
                </li>
              ))}
            </ul>
          </div>
        )}

        {day && overview.length > 0 && (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-surface-elevated p-5">
            <div className="text-[10px] font-bold tracking-[3px] text-accent-600">
              {weekendEdition
                ? `周末速览 · WEEKEND AT A GLANCE · ${weekendEdition.coverageText}`
                : "今日速览 · AT A GLANCE"}
            </div>
            <ul className="space-y-1.5 pt-2">
              {overview.map((o) => (
                <li key={o} className="flex gap-2 text-[13.5px] leading-relaxed text-slate-700">
                  <span className="text-accent-600">◆</span>
                  <span>{o}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {day &&
          sectionDefs.map((s) => (
            <Section
              key={s.category}
              day={day}
              category={s.category}
              label={s.label}
              en={s.en}
              showEmpty={Boolean(weekendEdition)}
            />
          ))}
        {day && <PodcastSection day={day} showEmpty={Boolean(weekendEdition)} />}
        {day && <GithubSection day={day} showEmpty={Boolean(weekendEdition)} />}

        {day && (
          <footer className="pt-10 text-center text-xs text-slate-500">
            ◆ DailyBrief · Multi-Agent · F037 {weekendEdition ? "周末速览" : "每日简报"}
            （网页版全量分栏）
          </footer>
        )}
      </div>
    </div>
  )
}
