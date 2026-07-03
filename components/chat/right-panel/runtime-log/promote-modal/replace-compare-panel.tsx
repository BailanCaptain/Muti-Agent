"use client"

import { useEffect, useState } from "react"

/**
 * F027 dest_exists 替换补丁（小孙「失败了都不知道该不该丢弃」）· 对比 + 替换面板。
 *
 * promote 撞 DEST_EXISTS 时渲染：并排拉取「现有正式页」与「本 draft」的全文 + 更新时间，
 * 明确标出哪份新，给一键「替换现有页」（后端归档旧页到 _rejected/ 可恢复后落新页）。
 *   - 现有页 → GET /api/wiki/page/content?path=<dest>（正式区白名单围栏，见 promote.ts）
 *   - draft  → GET /api/wiki/drafts/content?path=<src>（既有端点）
 * 对比数据 fail-soft：任一侧取不到只降级显示「无法读取」，替换按钮仍可用（决定权在用户）。
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"

interface SideState {
  content: string | null
  mtime: string | null
  /** page/content 端点返回（draft 端点无此字段）——替换请求的 CAS 凭据。 */
  contentHash: string | null
  error: string | null
  loading: boolean
}

const SIDE_INIT: SideState = {
  content: null,
  mtime: null,
  contentHash: null,
  error: null,
  loading: true,
}

function useSideContent(endpoint: string, path: string | null): SideState {
  const [state, setState] = useState<SideState>(SIDE_INIT)
  useEffect(() => {
    if (!path) return
    let cancelled = false
    setState(SIDE_INIT)
    fetch(`${API_BASE_URL}${endpoint}?path=${encodeURIComponent(path)}`, {
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as { content?: string; mtime?: string; contentHash?: string }
      })
      .then((json) => {
        if (cancelled) return
        setState({
          content: json.content ?? "",
          mtime: json.mtime ?? null,
          contentHash: json.contentHash ?? null,
          error: null,
          loading: false,
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setState({
          content: null,
          mtime: null,
          contentHash: null,
          error: err instanceof Error ? err.message : String(err),
          loading: false,
        })
      })
    return () => {
      cancelled = true
    }
  }, [endpoint, path])
  return state
}

function formatMtime(mtime: string | null): string {
  if (!mtime) return "未知时间"
  const d = new Date(mtime)
  return Number.isNaN(d.getTime()) ? mtime : d.toLocaleString()
}

function SideCard(props: { title: string; side: SideState; newer: boolean }) {
  const { title, side, newer } = props
  return (
    <div className="min-w-0 flex-1 rounded border border-gray-200">
      <div className="flex items-center gap-2 border-b bg-gray-50 px-2 py-1 text-xs">
        <span className="font-medium">{title}</span>
        {newer ? (
          <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">
            较新
          </span>
        ) : null}
        <span className="ml-auto text-gray-500">
          {side.loading ? "加载中…" : formatMtime(side.mtime)}
        </span>
      </div>
      {side.error ? (
        <div className="p-2 text-xs text-red-600">无法读取：{side.error}</div>
      ) : (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all p-2 text-[11px] leading-4 text-gray-700">
          {side.loading ? "…" : (side.content ?? "")}
        </pre>
      )}
    </div>
  )
}

export interface ReplaceComparePanelProps {
  srcDraftPath: string
  /** 冲突的正式页路径（失败 job 记录的 dest，非表单当前值）。 */
  destWikiPath: string
  /** 点「替换」→ 由 modal 以 allowReplace=true + expectedDestHash（CAS 凭据）重新提交。 */
  onReplace: (expectedDestHash: string) => void
  /** 替换按钮禁用（reason 未填 / 正在提交）。加载/失败态由面板内部再叠 fail-closed 门。 */
  replaceDisabled: boolean
  /** DEST_CONFLICT 重入：现有页刚被并发改过，提示用户这里已是重新加载的最新版。 */
  conflictNotice?: boolean
}

export function ReplaceComparePanel({
  srcDraftPath,
  destWikiPath,
  onReplace,
  replaceDisabled,
  conflictNotice = false,
}: ReplaceComparePanelProps) {
  const existing = useSideContent("/api/wiki/page/content", destWikiPath)
  const draft = useSideContent("/api/wiki/drafts/content", srcDraftPath)

  const existingMs = existing.mtime ? Date.parse(existing.mtime) : Number.NaN
  const draftMs = draft.mtime ? Date.parse(draft.mtime) : Number.NaN
  const comparable = !Number.isNaN(existingMs) && !Number.isNaN(draftMs)
  const draftNewer = comparable && draftMs > existingMs

  // 德彪 replace-r1 P2 · fail-closed：两侧都真加载成功（且拿到 CAS 哈希）才允许替换——
  // 没看到对比内容的替换就是盲替换，不给点。任一侧失败只能取消或重开弹窗重试。
  const compareReady =
    !existing.loading && !draft.loading && !existing.error && !draft.error && !!existing.contentHash

  return (
    <div
      className="mb-4 rounded border border-amber-300 bg-amber-50 p-3"
      data-testid="replace-compare-panel"
    >
      <div className="text-sm font-medium text-amber-800">目标路径已有正式页</div>
      {conflictNotice ? (
        <div className="mt-1 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
          刚才那次替换被中止：现有页在你确认前被改动过。下面已是**重新加载的最新内容**，请再次核对。
        </div>
      ) : null}
      <div className="mt-1 text-xs text-amber-700">
        <span className="font-mono break-all">{destWikiPath}</span> 已存在。下面是两份内容的对比
        {comparable ? (
          <>
            ——<span className="font-medium">{draftNewer ? "本 draft 较新" : "现有页较新"}</span>
            {draftNewer
              ? "，通常应替换（旧页会归档到 _rejected/，可恢复）。"
              : "，替换会用旧内容覆盖新内容，请确认后再操作。"}
          </>
        ) : (
          "（时间不可比，请自行判断）。"
        )}
      </div>

      <div className="mt-2 flex gap-2">
        <SideCard title="现有正式页" side={existing} newer={comparable && !draftNewer} />
        <SideCard title="本 draft" side={draft} newer={draftNewer} />
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <span className="text-[11px] text-gray-500">
          {compareReady
            ? "替换 = 旧页归档到 _rejected/（可恢复）+ 本 draft 转正"
            : existing.error || draft.error
              ? "对比内容加载失败——无法确认现状，不能替换"
              : "对比内容加载中…"}
        </span>
        <button
          type="button"
          onClick={() => {
            if (existing.contentHash) onReplace(existing.contentHash)
          }}
          disabled={replaceDisabled || !compareReady}
          className="rounded bg-amber-600 px-3 py-1.5 text-sm text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          data-testid="replace-confirm-button"
        >
          替换现有页
        </button>
      </div>
    </div>
  )
}
