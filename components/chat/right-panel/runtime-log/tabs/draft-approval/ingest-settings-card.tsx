"use client"

import { useEffect, useState } from "react"

import {
  useRuntimeConfigStore,
  type WikiCompileProvider,
} from "@/components/stores/runtime-config-store"
import { useSaveStatus } from "../../../use-save-status"

/**
 * F027 收录设置卡（小孙 2026-06-13 拍）：
 *   ①「编译模型放到claude里面不好 就跟我们这个记忆页面放到一起」→ 卡片挂审批页头部 ⚙，
 *     原 claude tab 下拉撤除（单一入口防漂移）
 *   ②「你这样写 我这样就只能用claude了」→ 编译引擎三选（claude / codex / gemini）
 *   ③「编译模型 我也要可以自己写 不然有时候新模型出了 你这里不更新的怎么办」→ 模型
 *     输入框自由填写（claude 给联想建议；留空 = 该引擎默认模型）
 *
 * 行为：保存即热生效（后端每次编译现读配置）；填错 id → CLI 失败 → 自动降级
 * Haiku 4.5 → 不行落 stub（log 可查，坏不了数据）。
 */

/** claude 引擎的联想建议（非白名单——可自由输入任意 id）。 */
const CLAUDE_MODEL_SUGGESTIONS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5",
]

const PROVIDERS: { id: WikiCompileProvider; label: string }[] = [
  { id: "claude", label: "claude" },
  { id: "codex", label: "codex" },
  { id: "gemini", label: "gemini" },
]

export function IngestSettingsCard() {
  const wikiCompile = useRuntimeConfigStore((s) => s.config.wikiCompile)
  const loaded = useRuntimeConfigStore((s) => s.loaded)
  const loadFailed = useRuntimeConfigStore((s) => s.loadFailed)
  const load = useRuntimeConfigStore((s) => s.load)
  const setWikiCompile = useRuntimeConfigStore((s) => s.setWikiCompile)

  const [provider, setProvider] = useState<WikiCompileProvider>(wikiCompile?.provider ?? "claude")
  const [model, setModel] = useState(wikiCompile?.primaryModel ?? "")
  // 德彪 kb-ux2 r1 P2：用户动过输入后，store 异步到达/外部变更不再覆盖（dirty guard）；
  // 保存成功视为与 store 重新对齐，恢复同步
  const [dirty, setDirty] = useState(false)
  const save = useSaveStatus({ idle: "保存" })

  // 审批页可能先于右侧配置面板打开 → 自取一次全局 config
  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  // store 异步到达/外部变更 → 同步进输入（同 F021 P2 模式；dirty 时不动用户输入）
  useEffect(() => {
    if (dirty) return
    setProvider(wikiCompile?.provider ?? "claude")
    setModel(wikiCompile?.primaryModel ?? "")
  }, [wikiCompile?.provider, wikiCompile?.primaryModel, dirty])

  const modelPlaceholder =
    provider === "claude" ? "留空 = claude-opus-4-7" : `留空 = ${provider} CLI 默认模型`

  return (
    <div
      className="rounded border border-slate-200 bg-white p-2.5 text-xs"
      data-testid="ingest-settings-card"
    >
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        收录设置 · 文档编译引擎
      </div>

      <div className="mb-2 flex items-center gap-3" role="radiogroup" aria-label="编译引擎">
        {PROVIDERS.map((p) => (
          <label key={p.id} className="flex cursor-pointer items-center gap-1 text-[11px]">
            <input
              type="radio"
              name="ingest-provider"
              value={p.id}
              checked={provider === p.id}
              // 保存在飞时禁编辑：旧请求成功后 setDirty(false) 会让 sync effect 吞掉新草稿
              disabled={save.status === "saving"}
              onChange={() => {
                setProvider(p.id)
                setDirty(true)
              }}
              aria-label={`引擎 ${p.label}`}
              data-testid={`ingest-settings-provider-${p.id}`}
            />
            <span className="font-mono">{p.label}</span>
          </label>
        ))}
      </div>

      <div className="mb-1 flex items-center gap-2">
        <input
          type="text"
          list="ingest-settings-model-suggestions"
          value={model}
          disabled={save.status === "saving"}
          onChange={(e) => {
            setModel(e.target.value)
            setDirty(true)
          }}
          placeholder={modelPlaceholder}
          aria-label="编译模型"
          data-testid="ingest-settings-model-input"
          className="flex-1 rounded border border-slate-200 bg-white px-2 py-1 font-mono text-[11px] text-slate-900 outline-none transition focus:border-indigo-400"
        />
        <datalist id="ingest-settings-model-suggestions">
          {(provider === "claude" ? CLAUDE_MODEL_SUGGESTIONS : []).map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <button
          type="button"
          // !loaded / loadFailed 也禁：配置没真拉到就保存 = 把默认值（claude+空 → null）
          // 写穿真配置（清段）。loadFailed 配重试按钮恢复。
          disabled={save.isBusy || !loaded || loadFailed}
          aria-busy={save.status === "saving"}
          onClick={() =>
            void save.run(() =>
              setWikiCompile(
                provider === "claude" && model.trim() === ""
                  ? null // 全默认 → 清除段（回落 claude + Opus 4.7）
                  : { provider, ...(model.trim() ? { primaryModel: model.trim() } : {}) },
              ).then(() => setDirty(false)), // 保存成功 → 与 store 对齐，恢复同步
            )
          }
          className={`shrink-0 rounded px-2.5 py-1 text-[10px] font-semibold text-white transition disabled:cursor-not-allowed ${
            save.status === "saved"
              ? "bg-emerald-600"
              : "bg-slate-900 hover:bg-slate-700 disabled:bg-slate-300"
          }`}
          data-testid="ingest-settings-save"
        >
          {save.label}
        </button>
      </div>

      {loadFailed && (
        <div className="mb-1 flex items-center gap-2 text-[10px] text-amber-600">
          ⚠ 配置未拉到（保存已禁用，防覆盖服务端既有设置）
          <button
            type="button"
            onClick={() => void load()}
            className="rounded border border-amber-300 px-1.5 py-0.5 hover:bg-amber-50"
            data-testid="ingest-settings-retry"
          >
            重试
          </button>
        </div>
      )}
      <div className="text-[10px] leading-relaxed text-slate-400">
        模型可自由填写（新模型直接敲 id）· 走订阅 CLI 不计费 · 保存即热生效 ·
        失败自动降级 Haiku 4.5（log 可查）
      </div>
    </div>
  )
}
