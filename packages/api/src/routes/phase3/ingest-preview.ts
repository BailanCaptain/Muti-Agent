/**
 * F027 Phase 3 P20 · POST /api/wiki/ingest/preview — Week 1 Day 5
 *
 * 真相源：docs/plans/F027-phase3-implementation-plan.md §3 Week 1 Day 5
 *   + contracts.ts §4 PreviewIngestResponse
 *
 * 数据流：
 *   1. validatePreviewIngest 校验入参（mime 白名单 / content ≤ 1MB / sourcePath 必填）
 *   2. sanitizeRawDrop(content) → 5 层防御 + redLineTriggers + quarantinedSegments
 *   3. blocked=true → sanitizedContent='' + llmCompiledPreview='' + warnings 含红线
 *      blocked=false → 生成 minimal stub LLM 编译预览
 *   4. previewId = randomUUID；expiresAt = now + 10 min
 *
 * Day 5 范围："5 层 sanitize + LLM 编译预览（不落盘）"：
 *   - 5 层 sanitize：直接复用 Phase 1 P4 sanitizeRawDrop
 *   - LLM 编译预览：**Day 5 不真调 LLM**（成本 + 时延 + 预览仅为 UI 展示）
 *     生成 minimal stub markdown：frontmatter（type/title/source_path/generated_at/preview=true）+ body=sanitized
 *     Phase 4 接真 LLM compile-pipeline（已有 wiki/llm-compile/compile-pipeline.ts）
 *   - 不落盘：preview 内存返回；commit 落盘走 AC-P3-10 Week 2 Day 10 endpoint
 *   - 不持久化 previewId（in-memory map）：commit endpoint 通过 previewId 验证不在 Day 5 范围
 *
 * 不做（Day 5 范围）：
 *   - 不接 LLM compile-pipeline 真调（Phase 4 / Week 2 commit 阶段才接通）
 *   - 不实现 commit endpoint（AC-P3-10 Week 2 Day 10）
 *   - 不写 wiki_events / 不调 update_wiki（read-only preview）
 *   - 不持久化 previewId 到 DB（Week 2 commit 与本 endpoint 配套时再设计）
 */

import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { sanitizeRawDrop } from "../../wiki/sanitize/sanitize-raw-drop"
import type {
  QuarantinedSegment,
  RedLineTrigger,
  SanitizeResult,
} from "../../wiki/sanitize/types"
import {
  type DraftType,
  ErrorCode,
  HTTP_STATUS_BY_ERROR,
  type IngestMime,
  type PreviewIngestBody,
  type PreviewIngestResponse,
  toErrorResponse,
  validatePreviewIngest,
} from "./contracts"

const DEFAULT_PREVIEW_TTL_MS = 10 * 60 * 1000 // 10 minutes

export interface IngestPreviewServiceDeps {
  /** Preview TTL（commit endpoint AC-P3-10 必须在此前 commit；默认 10 min）。 */
  previewTtlMs?: number
  /** 注入 clock（测试用；默认 () => new Date()）。 */
  clock?: () => Date
  /** 注入 uuid（测试用确定性；默认 randomUUID()）。 */
  newId?: () => string
}

export class IngestPreviewService {
  private readonly previewTtlMs: number
  private readonly clock: () => Date
  private readonly newId: () => string

  constructor(deps: IngestPreviewServiceDeps = {}) {
    this.previewTtlMs = deps.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS
    this.clock = deps.clock ?? (() => new Date())
    this.newId = deps.newId ?? (() => randomUUID())
  }

  preview(body: PreviewIngestBody): PreviewIngestResponse {
    // 5 层 sanitize
    const sanitized = sanitizeRawDrop(body.content)
    const warnings = mapWarnings(sanitized)

    // blocked: 红线触发或 quarantinedRatio 超阈值 → sanitizedContent 空 + 不生成 LLM 编译预览
    if (sanitized.blocked) {
      return {
        previewId: this.newId(),
        sanitizedContent: "",
        llmCompiledPreview: "",
        warnings,
        expiresAt: new Date(this.clock().getTime() + this.previewTtlMs).toISOString(),
      }
    }

    // 通过：生成 minimal stub LLM 编译预览（Phase 4 接真 LLM）
    const compiled = buildLlmStubPreview({
      sourcePath: body.sourcePath,
      sanitizedContent: sanitized.sanitizedText,
      mimeType: body.mimeType,
      targetType: body.targetType,
      generatedAt: this.clock().toISOString(),
    })

    return {
      previewId: this.newId(),
      sanitizedContent: sanitized.sanitizedText,
      llmCompiledPreview: compiled,
      warnings,
      expiresAt: new Date(this.clock().getTime() + this.previewTtlMs).toISOString(),
    }
  }
}

/** 把 SanitizeResult 的 redLineTriggers + quarantinedSegments 映射到 contract.warnings。 */
function mapWarnings(result: SanitizeResult): PreviewIngestResponse["warnings"] {
  const out: PreviewIngestResponse["warnings"] = []
  for (const trig of result.redLineTriggers) {
    out.push({
      kind: redLineToWarningKind(trig),
      message: redLineMessage(trig),
    })
  }
  for (const seg of result.quarantinedSegments) {
    out.push({
      kind: quarantineToWarningKind(seg),
      message: quarantineMessage(seg),
    })
  }
  return out
}

function redLineToWarningKind(trig: RedLineTrigger): PreviewIngestResponse["warnings"][number]["kind"] {
  switch (trig.reason) {
    case "size_exceeded":
      return "size_truncated"
    case "jailbreak_template":
    case "encoded_jailbreak":
    case "dangerous_html_tag":
    case "dangerous_url_scheme":
      return "sensitive_token"
    default:
      return "sensitive_token"
  }
}

function redLineMessage(trig: RedLineTrigger): string {
  const base = `[redline:${trig.reason}] ${trig.matched}`
  return trig.detail ? `${base} (${trig.detail})` : base
}

function quarantineToWarningKind(
  seg: QuarantinedSegment,
): PreviewIngestResponse["warnings"][number]["kind"] {
  switch (seg.reason) {
    case "encoding_base64":
    case "encoding_rot13":
    case "encoding_high_entropy":
      return "encoding"
    default:
      // Unicode / HTML / fence 类隔离都归 sensitive_token（前端 UI 展示同色）
      return "sensitive_token"
  }
}

function quarantineMessage(seg: QuarantinedSegment): string {
  const preview = seg.original.length > 60 ? `${seg.original.slice(0, 60)}…` : seg.original
  const base = `[quarantine:${seg.reason}] ${JSON.stringify(preview)}`
  return seg.detail ? `${base} (${seg.detail})` : base
}

/** 生成 minimal stub LLM 编译预览（Day 5 不调真 LLM）。 */
function buildLlmStubPreview(input: {
  sourcePath: string
  sanitizedContent: string
  mimeType: IngestMime
  targetType?: DraftType
  generatedAt: string
}): string {
  const inferredType = input.targetType ?? inferTypeFromMime(input.mimeType, input.sanitizedContent)
  const title = extractTitle(input.sanitizedContent) ?? deriveTitleFromPath(input.sourcePath)
  const fm = [
    "---",
    `type: ${inferredType}`,
    `title: ${JSON.stringify(title)}`,
    `source_path: ${JSON.stringify(input.sourcePath)}`,
    `generated_at: ${input.generatedAt}`,
    "generated_by: phase3-preview-stub (Day 5)",
    "preview: true",
    "tainted_source: false",
    "---",
    "",
  ].join("\n")
  return fm + input.sanitizedContent.trim()
}

function inferTypeFromMime(mime: IngestMime, content: string): DraftType {
  if (mime === "application/json") return "concept"
  // markdown / plain text：从 frontmatter / 内容启发
  const headerMatch = content.match(/^#\s*([A-Z][\w-]*)/m)
  if (headerMatch) {
    const id = headerMatch[1]
    if (/^F\d+/.test(id)) return "feature"
    if (/^B\d+/.test(id)) return "bug"
    if (/^L\d+/.test(id)) return "lesson"
  }
  return "concept"
}

function extractTitle(content: string): string | null {
  const m = content.match(/^#\s+(.+?)\s*$/m)
  if (m) return m[1].trim()
  return null
}

function deriveTitleFromPath(sourcePath: string): string {
  const filename = sourcePath.split(/[\\/]/).pop() ?? sourcePath
  return filename.replace(/\.(md|txt|json)$/i, "")
}

export function registerIngestPreviewRoute(
  app: FastifyInstance,
  service: IngestPreviewService,
): void {
  app.post("/api/wiki/ingest/preview", async (request, reply) => {
    const validation = validatePreviewIngest(request.body)
    if (!validation.ok) {
      reply.code(HTTP_STATUS_BY_ERROR[validation.error])
      return toErrorResponse(validation)
    }
    try {
      return service.preview(validation.value)
    } catch (err) {
      request.log.error({ err }, "ingest preview threw")
      reply.code(HTTP_STATUS_BY_ERROR[ErrorCode.INTERNAL_ERROR])
      return toErrorResponse({
        ok: false,
        error: ErrorCode.INTERNAL_ERROR,
        message: (err as Error).message,
      })
    }
  })
}
