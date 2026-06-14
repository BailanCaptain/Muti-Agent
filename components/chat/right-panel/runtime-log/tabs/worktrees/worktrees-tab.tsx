"use client"

import { useCallback, useState } from "react"

import { useLayoutStore } from "@/components/stores/layout-store"
import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"
import {
  type CleanupResult,
  type PreviewAction,
  type WorktreeRow,
  fetchLogTail,
  postCleanup,
  postPreviewAction,
  useWorktreeSummary,
  useWorktreesData,
} from "./use-worktrees-api"

/**
 * F028 Task 9 · WorktreesTab（AC3/AC4/AC5/AC7/AC8 前端面）
 *
 * - 懒加载：activeLvl1 === "worktrees" 才首次 fetch
 * - 主仓行零操作钮；running 行 [编译后端][重启整个 preview][打开前端]；
 *   未运行行 [启动]（AC7）
 * - 打开前端 = 接管式内嵌 iframe：tab 内容整体切换为「细头条 + iframe 占满」，
 *   并把 RuntimeLog 面板自动调高到 ≥600px——和列表/摘要抢空间只会露一条缝
 *   （小孙验收反馈 ×2：不开新网页 + "我只能看到一点点"）。收起恢复列表视图
 * - capabilities control:false（preview API 实例，D12）→ 全钮禁用 + 导主 UI 提示
 * - 失败（含 409 in-progress）→ 错误条 + api 日志尾部自动展开（AC5）
 */

type ActionState =
  | { phase: "idle" }
  | { phase: "pending"; action: PreviewAction }
  | { phase: "success"; action: PreviewAction }
  | { phase: "failed"; action: PreviewAction; message: string }

// 续作 AC12 · 清理两步确认状态机
type CleanupState =
  | { phase: "idle" }
  | { phase: "confirming" }
  | { phase: "pending" }
  | { phase: "done"; result: CleanupResult }

export function WorktreesTab() {
  const activeLvl1 = useRuntimeLogStore((s) => s.activeLvl1)
  const { worktrees, control, isLoading, error, refetch } = useWorktreesData({
    enabled: activeLvl1 === "worktrees",
  })
  const [selected, setSelected] = useState<string | null>(null)
  const [actionState, setActionState] = useState<ActionState>({ phase: "idle" })
  const [cleanupState, setCleanupState] = useState<CleanupState>({ phase: "idle" })
  const [logTail, setLogTail] = useState<string[] | null>(null)
  const [embedded, setEmbedded] = useState<{ name: string; url: string } | null>(null)
  const setRuntimeLogHeight = useLayoutStore((s) => s.setRuntimeLogHeight)
  const { summary } = useWorktreeSummary(selected)

  const selectedRow = worktrees.find((w) => w.name === selected) ?? null

  const runAction = useCallback(
    async (name: string, action: PreviewAction) => {
      setActionState({ phase: "pending", action })
      setLogTail(null)
      const result = await postPreviewAction(name, action)
      if (result.ok) {
        setActionState({ phase: "success", action })
        await refetch()
        return
      }
      const message =
        result.httpStatus === 409 ? `操作进行中：${result.message}` : result.message
      setActionState({ phase: "failed", action, message })
      setLogTail(await fetchLogTail(name, "api", 120)) // 失败自动展开日志尾部（AC5）
    },
    [refetch],
  )

  // 续作 AC12 · 清理（已二次确认后执行）：停 preview→删生成物→remove→branch -d→消失
  const runCleanup = useCallback(
    async (name: string) => {
      setCleanupState({ phase: "pending" })
      const result = await postCleanup(name)
      setCleanupState({ phase: "done", result })
      // git worktree remove 非原子：ok:false 也可能「已注销但有残留」——worktree 已从 git
      // 消失。故**始终**刷新 inventory（不只 ok 时），让列表反映 git 真实状态：已注销/清成功
      // → 该行消失（AC12 即时消失）；仍注册的可重试失败 → 该行保留供重点击。德彪 code-r4 P2。
      if (result.ok) setSelected(null) // 清成功该行已不返回，清掉选中
      await refetch()
    },
    [refetch],
  )

  // 接管视图：嵌入时整个 tab 让位给 iframe——挤在列表/摘要下面只会露一条缝
  if (embedded) {
    return (
      <div className="flex h-full flex-col gap-1 p-2 text-xs" data-testid="worktrees-tab">
        <div className="flex items-center gap-2">
          <span className="truncate text-slate-500">
            {embedded.name} 实时前端 · {embedded.url}
          </span>
          <button
            type="button"
            className="ml-auto shrink-0 rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-700 transition-colors hover:bg-slate-100"
            data-testid="wt-embed-close"
            onClick={() => setEmbedded(null)}
          >
            收起前端
          </button>
        </div>
        <iframe
          src={embedded.url}
          title={`${embedded.name} 实时前端`}
          className="min-h-0 w-full flex-1 rounded border border-slate-200 bg-white"
          data-testid="wt-embedded-frame"
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-3 text-xs" data-testid="worktrees-tab">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-slate-700">Worktree</span>
        {isLoading && <span className="text-slate-400">加载中…</span>}
        {error && <span className="text-red-500">{error}</span>}
        {!control && (
          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700" data-testid="wt-control-hint">
            preview 实例只读——操作请去主 UI（localhost:3000）
          </span>
        )}
      </div>

      <ul className="flex flex-col gap-1">
        {worktrees.map((row) => (
          <WorktreeRowItem
            key={row.name}
            row={row}
            selected={row.name === selected}
            onSelect={() => {
              setSelected(row.name)
              setActionState({ phase: "idle" })
              setCleanupState({ phase: "idle" })
              setLogTail(null)
              setEmbedded(null)
            }}
          />
        ))}
      </ul>

      {selectedRow && !selectedRow.isMain && (
        <ActionBar
          row={selectedRow}
          control={control}
          actionState={actionState}
          cleanupBusy={cleanupState.phase === "confirming" || cleanupState.phase === "pending"}
          onAction={(action) => void runAction(selectedRow.name, action)}
          onToggleEmbed={() => {
            const webPort = selectedRow.preview?.webPort
            if (!webPort) return
            setEmbedded({ name: selectedRow.name, url: `http://localhost:${webPort}` })
            // 默认 320px 高只够露一条缝——嵌入时自动调高（用户已拖更高则保留）
            setRuntimeLogHeight(Math.max(useLayoutStore.getState().runtimeLogHeight, 600))
          }}
        />
      )}

      {/* 清理按钮对**任何非主仓 worktree**可用——mergedHint 只是「本地 dev 已包含提交」的
          advisory 徽标，绝不作硬门（德彪愿景 review P0）：merge-gate 走 squash，feature 做完
          squash 合 dev 后 is-ancestor=false → mergedHint=false，若按它硬门则**恰好在小孙要清
          理的时刻按钮消失**。真正的安全由后端安全门（未提交工作拒）+ git branch -d 内建合并
          保护 + 两步确认兜底，不靠这个徽标。 */}
      {selectedRow && !selectedRow.isMain && (
        <CleanupControl
          state={cleanupState}
          disabled={!control}
          onStart={() => setCleanupState({ phase: "confirming" })}
          onCancel={() => setCleanupState({ phase: "idle" })}
          onConfirm={() => void runCleanup(selectedRow.name)}
        />
      )}

      {cleanupState.phase === "done" && (
        <CleanupResultView result={cleanupState.result} />
      )}

      {actionState.phase === "failed" && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-red-700" data-testid="wt-action-error">
          {actionState.message}
        </div>
      )}
      {actionState.phase === "success" && (
        <div className="text-emerald-600" data-testid="wt-action-status">
          {actionLabel(actionState.action)} 成功
        </div>
      )}
      {actionState.phase === "pending" && (
        <div className="text-slate-500" data-testid="wt-action-status">
          {actionLabel(actionState.action)} 进行中…
        </div>
      )}

      {logTail && (
        <pre
          className="max-h-48 overflow-auto rounded bg-slate-900 p-2 font-mono text-[10px] text-slate-200"
          data-testid="wt-log-tail"
        >
          {logTail.join("\n") || "(日志为空)"}
        </pre>
      )}

      {summary && (
        <div className="flex flex-col gap-1 rounded border border-slate-200 p-2" data-testid="worktree-summary">
          <div className="text-slate-600">
            <span className="font-semibold">{summary.branch}</span> @ {summary.head} · 相对 {summary.diffStat.baseRef}：
            {summary.diffStat.files} 文件 <span className="text-emerald-600">+{summary.diffStat.insertions}</span>{" "}
            <span className="text-red-500">-{summary.diffStat.deletions}</span>
          </div>
          <div className="text-slate-500">
            未提交：staged {summary.working.staged} / unstaged {summary.working.unstaged} / untracked{" "}
            {summary.working.untracked}
          </div>
          <ul className="flex flex-col gap-0.5 text-slate-600">
            {summary.commits.map((c) => (
              <li key={c.hash} className="truncate">
                <span className="font-mono text-slate-400">{c.hash}</span> {c.subject}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function WorktreeRowItem({
  row,
  selected,
  onSelect,
}: {
  row: WorktreeRow
  selected: boolean
  onSelect: () => void
}) {
  return (
    <li
      className={`cursor-pointer rounded border px-2 py-1.5 transition-colors ${
        selected ? "border-blue-300 bg-blue-50/60" : "border-slate-200 hover:bg-slate-50"
      }`}
      data-testid={`worktree-row-${row.name}`}
      onClick={onSelect}
    >
      <div className="flex items-center gap-2">
        <span className="font-semibold text-slate-700">{row.name}</span>
        <span className="truncate text-slate-400">{row.branch}</span>
        {row.isMain && <span className="rounded bg-slate-100 px-1 text-slate-500">主仓</span>}
        <span className="ml-auto flex items-center gap-1.5">
          {row.preview ? (
            <>
              <AliveBadge label={`api :${row.preview.apiPort}`} alive={row.preview.apiAlive} />
              <AliveBadge label={`web :${row.preview.webPort}`} alive={row.preview.webAlive} />
              <span className="text-slate-400">{ownershipLabel(row.preview.ownership)}</span>
            </>
          ) : (
            <span className="text-slate-300">未运行</span>
          )}
        </span>
      </div>
      <MergeStatusLine row={row} />
    </li>
  )
}

/** AC11：相对 dev 的 ahead/behind + 「本地 dev 已包含提交」徽标 + 「可清理」提示 */
function MergeStatusLine({ row }: { row: WorktreeRow }) {
  const ms = row.mergeStatus
  if (row.isMain || !ms) return null
  const hasCounts = ms.ahead !== null || ms.behind !== null
  if (!hasCounts && ms.mergedHint !== true) return null
  return (
    <div className="mt-1 flex items-center gap-2 text-[10px]">
      {hasCounts && (
        <span className="text-slate-400" data-testid={`wt-aheadbehind-${row.name}`}>
          ↑{ms.ahead ?? "?"} ↓{ms.behind ?? "?"}
        </span>
      )}
      {ms.mergedHint === true && (
        <>
          <span className="rounded bg-emerald-50 px-1 text-emerald-600">本地 dev 已包含提交</span>
          <span className="text-emerald-500" data-testid={`wt-cleanable-${row.name}`}>
            可清理
          </span>
        </>
      )}
    </div>
  )
}

function AliveBadge({ label, alive }: { label: string; alive: boolean }) {
  return (
    <span className={`rounded px-1 ${alive ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-400"}`}>
      {alive ? "●" : "○"} {label}
    </span>
  )
}

function ownershipLabel(ownership: "ui" | "foreign" | "none"): string {
  if (ownership === "ui") return "UI 管理"
  if (ownership === "foreign") return "非 UI 管理"
  return "已停止"
}

function actionLabel(action: PreviewAction): string {
  if (action === "compile-backend") return "编译后端"
  if (action === "restart") return "重启整个 preview"
  return "启动"
}

// 续作 AC12 · 清理控件：两步确认（清理 → 确认清理）+ 进行中态
function CleanupControl({
  state,
  disabled,
  onStart,
  onCancel,
  onConfirm,
}: {
  state: CleanupState
  disabled: boolean
  onStart: () => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const btn =
    "rounded border px-2 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50"
  if (state.phase === "pending") {
    return (
      <div className="text-slate-500" data-testid="wt-cleanup-status">
        清理中…（停 preview → 删生成物 → git worktree remove → branch -d）
      </div>
    )
  }
  if (state.phase === "confirming") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-amber-600">
          确认清理？将停 preview → 删除整个 worktree（含其自造运行数据：node_modules / .runtime
          隔离 SQLite / uploads 等）+ `git branch -d`。<b>不影响主仓</b>；未提交工作或未恢复的原
          配置备份会被拒绝。
        </span>
        <button
          type="button"
          className={`${btn} border-red-300 bg-red-50 text-red-700 hover:bg-red-100`}
          data-testid="wt-cleanup-confirm"
          disabled={disabled}
          onClick={onConfirm}
        >
          确认清理
        </button>
        <button
          type="button"
          className={`${btn} border-slate-300 text-slate-700 hover:bg-slate-100`}
          data-testid="wt-cleanup-cancel"
          onClick={onCancel}
        >
          取消
        </button>
      </div>
    )
  }
  // idle / done → 显示清理入口（done 失败可重点击；成功后该行已消失，控件随之卸载）
  return (
    <button
      type="button"
      className={`${btn} border-slate-300 text-slate-700 hover:bg-slate-100`}
      data-testid="wt-cleanup-btn"
      disabled={disabled}
      onClick={onStart}
    >
      清理 worktree
    </button>
  )
}

function CleanupResultView({ result }: { result: CleanupResult }) {
  return (
    <div
      className={`rounded border p-2 ${result.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"}`}
      data-testid="wt-cleanup-result"
    >
      <div className="font-semibold">{result.ok ? "清理完成" : "清理未完成"}</div>
      <ul className="mt-1 flex flex-col gap-0.5">
        {(result.steps ?? []).map((s) => (
          <li key={s.name}>
            {s.ok ? "✓" : "✗"} {s.name}
            {s.message ? ` — ${s.message}` : ""}
          </li>
        ))}
      </ul>
    </div>
  )
}

function ActionBar({
  row,
  control,
  actionState,
  cleanupBusy,
  onAction,
  onToggleEmbed,
}: {
  row: WorktreeRow
  control: boolean
  actionState: ActionState
  cleanupBusy: boolean
  onAction: (action: PreviewAction) => void
  onToggleEmbed: () => void
}) {
  const running = Boolean(row.preview && (row.preview.apiAlive || row.preview.webAlive))
  const busy = actionState.phase === "pending"
  // 德彪 code-r1 P2-1：cleanup 确认/进行中禁所有 preview 操作（后端锁也会拒，UI 同步禁用）
  const disabled = busy || !control || cleanupBusy

  const btn =
    "rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"

  return (
    <div className="flex items-center gap-2">
      {running ? (
        <>
          <button type="button" className={btn} data-testid="wt-compile-btn" disabled={disabled} onClick={() => onAction("compile-backend")}>
            编译后端
          </button>
          <button type="button" className={btn} data-testid="wt-restart-btn" disabled={disabled} onClick={() => onAction("restart")}>
            重启整个 preview
          </button>
          {/* 德彪 r1 P2-4：受 control 门禁（D12 全钮禁用 + 防 preview 实例自嵌递归）；web 死不渲染 */}
          {row.preview?.webAlive && (
            <button type="button" className={btn} data-testid="wt-open-btn" disabled={disabled} onClick={onToggleEmbed}>
              打开前端
            </button>
          )}
        </>
      ) : (
        <button type="button" className={btn} data-testid="wt-start-btn" disabled={disabled} onClick={() => onAction("start")}>
          启动
        </button>
      )}
    </div>
  )
}
