import { DIGEST_GITHUB_SECTION_LABEL } from "@multi-agent/shared"

/**
 * F037 设置页数据模型（小孙 07-05 §5）：纯函数层。
 * 核心语义 = 「与 .env 基线相同的字段不落存储」：表单值与 seedEffective 一致的字段
 * 从 PUT payload 里省略 → 保持字段级回落（.env 改了还能跟）；全部一致 → payload null（清段）。
 */

export interface DigestSettingsDto {
  primaryModel?: string
  fallbackModel?: string
  recipients?: string[]
  xHandles?: string[]
  xhsKeywords?: string[]
  disabledSources?: string[]
  sendTime?: string
  restOverviewRows?: number
}

export interface EffectiveSettings {
  primaryModel: string
  fallbackModel: string
  recipients: string[]
  xHandles: string[]
  xhsKeywords: string[]
  disabledSources: string[]
  sendTime: string
  restOverviewRows: number
}

export interface SourceMeta {
  id: string
  category: string
  label: string
}

export interface EmergencyFallback {
  provider: "codex"
  model: string
  effort: string
}

export interface SettingsResponse {
  enabled: boolean
  stored: DigestSettingsDto | null
  effective: EffectiveSettings
  seedEffective: EffectiveSettings
  emergencyFallback: EmergencyFallback
  envSeeds: { recipients: string[]; xHandles: string[]; xhsKeywords: string[] }
  secrets: {
    smtp: boolean
    githubPat: boolean
    xApiKey: boolean
    rsshubBase: boolean
    xhsBase: boolean
  }
  sources: SourceMeta[]
}

export function formatEmergencyFallback(fallback: EmergencyFallback): string {
  const model = fallback.model === "gpt-5.6-sol" ? "GPT-5.6 Sol" : fallback.model
  const provider = fallback.provider === "codex" ? "Codex" : fallback.provider
  return `最终兜底：${model} · ${provider} · ${fallback.effort}，仅前两层均失败时启用`
}

/** 表单态：文本域存原始串（提交时解析），开关存禁用集合 */
export interface SettingsForm {
  primaryModel: string
  fallbackModel: string
  recipientsText: string
  xHandlesText: string
  xhsKeywordsText: string
  disabledSources: string[]
  sendTime: string
  restOverviewRows: number
}

/** 逗号/换行/空白混填都收：trim、去空、保序去重（大小写保留，去重不折叠） */
export function parseListInput(text: string): string[] {
  const out: string[] = []
  for (const part of text.split(/[\n,]/)) {
    const v = part.trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

export function listToInput(list: string[]): string {
  return list.join("\n")
}

export function formFromEffective(eff: EffectiveSettings): SettingsForm {
  return {
    primaryModel: eff.primaryModel,
    fallbackModel: eff.fallbackModel,
    recipientsText: listToInput(eff.recipients),
    xHandlesText: listToInput(eff.xHandles),
    xhsKeywordsText: listToInput(eff.xhsKeywords),
    disabledSources: [...eff.disabledSources],
    sendTime: eff.sendTime,
    restOverviewRows: eff.restOverviewRows,
  }
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * 表单 → PUT payload：只含与 .env 基线（seedEffective）不同的字段。
 * 全同 → null（PUT settings:null 清空整段，彻底回落 .env）。
 */
export function buildSettingsPayload(
  form: SettingsForm,
  seed: EffectiveSettings,
): DigestSettingsDto | null {
  const out: DigestSettingsDto = {}
  const pm = form.primaryModel.trim()
  if (pm && pm !== seed.primaryModel) out.primaryModel = pm
  const fm = form.fallbackModel.trim()
  if (fm && fm !== seed.fallbackModel) out.fallbackModel = fm
  const recipients = parseListInput(form.recipientsText)
  if (!sameList(recipients, seed.recipients)) out.recipients = recipients
  const handles = parseListInput(form.xHandlesText).map((h) => h.replace(/^@/, ""))
  if (!sameList(handles, seed.xHandles)) out.xHandles = handles
  const keywords = parseListInput(form.xhsKeywordsText)
  if (!sameList(keywords, seed.xhsKeywords)) out.xhsKeywords = keywords
  // 种子基线 disabledSources 恒为空（默认全开）→ 有禁用才落字段，全开省略
  const disabled = [...form.disabledSources].sort()
  if (disabled.length > 0) out.disabledSources = disabled
  if (form.sendTime !== seed.sendTime) out.sendTime = form.sendTime
  if (form.restOverviewRows !== seed.restOverviewRows) out.restOverviewRows = form.restOverviewRows
  return Object.keys(out).length > 0 ? out : null
}

export interface SendNowStatus {
  running: boolean
  startedAt: string | null
  lastOutcome:
    | ({ status: string; businessDate?: string; detail?: string } & {
        startedAt: string
        finishedAt: string
      })
    | null
}

/** send-now 结果 → 人话一行 */
export function outcomeLine(o: NonNullable<SendNowStatus["lastOutcome"]>): string {
  const at = o.finishedAt.slice(11, 19)
  switch (o.status) {
    case "ok":
      return `✓ ${o.businessDate ?? ""} 已发送（${at} 完成）`
    case "send_failed":
      return `✗ 发送失败：${o.detail ?? "SMTP 异常"}`
    case "failed_no_items":
      return "✗ 全部内容源为空，本轮未发"
    case "failed_summarize":
      return "✗ AI 摘要多次尝试全败，本轮未发（下一整点自动重试）"
    case "error":
      return `✗ 构建异常：${o.detail ?? "未知错误"}`
    case "skipped_needs_manual":
      return "✗ 已连续失败 ≥2 次转人工（force 不应出现此态）"
    default:
      return `${o.status}（${at}）`
  }
}

/** 逐源开关分组（顺序：ai → community → hot → github，与日报板块序一致） */
export function groupSources(
  sources: SourceMeta[],
): Array<{ category: string; label: string; items: SourceMeta[] }> {
  const ORDER: Array<{ category: string; label: string }> = [
    { category: "ai", label: "AI 板块" },
    { category: "community", label: "社区动态" },
    { category: "hot", label: "热点板块" },
    // #33 播客（07-11 preview 实截抓漏：ORDER 写死四类会把 podcast 源静默吞掉，
    // 设置页无开关可关）；排位对齐邮件板块序（hot 与 github 之间）
    { category: "podcast", label: "播客速递" },
    { category: "github", label: DIGEST_GITHUB_SECTION_LABEL },
  ]
  return ORDER.map((g) => ({
    ...g,
    items: sources.filter((s) => s.category === g.category),
  })).filter((g) => g.items.length > 0)
}
