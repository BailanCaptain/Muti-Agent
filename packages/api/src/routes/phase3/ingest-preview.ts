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
 *     【F027 v3 G11 已接通真 LLM compile-pipeline（Opus 4.7）— stub 仅作 compile deps 未注入 / 编译失败的 fail-soft 回退；详见下方 G11 注释】
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
import { stringify as stringifyYaml } from "yaml"
import type { EmbeddingService } from "../../services/embedding-service"
import { runCompilePipelineWithRetry } from "../../wiki/llm-compile/compile-pipeline"
import { createPreviewWikiEventsWriter } from "../../wiki/llm-compile/preview-wiki-events-writer"
import type {
  CompileLLMClient,
  DraftResult,
  EntityExistenceChecker,
  IndexLiteLoader,
  WikiEventsWriter,
} from "../../wiki/llm-compile/types"
import { sanitizeRawDrop } from "../../wiki/sanitize/sanitize-raw-drop"
import type { QuarantinedSegment, RedLineTrigger, SanitizeResult } from "../../wiki/sanitize/types"
import {
  type DraftType,
  ErrorCode,
  HTTP_STATUS_BY_ERROR,
  type IngestMime,
  type PreviewIngestBody,
  type PreviewIngestResponse,
  type PreviewWarning,
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
  /**
   * F027 Phase 3 P20 Day 9-10 (AC-P3-10) · PreviewStore 注入。
   *
   * 传 store → preview 成功（非 blocked）时 put 一条 entry，commit endpoint 凭 previewId 取。
   * 不传 store → 老行为（仅返回 previewId 不持久化；Day 5 单元测试 backward compatible）。
   */
  store?: import("./preview-store").PreviewStore
  /**
   * F027 v3 G11 · LLM compile pipeline 依赖（注入 → preview 接真编译；不注入 → 退回 stub 预览）。
   */
  compile?: IngestCompileDeps
}

/**
 * F027 v3 G11 · preview 路径的 compile pipeline 依赖集。
 * embedding/indexLoader/llmClient/entityChecker = runCompilePipeline deps（去掉 wikiEvents，
 * preview 内部用 no-op writer，见 preview-wiki-events-writer.ts）。
 */
export interface IngestCompileDeps {
  embedding: Pick<EmbeddingService, "generateEmbedding" | "searchByVector">
  indexLoader: IndexLiteLoader
  llmClient: CompileLLMClient
  entityChecker: EntityExistenceChecker
  /** handbook "## 编译规则" 切片（server.ts loadHandbookSlices().compileRules）。 */
  handbookCompileRules: string
  /** schema 失败重试次数（默认 3，透传 runCompilePipelineWithRetry）。 */
  maxAttempts?: number
  /** 可选 log（编译失败 / fallback 记一笔；默认 noop）。 */
  logger?: (msg: string) => void
}

/**
 * F027 v3 G11 codex P2-3 · preview() 第二参（caller 侧 provenance，非用户输入）。
 * HTTP route 不传 → 默认 user-drop（tainted_source=true）。
 * DocsIngestRunner 直接 service-call 时传 docs-watcher（项目内文档，tainted_source=false）。
 */
export interface PreviewInternalOpts {
  provenance?: "user-drop" | "docs-watcher"
}

export class IngestPreviewService {
  private readonly previewTtlMs: number
  private readonly clock: () => Date
  private readonly newId: () => string
  private readonly store?: import("./preview-store").PreviewStore
  private readonly compile?: IngestCompileDeps
  /** preview 路径 no-op WikiEventsWriter（read-only 预览不落审计行）。 */
  private readonly previewWikiEvents: WikiEventsWriter

  constructor(deps: IngestPreviewServiceDeps = {}) {
    this.previewTtlMs = deps.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS
    this.clock = deps.clock ?? (() => new Date())
    this.newId = deps.newId ?? (() => randomUUID())
    this.store = deps.store
    this.compile = deps.compile
    this.previewWikiEvents = createPreviewWikiEventsWriter()
  }

  /**
   * F027 v3 G11：preview() 改 async（接真 LLM 编译，5-30s 延迟）。
   * compile deps 注入 → 真编译产 compiledMarkdown；未注入 / 编译失败 → 退回 stub 预览。
   */
  async preview(
    body: PreviewIngestBody,
    opts: PreviewInternalOpts = {},
  ): Promise<PreviewIngestResponse> {
    // 5 层 sanitize
    const sanitized = sanitizeRawDrop(body.content)
    const warnings = mapWarnings(sanitized)
    const createdAt = this.clock()
    const expiresAt = new Date(createdAt.getTime() + this.previewTtlMs).toISOString()

    // blocked: 红线触发或 quarantinedRatio 超阈值 → sanitizedContent 空 + 不生成 LLM 编译预览
    if (sanitized.blocked) {
      return {
        previewId: this.newId(),
        sanitizedContent: "",
        llmCompiledPreview: "",
        warnings,
        expiresAt,
      }
    }

    const previewId = this.newId()

    // 通过：真编译（compile deps 注入）或 stub（未注入 / 编译失败兜底）。
    let llmCompiledPreview: string
    let compiledMarkdown: string | undefined
    if (this.compile) {
      try {
        const draft = await this.runCompile(body, sanitized, previewId, createdAt, opts)
        compiledMarkdown = renderCompiledDraft(draft)
        llmCompiledPreview = compiledMarkdown
      } catch (err) {
        // 编译失败 fail-soft：退回 stub 预览 + schema_violation warning（不挂 UI，用户可仍 commit raw）。
        this.compile.logger?.(
          `ingest preview compile failed, falling back to stub: ${err instanceof Error ? err.message : String(err)}`,
        )
        llmCompiledPreview = buildLlmStubPreview({
          sourcePath: body.sourcePath,
          sanitizedContent: sanitized.sanitizedText,
          mimeType: body.mimeType,
          targetType: body.targetType,
          generatedAt: createdAt.toISOString(),
        })
        warnings.push({
          kind: "compile_failed",
          subkind: "compile_failed",
          message: `LLM 编译失败，已退回原始 sanitize 预览：${err instanceof Error ? err.message : String(err)}`,
        })
      }
    } else {
      // 无 compile deps（standalone 测试 / 未接 LLM）→ stub 预览（向后兼容）。
      llmCompiledPreview = buildLlmStubPreview({
        sourcePath: body.sourcePath,
        sanitizedContent: sanitized.sanitizedText,
        mimeType: body.mimeType,
        targetType: body.targetType,
        generatedAt: createdAt.toISOString(),
      })
    }

    // Day 9-10 (AC-P3-10)：store 注入时 put entry 供 commit endpoint 凭 previewId 取
    // F027 P4 Day 10 AC-P4-3 e: 透传 seriesId 给 store，commit 时 inject 到 frontmatter
    // F027 v3 G11: compiledMarkdown（编译成功才有）存 store → commit 落盘写编译产物。
    if (this.store) {
      this.store.put({
        previewId,
        sourcePath: body.sourcePath,
        sanitizedContent: sanitized.sanitizedText,
        mimeType: body.mimeType,
        targetType: body.targetType,
        seriesId: body.seriesId,
        createdAt: createdAt.toISOString(),
        expiresAt,
        compiledMarkdown,
      })
    }

    return {
      previewId,
      sanitizedContent: sanitized.sanitizedText,
      llmCompiledPreview,
      warnings,
      expiresAt,
    }
  }

  /** F027 v3 G11 · 跑 LLM compile pipeline（preview 路径，用 no-op WikiEventsWriter）。 */
  private async runCompile(
    body: PreviewIngestBody,
    sanitized: SanitizeResult,
    previewId: string,
    createdAt: Date,
    opts: PreviewInternalOpts,
  ): Promise<DraftResult> {
    const compile = this.compile
    if (!compile) throw new Error("runCompile called without compile deps")

    const title = extractTitle(sanitized.sanitizedText) ?? deriveTitleFromPath(body.sourcePath)
    const quotedSpans = sanitized.quarantinedSegments.map((s) => s.original)

    // codex P2-3(G11)：provenance 决定 tainted_source / contributed_by。
    // user-drop（默认，HTTP route）= 外部投喂，tainted=true；docs-watcher = 项目内文档，tainted=false。
    const provenance = opts.provenance ?? "user-drop"
    const fromUserDrop = provenance === "user-drop"
    const contributedBy = provenance

    return runCompilePipelineWithRetry(
      {
        rawContent: sanitized.sanitizedText,
        rawMetadata: {
          ingestMessageId: previewId,
          fromUserDrop,
          date: formatDate(createdAt),
          seriesId: body.seriesId ?? null,
        },
        agentDraft: {
          title,
          ...(body.targetType
            ? { type_candidate: mapTargetTypeToCandidate(body.targetType) }
            : {}),
          sources: [{ type: body.mimeType, path: body.sourcePath, contributed_by: contributedBy }],
        },
        handbookCompileRules: compile.handbookCompileRules,
        quotedSpans,
        deps: {
          embedding: compile.embedding,
          indexLoader: compile.indexLoader,
          llmClient: compile.llmClient,
          entityChecker: compile.entityChecker,
          wikiEvents: this.previewWikiEvents,
        },
      },
      { maxAttempts: compile.maxAttempts ?? 3, logger: compile.logger },
    )
  }
}

/**
 * 把 SanitizeResult 的 redLineTriggers + quarantinedSegments 映射到 contract.warnings。
 *
 * 范-r1 P2-3：subkind 字段透传 sanitize 内部 reason，前端 UI 按 subkind 渲染不同 icon /
 * 区分 jailbreak vs HTML vs URL scheme，不再 parse message 字符串。
 */
function mapWarnings(result: SanitizeResult): PreviewWarning[] {
  const out: PreviewWarning[] = []
  for (const trig of result.redLineTriggers) {
    out.push({
      kind: redLineToWarningKind(trig),
      subkind: trig.reason,
      message: redLineMessage(trig),
    })
  }
  for (const seg of result.quarantinedSegments) {
    out.push({
      kind: quarantineToWarningKind(seg),
      subkind: seg.reason,
      message: quarantineMessage(seg),
    })
  }
  return out
}

function redLineToWarningKind(trig: RedLineTrigger): PreviewWarning["kind"] {
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

function quarantineToWarningKind(seg: QuarantinedSegment): PreviewWarning["kind"] {
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

/** F027 v3 G11 · Date → YYYY-MM-DD（compile pipeline rawMetadata.date / draftPath 用）。 */
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * F027 v3 G11 · DraftType（feature/bug/lesson/concept）→ compile type_candidate
 * （concept/rule/method/lesson/external-ref）。仅候选，Phase 2 LLM 最终拍 type。
 */
function mapTargetTypeToCandidate(
  t: DraftType,
): "concept" | "rule" | "method" | "lesson" | "external-ref" {
  switch (t) {
    case "lesson":
      return "lesson"
    case "concept":
      return "concept"
    // feature / bug 无对应 compile type → 候选 concept（LLM 可改）
    default:
      return "concept"
  }
}

/**
 * F027 v3 G11 · DraftResult → 完整 markdown（frontmatter + body）。
 * frontmatter 用 yaml.stringify 序列化完整 CompiledFrontmatter（含 cross_refs / dedup /
 * facts 等嵌套结构）；body = 标题 + summary + facts 列表（人读 + 落盘内容）。
 */
function renderCompiledDraft(draft: DraftResult): string {
  const fm = draft.frontmatter
  const factsBody = fm.facts.map((f) => `- ${f.text}`).join("\n")
  const body = `# ${fm.title}\n\n${fm.summary}\n\n## Facts\n\n${factsBody}\n`
  return `---\n${stringifyYaml(fm)}---\n${body}`
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
      return await service.preview(validation.value)
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
