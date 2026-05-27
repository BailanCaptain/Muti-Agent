"use client"

import { useState } from "react"
import { type WikiBucketStat, useWikiStoryData } from "./use-wiki-story-data"

/**
 * F027 v3 G6 · Wiki 哲学 panel (KB tab 顶部新增)
 *
 * 真相源:
 *   - V16.5 chap 1-3 设计哲学 (wiki 是 LLM 第一公民 / 6 类记忆桶 / canonical_owner 唯一 /
 *     越用越聪明)
 *   - F027 v3 audit summary G6 (P0 愿景层) — 之前 KB tab 只露后端 CRUD,
 *     无"哲学叙事"; 小孙原话 "我没感受到"
 *
 * 4 块 (MVP):
 *   1. Banner: 一句话哲学叙事 (wiki 不是文档库, 是 LLM 第一公民)
 *   2. 6 类桶卡片 (canonical/draft/total count + topEntities expand)
 *   3. canonical_owner 链可视化 (entity 点开 → 列 supersedes 路径)
 *   4. 7 天增长曲线 (entity+decision daily count, 简单 bar)
 *
 * 推 follow-up F-id (本 MVP 不做):
 *   - LLM compile pipeline 状态 (chap 26 pre/compile/post 历史)
 *   - drift history timeline (room_decisions tombstone + supersede 时序)
 */

const BUCKET_LABELS: Record<string, { zh: string; emoji: string }> = {
  room: { zh: "房间记忆 (room)", emoji: "🏠" },
  project: { zh: "项目记忆 (project)", emoji: "📋" },
  user: { zh: "用户记忆 (user)", emoji: "👤" },
  feedback: { zh: "反馈记忆 (feedback)", emoji: "💬" },
  work: { zh: "工作记忆 (work)", emoji: "🔧" },
  conversation: { zh: "对话记忆 (conversation)", emoji: "💭" },
}

export function WikiPhilosophyPanel({ enabled }: { enabled: boolean }) {
  const { data, isLoading, error } = useWikiStoryData({ enabled })

  return (
    <section
      className="rounded-lg border border-violet-200 bg-gradient-to-br from-violet-50 to-blue-50 p-3 text-xs"
      data-testid="wiki-philosophy-panel"
    >
      {/* 1. Banner */}
      <div className="mb-2">
        <div className="font-semibold text-violet-900">🧠 Wiki 是 LLM 第一公民</div>
        <div className="mt-0.5 text-[10px] leading-snug text-slate-600">
          不是文档库 · 6 类记忆桶 + canonical_owner 唯一所属 + 越用越聪明 (V16.5 chap 1-3)
        </div>
      </div>

      {/* Loading / error */}
      {isLoading && (
        <div className="text-[10px] text-slate-400" data-testid="wiki-philosophy-loading">
          ⏳ 加载中…
        </div>
      )}
      {error && (
        <div className="text-[10px] text-red-500" data-testid="wiki-philosophy-error">
          ⚠ 加载失败：{error}
        </div>
      )}

      {/* 2. 总览 stats */}
      {!isLoading && !error && (
        <>
          <div className="mb-2 flex flex-wrap gap-3 text-[10px] text-slate-700">
            <span data-testid="wiki-philosophy-total-entities">
              📚 总 entity: <span className="font-mono font-semibold">{data.totalEntities}</span>
            </span>
            <span data-testid="wiki-philosophy-total-decisions">
              📋 总 decision:{" "}
              <span className="font-mono font-semibold">{data.totalDecisions}</span>
            </span>
          </div>

          {/* 3. 6 桶 grid */}
          <div className="mb-3 grid grid-cols-2 gap-2">
            {data.buckets.map((b) => (
              <BucketCard key={b.type} bucket={b} />
            ))}
          </div>

          {/* 4. 7 天增长曲线 */}
          <GrowthSparkline points={data.recent7d} />
        </>
      )}
    </section>
  )
}

// ─── BucketCard ────────────────────────────────────────────────────────

function BucketCard({ bucket }: { bucket: WikiBucketStat }) {
  const [expanded, setExpanded] = useState(false)
  const label = BUCKET_LABELS[bucket.type] ?? { zh: bucket.type, emoji: "📦" }
  const canExpand = bucket.topEntities.length > 0

  return (
    <div
      className="rounded border border-slate-200 bg-white p-2 text-[10px]"
      data-testid={`wiki-bucket-${bucket.type}`}
    >
      <div
        className={`flex items-center justify-between ${canExpand ? "cursor-pointer hover:bg-slate-50" : ""}`}
        onClick={canExpand ? () => setExpanded((v) => !v) : undefined}
      >
        <div className="font-semibold text-slate-700">
          <span className="mr-1">{label.emoji}</span>
          {label.zh}
        </div>
        <div className="font-mono text-slate-500">
          <span className="text-green-600">{bucket.canonicalCount}</span>
          {bucket.draftCount > 0 && (
            <>
              <span className="mx-0.5 text-slate-300">/</span>
              <span className="text-amber-600">{bucket.draftCount}</span>
            </>
          )}
          <span className="ml-1 text-slate-400">({bucket.totalCount})</span>
          {canExpand && (
            <span className="ml-1 text-slate-400">{expanded ? "▾" : "▸"}</span>
          )}
        </div>
      </div>
      {expanded && (
        <ul className="mt-1.5 space-y-1 border-t border-slate-100 pt-1.5">
          {bucket.topEntities.map((e) => (
            <li
              key={e.id}
              className="text-[10px]"
              data-testid={`wiki-entity-${bucket.type}-${e.id}`}
            >
              <div className="font-mono text-slate-700">
                {e.name}{" "}
                <span
                  className={
                    e.state === "canonical" ? "text-green-600" : "text-amber-600"
                  }
                >
                  [{e.state}]
                </span>
              </div>
              <div className="text-slate-400">{e.canonicalOwnerPath}</div>
              {e.supersedes.length > 0 && (
                <div className="mt-0.5 text-slate-500">
                  <span className="text-violet-600">↳ supersedes ({e.supersedes.length}):</span>
                  <ul className="ml-3 list-disc">
                    {e.supersedes.map((s) => (
                      <li key={s} className="font-mono text-[9px] text-slate-400">
                        {s}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ─── GrowthSparkline ───────────────────────────────────────────────────

function GrowthSparkline({ points }: { points: ReadonlyArray<{ day: string; entityNew: number; decisionNew: number }> }) {
  if (points.length === 0) {
    return null
  }
  const max = Math.max(
    1,
    ...points.map((p) => Math.max(p.entityNew, p.decisionNew)),
  )
  return (
    <div className="rounded border border-slate-200 bg-white p-2" data-testid="wiki-growth-sparkline">
      <div className="mb-1 text-[10px] font-semibold text-slate-700">
        📈 近 7 天增长 (entity / decision)
      </div>
      <div className="flex items-end gap-1.5">
        {points.map((p) => {
          const eHeight = (p.entityNew / max) * 24
          const dHeight = (p.decisionNew / max) * 24
          const dayLabel = p.day.slice(5) // MM-DD
          return (
            <div
              key={p.day}
              className="flex flex-1 flex-col items-center"
              data-testid={`wiki-growth-day-${p.day}`}
            >
              <div className="flex h-6 items-end gap-0.5">
                <div
                  className="w-2 bg-blue-400"
                  style={{ height: `${eHeight}px` }}
                  title={`entity: ${p.entityNew}`}
                />
                <div
                  className="w-2 bg-violet-400"
                  style={{ height: `${dHeight}px` }}
                  title={`decision: ${p.decisionNew}`}
                />
              </div>
              <div className="mt-0.5 font-mono text-[9px] text-slate-400">{dayLabel}</div>
            </div>
          )
        })}
      </div>
      <div className="mt-1 flex gap-2 text-[9px] text-slate-500">
        <span>
          <span className="inline-block h-1.5 w-2 bg-blue-400 align-middle" /> entity
        </span>
        <span>
          <span className="inline-block h-1.5 w-2 bg-violet-400 align-middle" /> decision
        </span>
      </div>
    </div>
  )
}
