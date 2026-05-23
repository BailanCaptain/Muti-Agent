"use client"

import { useEffect, useMemo, useState } from "react"
import {
  type DraftType,
  type PreviewWarning,
  detectIngestMime,
  useIngestCommit,
  useIngestPreview,
} from "./use-ingest-api"

/**
 * F027 Phase 3 Week 4 Day 19a (AC-P3-6 + AC-P3-10) · IngestModal
 *
 * 真相源：
 *   - V16.5 chap 25 line 2547-2619 (IngestModal 完整设计 wireframe + API)
 *   - feature.md AC-P3-6 (3 入口 + sanitize 预扫 + LLM 编译预览 + multi-drop 关联 → 点 [/ingest 编译] 才落盘)
 *   - feature.md AC-P3-10 (commit endpoint 落盘闭环：preview 不落盘 / commit 才落盘 / 失败不产生 wiki_events)
 *
 * UI 段（按 V16.5 chap 25 wireframe 顺序）：
 *   1. 文件信息（fileName + size）
 *   2. 类型选择（6 type radio）
 *   3. 备注（可选 textarea，本 Modal 只走 UI 不送 backend Day 19a — backend 不接受 reason 字段；Day 19b 评估扩 contract）
 *   4. 5 层 Sanitize 预扫结果（warnings 列表 + kind 颜色区分）
 *   5. LLM 编译预览（Day 5 stub markdown，含 frontmatter）
 *   6. 底部按钮 [取消] [/ingest 编译]
 *
 * 数据流:
 *   - Modal open → 已 props.file → 自动 useIngestPreview.preview() → 拿 sanitize 结果 + previewId
 *   - 用户改 targetType → 重新 preview（注：Day 19a 只在 mount 时 preview 一次，type 改不重 preview，
 *     避免频繁 sanitize；backend type 推断逻辑在 Phase 4 LLM compile 时才用，preview stub 不参考 type）
 *   - 点 [/ingest 编译] → useIngestCommit.commit(previewId, callerAlias) → 显示 finalPath + close
 *   - 点 [取消] → reset hooks + onClose() — preview 不落盘 (AC-P3-10)
 *
 * 不做（Day 19a 范围）：
 *   - composer 拖文件 / KB 按钮 / slash-menu 触发（Day 19b）
 *   - series 选择 (V16.5 chap 25 wireframe §3 系列防 chained 误检) — backend Phase 4 才接 series_id
 *   - 备注送 backend (backend contract 无 reason 字段) — Day 19a UI 留位置
 */

export interface IngestModalFile {
  name: string
  /** UTF-8 string content (已读完)。Phase 3 Day 19a 不处理 binary。 */
  content: string
  /** byte size (UTF-8)。仅 UI 显示。 */
  sizeBytes: number
}

export interface IngestModalProps {
  open: boolean
  file: IngestModalFile | null
  /** 当前用户 alias (commit endpoint callerAlias 必填)。 */
  callerAlias: string
  onClose: () => void
  /** Commit 成功回调（caller 可 invalidate caches / 刷 drafts 列表）。 */
  onCommitSuccess?: (response: { finalPath: string; ingestEventId: string }) => void
}

const DRAFT_TYPE_OPTIONS: DraftType[] = [
  "concept",
  "feature",
  "bug",
  "lesson",
  "wiki-memory",
  "session-archive",
]

export function IngestModal({
  open,
  file,
  callerAlias,
  onClose,
  onCommitSuccess,
}: IngestModalProps) {
  const [targetType, setTargetType] = useState<DraftType>("concept")
  const [reason, setReason] = useState<string>("") // Day 19a UI only
  // F027 P4 Day 10 AC-P4-3 e · Series 字段 (防 chained 误检)
  const [seriesId, setSeriesId] = useState<string>("")

  const previewHook = useIngestPreview()
  const commitHook = useIngestCommit()

  const mime = useMemo(() => (file ? detectIngestMime(file.name) : "text/plain"), [file])

  // 范-r1 P1-1 fix: targetType 进 deps + 重 preview
  // 旧设计错: backend ingest-preview.ts:198 真用 targetType 写 frontmatter `type` 字段,
  // 我之前注释 "preview stub 不参考 type" 是脑补未核 backend。
  // 切换 type 必须重 preview 拿匹配的 previewId, 不然 commit 会写旧 type 落盘。
  // 同时 reset commit state 防 stale commit data 还显示着。
  useEffect(() => {
    if (!open || !file) return
    // F027 P4 Day 10 AC-P4-3 e: seriesId UI invalid → 不 trigger preview (避免 backend reject 浪费)
    if (seriesId.length > 0 && !isValidSeriesId(seriesId)) return
    commitHook.reset() // 防新 preview + 旧 commit success 同屏
    previewHook.preview({
      sourcePath: file.name,
      content: file.content,
      mimeType: mime,
      targetType,
      seriesId: seriesId.length > 0 ? seriesId : undefined,
    })
  }, [open, file, mime, targetType, seriesId, previewHook.preview, commitHook.reset])

  // Commit 成功 → 触发回调 + 不立即 close（让用户看 finalPath 后手动关闭）
  useEffect(() => {
    if (commitHook.data) {
      onCommitSuccess?.({
        finalPath: commitHook.data.finalPath,
        ingestEventId: commitHook.data.ingestEventId,
      })
    }
  }, [commitHook.data, onCommitSuccess])

  // 范-r1 P2 fix: Escape key → handleCancel (与 confirm-dialog / agent-config-drawer 一致 a11y)
  // biome-ignore lint/correctness/useExhaustiveDependencies: handleCancel 内联，避免依赖循环
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        previewHook.reset()
        commitHook.reset()
        setReason("")
        setSeriesId("")
        onClose()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [open, onClose])

  if (!open || !file) return null

  const handleCancel = () => {
    previewHook.reset()
    commitHook.reset()
    setReason("")
    setSeriesId("")
    onClose()
  }

  const handleCommit = async () => {
    if (!previewHook.data) return
    await commitHook.commit({
      previewId: previewHook.data.previewId,
      callerAlias,
    })
  }

  const previewBlocked =
    previewHook.data?.warnings.some((w) => w.kind === "sensitive_token") ?? false

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="ingest-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleCancel()
      }}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-slate-300 bg-white shadow-xl"
        data-testid="ingest-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ingest-modal-title"
      >
        <Header fileName={file.name} onClose={handleCancel} />
        <div className="flex-1 overflow-y-auto px-4 py-3 text-xs">
          <FileSection file={file} />
          <TypeSection value={targetType} onChange={setTargetType} />
          <SeriesSection value={seriesId} onChange={setSeriesId} />
          <ReasonSection value={reason} onChange={setReason} />
          <SanitizeSection
            isLoading={previewHook.isLoading}
            error={previewHook.error}
            warnings={previewHook.data?.warnings ?? null}
          />
          <CompilePreviewSection
            isLoading={previewHook.isLoading}
            llmCompiledPreview={previewHook.data?.llmCompiledPreview ?? null}
          />
          {commitHook.data && <CommitSuccessSection data={commitHook.data} />}
          {commitHook.error && <CommitErrorSection error={commitHook.error} />}
        </div>
        <Footer
          onCancel={handleCancel}
          onCommit={handleCommit}
          canCommit={
            // 范-r1 P1-2 fix: commit 必须 !previewHook.isLoading
            // (旧条件依赖 data 非 null + setData(null) on preview start 间接守住,
            // 但显式 !isLoading 更清晰防 race window 漏)
            !!previewHook.data &&
            !previewHook.isLoading &&
            !previewBlocked &&
            !commitHook.isLoading &&
            !commitHook.data
          }
          isCommitting={commitHook.isLoading}
          isCommitted={!!commitHook.data}
          blocked={previewBlocked}
        />
      </div>
    </div>
  )
}

function Header({ fileName, onClose }: { fileName: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between border-slate-200 border-b px-4 py-2.5">
      <h2 id="ingest-modal-title" className="font-semibold text-slate-800 text-sm">
        📎 /ingest: <span className="font-mono">{fileName}</span>
      </h2>
      <button
        type="button"
        onClick={onClose}
        data-testid="ingest-modal-close"
        className="rounded p-1 text-slate-500 hover:bg-slate-100"
        aria-label="关闭"
      >
        ✕
      </button>
    </div>
  )
}

function FileSection({ file }: { file: IngestModalFile }) {
  return (
    <section className="mb-3" data-testid="ingest-section-file">
      <h3 className="font-semibold text-[10px] uppercase tracking-wider text-slate-500">📄 文件</h3>
      <div className="mt-1 text-slate-700">
        <div className="font-mono">{file.name}</div>
        <div className="text-[10px] text-slate-500">{formatBytes(file.sizeBytes)}</div>
      </div>
    </section>
  )
}

function TypeSection({
  value,
  onChange,
}: {
  value: DraftType
  onChange: (v: DraftType) => void
}) {
  return (
    <section className="mb-3" data-testid="ingest-section-type">
      <h3 className="font-semibold text-[10px] uppercase tracking-wider text-slate-500">
        🏷 类型 (preview 用 stub LLM, type 推断 Phase 4 接真 LLM)
      </h3>
      <div className="mt-1 flex flex-wrap gap-2">
        {DRAFT_TYPE_OPTIONS.map((t) => (
          <label
            key={t}
            className="flex items-center gap-1 text-slate-700 text-[11px]"
            data-testid={`ingest-type-radio-${t}`}
          >
            <input
              type="radio"
              name="ingest-type"
              value={t}
              checked={value === t}
              onChange={() => onChange(t)}
            />
            {t}
          </label>
        ))}
      </div>
    </section>
  )
}

function ReasonSection({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <section className="mb-3" data-testid="ingest-section-reason">
      <h3 className="font-semibold text-[10px] uppercase tracking-wider text-slate-500">
        📝 备注 (Day 19a UI only — backend contract Phase 4 才接受)
      </h3>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="给未来的自己 / LLM 编译时的预期 ..."
        className="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-700"
        rows={2}
        data-testid="ingest-reason-textarea"
      />
    </section>
  )
}

/**
 * F027 P4 Day 10 AC-P4-3 e · SeriesSection (V16.5 chap 25 line 2563-2564)
 *
 * 🔗 系列 (防 chained 误检) — 可选 free-text input
 *   - 用户分多次 drop 同一长 paper 的章节时填同一 series_id (例 "rag-paper-v1")
 *   - backend ingest commit 时 inject 到落盘 markdown frontmatter `series_id: <id>`
 *   - 后续 multi-drop cross-correlation chained_suspect 检测会跳过同 series_id 命中
 *   - 限制: 1-64 chars + [a-zA-Z0-9_-]+ (backend contract 强约束; UI 端实时校验)
 *
 * 不做 (Week 3+ 范围):
 *   - dropdown 已有 series list (需 GET /api/wiki/series endpoint, Phase 4+ 接)
 *   - [+ 新建系列] 按钮 (现在 free-text 就够)
 */
const SERIES_ID_PATTERN = /^[a-zA-Z0-9_-]+$/

function isValidSeriesId(value: string): boolean {
  return value.length > 0 && value.length <= 64 && SERIES_ID_PATTERN.test(value)
}
function SeriesSection({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const tooLong = value.length > 64
  const invalidChars = value.length > 0 && !SERIES_ID_PATTERN.test(value)
  const hasError = tooLong || invalidChars
  return (
    <section className="mb-3" data-testid="ingest-section-series">
      <h3 className="font-semibold text-[10px] uppercase tracking-wider text-slate-500">
        🔗 系列 (可选 · 防 chained 误检)
      </h3>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="如 'rag-paper-v1' — 分多次 drop 同 paper 章节时填同 id"
        className={`mt-1 w-full rounded border px-2 py-1 text-[11px] font-mono ${
          hasError ? "border-red-300 text-red-700" : "border-slate-200 text-slate-700"
        }`}
        data-testid="ingest-series-input"
      />
      {tooLong && (
        <div className="mt-0.5 text-[10px] text-red-600" data-testid="ingest-series-error-toolong">
          系列 id 最多 64 字符（当前 {value.length}）
        </div>
      )}
      {invalidChars && !tooLong && (
        <div className="mt-0.5 text-[10px] text-red-600" data-testid="ingest-series-error-chars">
          系列 id 只允许字母 / 数字 / _ / -（不可含空格或特殊字符）
        </div>
      )}
    </section>
  )
}

function SanitizeSection({
  isLoading,
  error,
  warnings,
}: {
  isLoading: boolean
  error: string | null
  warnings: PreviewWarning[] | null
}) {
  return (
    <section className="mb-3" data-testid="ingest-section-sanitize">
      <h3 className="font-semibold text-[10px] uppercase tracking-wider text-slate-500">
        ⚠️ 5 层 Sanitize 预扫结果
      </h3>
      {isLoading && <div className="mt-1 text-[11px] text-slate-400">⏳ 预扫中…</div>}
      {error && (
        <div className="mt-1 text-[11px] text-red-500" data-testid="ingest-sanitize-error">
          ⚠ 预扫失败：{error}
        </div>
      )}
      {!isLoading && !error && warnings && warnings.length === 0 && (
        <div className="mt-1 text-[11px] text-green-600" data-testid="ingest-sanitize-clean">
          ✅ 5 层全部通过 — 无 sanitize warning
        </div>
      )}
      {warnings && warnings.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5" data-testid="ingest-sanitize-warnings">
          {warnings.map((w, i) => (
            <li
              key={`${w.kind}-${i}`}
              className={`rounded px-2 py-1 text-[11px] ${warningColorClass(w.kind)}`}
              data-testid={`ingest-sanitize-warning-${w.kind}`}
              data-subkind={w.subkind ?? ""}
            >
              {warningIcon(w.kind)} {w.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function warningColorClass(kind: PreviewWarning["kind"]): string {
  switch (kind) {
    case "sensitive_token":
      return "bg-red-50 text-red-700 border border-red-200"
    case "size_truncated":
      return "bg-amber-50 text-amber-700 border border-amber-200"
    case "encoding":
      return "bg-slate-50 text-slate-600 border border-slate-200"
    case "binary_skipped":
      return "bg-blue-50 text-blue-700 border border-blue-200"
    default:
      return "bg-slate-50 text-slate-600 border border-slate-200"
  }
}

function warningIcon(kind: PreviewWarning["kind"]): string {
  switch (kind) {
    case "sensitive_token":
      return "🚫"
    case "size_truncated":
      return "✂️"
    case "encoding":
      return "🔤"
    case "binary_skipped":
      return "📦"
    default:
      return "⚠️"
  }
}

function CompilePreviewSection({
  isLoading,
  llmCompiledPreview,
}: {
  isLoading: boolean
  llmCompiledPreview: string | null
}) {
  return (
    <section className="mb-3" data-testid="ingest-section-compile-preview">
      <h3 className="font-semibold text-[10px] uppercase tracking-wider text-slate-500">
        🤖 LLM 编译预览 (Day 5 stub · Phase 4 接真 LLM)
      </h3>
      {isLoading && <div className="mt-1 text-[11px] text-slate-400">⏳ 编译中…</div>}
      {llmCompiledPreview !== null && (
        <pre
          className="mt-1 max-h-48 overflow-y-auto rounded border border-slate-200 bg-slate-50 p-2 font-mono text-[10px] text-slate-700"
          data-testid="ingest-compile-preview-content"
        >
          {llmCompiledPreview || "(empty)"}
        </pre>
      )}
    </section>
  )
}

function CommitSuccessSection({
  data,
}: {
  data: { finalPath: string; ingestEventId: string; committedAt: string }
}) {
  return (
    <section
      className="mb-3 rounded border border-green-200 bg-green-50 p-2"
      data-testid="ingest-section-commit-success"
    >
      <div className="font-semibold text-green-700 text-[11px]">✅ Commit 成功</div>
      <div className="mt-1 text-[10px] text-slate-700">
        <div>
          落盘路径: <span className="font-mono">{data.finalPath}</span>
        </div>
        <div>wiki_events id: {data.ingestEventId}</div>
        <div>提交时刻: {data.committedAt}</div>
      </div>
    </section>
  )
}

function CommitErrorSection({ error }: { error: string }) {
  return (
    <section
      className="mb-3 rounded border border-red-200 bg-red-50 p-2"
      data-testid="ingest-section-commit-error"
    >
      <div className="font-semibold text-[11px] text-red-700">⚠ Commit 失败</div>
      <div className="mt-1 text-[10px] text-red-600">{error}</div>
    </section>
  )
}

function Footer({
  onCancel,
  onCommit,
  canCommit,
  isCommitting,
  isCommitted,
  blocked,
}: {
  onCancel: () => void
  onCommit: () => void
  canCommit: boolean
  isCommitting: boolean
  isCommitted: boolean
  blocked: boolean
}) {
  return (
    <div className="flex items-center justify-end gap-2 border-slate-200 border-t bg-slate-50 px-4 py-2.5">
      {blocked && (
        <span className="mr-auto text-[10px] text-red-600" data-testid="ingest-footer-blocked">
          🚫 Sanitize 红线触发 — commit 已禁
        </span>
      )}
      <button
        type="button"
        onClick={onCancel}
        className="rounded border border-slate-300 bg-white px-3 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
        data-testid="ingest-modal-cancel"
      >
        {isCommitted ? "关闭" : "取消"}
      </button>
      <button
        type="button"
        onClick={onCommit}
        disabled={!canCommit}
        className="rounded bg-violet-600 px-3 py-1 text-[11px] text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        data-testid="ingest-modal-commit"
      >
        {isCommitting ? "提交中…" : "/ingest 编译"}
      </button>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
