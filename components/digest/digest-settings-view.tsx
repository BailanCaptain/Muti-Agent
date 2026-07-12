"use client"

import { ArrowLeft, Check, Loader2, RotateCcw, Send } from "lucide-react"
import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  type SendNowStatus,
  type SettingsForm,
  type SettingsResponse,
  buildSettingsPayload,
  formFromEffective,
  groupSources,
  outcomeLine,
} from "./digest-settings-model"

/**
 * F037 日报设置页（小孙 07-05 §5「把前端能配的都一起做了」）：
 * 模型/收件人/X 账号/逐源开关/发送时间/邮件密度 + 立即补发。
 *（小红书编辑面 07-11 摘除——#31 转 F029，日报侧休眠；xhsKeywords 数据面原样往返）
 * secrets 永不显示值（只有已配置/未配置 chip）；保存走「与 .env 基线不同才落存储」diff。
 */

const API_BASE = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"

const MODEL_SUGGESTIONS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-haiku-4-5",
]

function SecretChip({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span
      className={
        ok
          ? "inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs text-green-800"
          : "inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-500"
      }
    >
      <span
        className={
          ok ? "h-1.5 w-1.5 rounded-full bg-green-500" : "h-1.5 w-1.5 rounded-full bg-slate-400"
        }
      />
      {label} · {ok ? "已配置" : "未配置"}
    </span>
  )
}

function Field({
  id,
  label,
  hint,
  children,
}: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-800">
        {label}
      </label>
      {children}
      {hint ? <div className="mt-1 text-xs text-slate-500">{hint}</div> : null}
    </div>
  )
}

const inputCls =
  "w-full rounded-lg border border-slate-200 bg-surface-elevated px-3 py-2 text-sm text-slate-800 outline-none focus-visible:ring-2 focus-visible:ring-accent-400"

export function DigestSettingsView() {
  const [resp, setResp] = useState<SettingsResponse | null>(null)
  const [form, setForm] = useState<SettingsForm | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [saveErrors, setSaveErrors] = useState<string[]>([])
  const [sendStatus, setSendStatus] = useState<SendNowStatus | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/daily-digest/settings`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as SettingsResponse
      setResp(data)
      setForm(formFromEffective(data.effective))
      setLoadError(null)
    } catch (err) {
      setLoadError(`设置加载失败：${String(err)}`)
    }
  }, [])

  const pollSendNow = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/daily-digest/send-now`)
      if (!res.ok) return
      const st = (await res.json()) as SendNowStatus
      setSendStatus(st)
      if (!st.running && pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    } catch {
      /* 轮询失败静默，下一拍再试 */
    }
  }, [])

  useEffect(() => {
    void load()
    void pollSendNow() // 挂载即查一次：接住页面刷新前已在跑的补发
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [load, pollSendNow])

  useEffect(() => {
    // 已在跑（含刷新接住的）→ 起轮询
    if (sendStatus?.running && !pollRef.current) {
      pollRef.current = setInterval(() => void pollSendNow(), 3000)
    }
  }, [sendStatus?.running, pollSendNow])

  async function save(payloadOverride?: null) {
    if (!resp || !form) return
    setSaving(true)
    setSaveMsg(null)
    setSaveErrors([])
    try {
      const payload =
        payloadOverride === null ? null : buildSettingsPayload(form, resp.seedEffective)
      const res = await fetch(`${API_BASE}/api/daily-digest/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: payload }),
      })
      const body = (await res.json()) as {
        ok?: boolean
        errors?: string[]
        error?: string
        effective?: SettingsResponse["effective"]
      }
      if (!res.ok) {
        setSaveErrors(body.errors ?? [body.error ?? `HTTP ${res.status}`])
        return
      }
      setSaveMsg(payload === null ? "已恢复 .env 默认" : "已保存（下一轮日报生效）")
      await load()
    } catch (err) {
      setSaveErrors([String(err)])
    } finally {
      setSaving(false)
    }
  }

  async function sendNow() {
    setSaveMsg(null)
    try {
      const res = await fetch(`${API_BASE}/api/daily-digest/send-now`, { method: "POST" })
      const body = (await res.json()) as { error?: string; startedAt?: string }
      if (res.status === 202) {
        setSendStatus({ running: true, startedAt: body.startedAt ?? null, lastOutcome: null })
      } else {
        setSaveErrors([body.error ?? `HTTP ${res.status}`])
      }
    } catch (err) {
      setSaveErrors([String(err)])
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {loadError}
        </div>
      </div>
    )
  }
  if (!resp || !form) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-sunken text-sm text-slate-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 设置加载中…
      </div>
    )
  }

  const set = (patch: Partial<SettingsForm>) => setForm({ ...form, ...patch })
  const grouped = groupSources(resp.sources)

  return (
    <div className="min-h-screen bg-surface-sunken">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <Link
              href="/digest"
              className="mb-2 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-accent-600"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> 返回日报
            </Link>
            <h1 className="text-xl font-semibold text-slate-900">日报设置</h1>
            <p className="mt-1 text-xs text-slate-500">
              改动保存后下一轮生效（无需重启）；留空/与 .env 相同的项自动回落 .env 配置
            </p>
          </div>
          {!resp.enabled ? (
            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-800">
              日报未启用（SMTP/收件人未配齐；配齐后重启 runtime 生效）
            </span>
          ) : null}
        </div>

        {/* 凭证态（只读 chip，值永不下发） */}
        <section className="mb-4 rounded-xl border border-slate-200 bg-surface p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-800">凭证 · .env 人工件</h2>
          <div className="flex flex-wrap gap-2">
            <SecretChip label="QQ SMTP" ok={resp.secrets.smtp} />
            <SecretChip label="GitHub PAT" ok={resp.secrets.githubPat} />
            <SecretChip label="X API Key" ok={resp.secrets.xApiKey} />
            <SecretChip label="自建 RSSHub" ok={resp.secrets.rsshubBase} />
          </div>
        </section>

        {/* 摘要模型 */}
        <section className="mb-4 rounded-xl border border-slate-200 bg-surface p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-800">摘要模型</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id="digest-primary-model"
              label="主力模型"
              hint="自由输入 model id，新模型无需等代码更新"
            >
              <input
                id="digest-primary-model"
                className={inputCls}
                list="digest-model-suggestions"
                value={form.primaryModel}
                onChange={(e) => set({ primaryModel: e.target.value })}
              />
            </Field>
            <Field id="digest-fallback-model" label="兜底模型" hint="主力失败自动降级重试一次">
              <input
                id="digest-fallback-model"
                className={inputCls}
                list="digest-model-suggestions"
                value={form.fallbackModel}
                onChange={(e) => set({ fallbackModel: e.target.value })}
              />
            </Field>
            <datalist id="digest-model-suggestions">
              {MODEL_SUGGESTIONS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
        </section>

        {/* 收件与时间 */}
        <section className="mb-4 rounded-xl border border-slate-200 bg-surface p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-800">收件与时间</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id="digest-recipients"
              label="收件人"
              hint="每行一个（或逗号分隔）；发信白名单同步生效"
            >
              <textarea
                id="digest-recipients"
                className={`${inputCls} h-24 resize-y`}
                value={form.recipientsText}
                onChange={(e) => set({ recipientsText: e.target.value })}
              />
            </Field>
            <div className="grid gap-3">
              <Field
                id="digest-send-time"
                label="发送时间"
                hint="到点后由调度轮触发（每小时安全网兜底）"
              >
                <input
                  id="digest-send-time"
                  type="time"
                  className={inputCls}
                  value={form.sendTime}
                  onChange={(e) => set({ sendTime: e.target.value })}
                />
              </Field>
              <Field
                id="digest-rest-rows"
                label="其余速览行数 / 板块"
                hint="0 = 关掉速览区；行数多会逼近 Gmail 102KB 裁剪线"
              >
                <input
                  id="digest-rest-rows"
                  type="number"
                  min={0}
                  max={30}
                  className={inputCls}
                  value={form.restOverviewRows}
                  onChange={(e) =>
                    set({
                      restOverviewRows: Math.max(0, Math.min(30, Number(e.target.value) || 0)),
                    })
                  }
                />
              </Field>
            </div>
          </div>
        </section>

        {/* 内容偏好（小红书关键词编辑面 07-11 摘除：#31 已转 F029 当核查源、日报侧休眠；
            form.xhsKeywordsText 仍随 payload 原样往返——已存配置不动、适配器代码留存） */}
        <section className="mb-4 rounded-xl border border-slate-200 bg-surface p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-800">内容偏好</h2>
          <Field
            id="digest-x-handles"
            label={`X 关注账号（${form.xHandlesText ? form.xHandlesText.split(/[\n,]/).filter((s) => s.trim()).length : 0}）`}
            hint="每行一个，@ 可省；清空 = 关闭 X 板块"
          >
            <textarea
              id="digest-x-handles"
              className={`${inputCls} h-40 resize-y`}
              value={form.xHandlesText}
              onChange={(e) => set({ xHandlesText: e.target.value })}
            />
          </Field>
        </section>

        {/* 逐源开关 */}
        <section className="mb-4 rounded-xl border border-slate-200 bg-surface p-4">
          <h2 className="mb-1 text-sm font-semibold text-slate-800">信源开关</h2>
          <p className="mb-3 text-xs text-slate-500">
            取消勾选 = 下一轮不抓该源（X 还受上方关注账号控制）
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {grouped.map((g) => (
              <div key={g.category}>
                <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-accent-600">
                  {g.label}
                </div>
                <div className="space-y-1">
                  {g.items.map((s) => {
                    const disabled = form.disabledSources.includes(s.id)
                    return (
                      <label
                        key={s.id}
                        className="flex cursor-pointer items-center gap-2 text-sm text-slate-700"
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-accent"
                          checked={!disabled}
                          onChange={() =>
                            set({
                              disabledSources: disabled
                                ? form.disabledSources.filter((d) => d !== s.id)
                                : [...form.disabledSources, s.id],
                            })
                          }
                        />
                        <span>{s.label}</span>
                        <span className="text-xs text-slate-400">{s.id}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 操作区 */}
        <section className="rounded-xl border border-slate-200 bg-surface p-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-600 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              保存设置
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void save(null)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-surface-elevated px-4 py-2 text-sm text-slate-700 hover:border-accent-300"
            >
              <RotateCcw className="h-4 w-4" /> 恢复 .env 默认
            </button>
            <div className="mx-2 h-6 w-px bg-slate-200" />
            <button
              type="button"
              disabled={!resp.enabled || Boolean(sendStatus?.running)}
              onClick={() => void sendNow()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-accent-300 bg-accent-50 px-4 py-2 text-sm font-medium text-accent-700 hover:bg-accent-100 disabled:opacity-50"
              title={resp.enabled ? "用当前设置立刻跑一轮并发信（约 5-8 分钟）" : "SMTP 未配置"}
            >
              {sendStatus?.running ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {sendStatus?.running ? "补发中…（约 5-8 分钟）" : "立即补发"}
            </button>
          </div>
          {saveMsg ? <div className="mt-3 text-sm text-green-700">{saveMsg}</div> : null}
          {saveErrors.length > 0 ? (
            <ul className="mt-3 space-y-1 text-sm text-red-700">
              {saveErrors.map((e) => (
                <li key={e}>· {e}</li>
              ))}
            </ul>
          ) : null}
          {sendStatus?.lastOutcome ? (
            <div className="mt-3 text-sm text-slate-700">{outcomeLine(sendStatus.lastOutcome)}</div>
          ) : null}
        </section>
      </div>
    </div>
  )
}
