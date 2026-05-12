/**
 * F027 P4.6 · LLM 编译 3 阶段 单测
 * 真相源：docs/plans/V16.5-final.md chap 26 行 2684-2976
 * AC：AC-P1-3 —— LLM 编译 3 阶段端到端 PASS
 * Fixtures：tests/fixtures/wiki-ingest/rag-tutorial-input.md + rag-tutorial-expected.json
 *
 * 覆盖：
 *   - Phase 1 pre-compile: top-k 截断 + score_floor 过滤 + indexLite 透传 + embedding 缺失降级
 *   - Phase 2 prompt builder: handbook 切片 + context 段 + task 段拼装顺序
 *   - Phase 2 schema validator: 5 relation / 3 verdict / 4 owner / 5 type 枚举 + parse fence
 *   - Phase 3 post-compile: 死链过滤 + frontmatter 19 字段三段 + dedup 边角字段 + rules/ user-review
 *   - 端到端 pipeline: RAG fixture mock-LLM → DraftResult 全字段对账
 *   - retry: schema fail 重试 N 次熔断
 */

import fs from "node:fs"
import path from "node:path"
import assert from "node:assert/strict"
import test from "node:test"
import {
  buildCompileLLMSystemPrompt,
  computeContentHash,
  derivePromoteTarget,
  formatPreCompileContext,
  parseLLMCompileJSON,
  postCompile,
  preCompile,
  runCompilePipeline,
  runCompilePipelineWithRetry,
  slugifyTitle,
  validateLLMCompileOutput,
} from "./compile-pipeline"
import {
  type AgentDraftFrontmatter,
  type CompileLLMClient,
  CompilePipelineError,
  type EntityExistenceChecker,
  type IndexLiteLoader,
  type LLMCompileOutput,
  LLMCompileSchemaError,
  type PreCompileContext,
  type RawMetadata,
  type WikiEventsWriter,
} from "./types"

const REPO_ROOT = path.resolve(__dirname, "../../../../..")
const FIXTURE_DIR = path.join(REPO_ROOT, "tests/fixtures/wiki-ingest")

// ─── helpers ───────────────────────────────────────────────────────────

function loadExpectedLLMOutput(): LLMCompileOutput {
  const raw = JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, "rag-tutorial-expected.json"), "utf-8"),
  )
  // 剥 _comment（fixture 注释字段，不在 schema 内）
  const { _comment, ...rest } = raw
  void _comment
  return validateLLMCompileOutput(rest)
}

function loadRagTutorialInput(): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, "rag-tutorial-input.md"), "utf-8")
}

function makeMockEmbedding(opts: {
  generateReturn?: number[] | null
  searchReturn?: Array<{ messageId: string; chunkText: string; score: number }>
} = {}): Pick<
  import("../../services/embedding-service").EmbeddingService,
  "generateEmbedding" | "searchByVector"
> {
  return {
    generateEmbedding: async () => opts.generateReturn ?? [0.1, 0.2, 0.3, 0.4],
    searchByVector: () => opts.searchReturn ?? [],
  }
}

function makeIndexLoader(): IndexLiteLoader {
  return {
    load: async () => ({
      concepts: [
        { name: "F018-context-resume-rebuild", summary: "F018 SessionBootstrap 续接机制" },
        { name: "B022-prompt-injection", summary: "B022 多源冗余 fail-closed 修复" },
      ],
      rules: [
        { name: "iron-laws", summary: "4 条铁律" },
        { name: "cross-agent-discipline", summary: "协作纪律" },
      ],
      methods: [],
    }),
  }
}

function makeMockLLMClient(returnValue: LLMCompileOutput): CompileLLMClient {
  return {
    compile: async () => returnValue,
  }
}

function makeMockEntityChecker(existing: Set<string>): EntityExistenceChecker {
  return {
    exists: async (name) => existing.has(name),
  }
}

function makeMockWikiEvents(): { writer: WikiEventsWriter; calls: any[] } {
  const calls: any[] = []
  return {
    writer: {
      append: async (input) => {
        calls.push(input)
        return { eventId: `evt-${calls.length}` }
      },
    },
    calls,
  }
}

// ─── Phase 1: pre-compile ──────────────────────────────────────────────

test("preCompile: embedding 缺失 → similarEntities=[]，indexLite 仍 load", async () => {
  const ctx = await preCompile(
    "raw content",
    {
      ingestMessageId: "msg-1",
      fromUserDrop: true,
      date: "2026-05-12",
    },
    {
      embedding: makeMockEmbedding({ generateReturn: null }),
      indexLoader: makeIndexLoader(),
    },
  )
  assert.equal(ctx.similarEntities.length, 0)
  assert.equal(ctx.indexLite.concepts.length, 2)
  assert.equal(ctx.indexLite.rules.length, 2)
  assert.equal(ctx.totalContextTokens, 1500)
})

test("preCompile: top-k 截断 + score_floor 过滤", async () => {
  const ctx = await preCompile(
    "raw",
    { ingestMessageId: "msg-1", fromUserDrop: true, date: "2026-05-12" },
    {
      embedding: makeMockEmbedding({
        searchReturn: [
          { messageId: "F018", chunkText: "F018 summary", score: 0.78 },
          { messageId: "B022", chunkText: "B022 summary", score: 0.65 },
          { messageId: "Microcompact", chunkText: "Microcompact summary", score: 0.52 },
          { messageId: "L0-DIGEST", chunkText: "L0 summary", score: 0.48 },
          { messageId: "SessionBootstrap", chunkText: "SB summary", score: 0.45 },
          { messageId: "old-junk", chunkText: "old", score: 0.3 }, // < 0.4 floor
          { messageId: "extra-1", chunkText: "extra", score: 0.42 }, // 进 floor 但 top-5 截
        ],
      }),
      indexLoader: makeIndexLoader(),
    },
    { threadIds: ["wiki-pool"], topK: 5, scoreFloor: 0.4 },
  )
  // 应该有 5 个（top-k=5，过滤后剩 6 个 > floor，截 top-5 by score）
  assert.equal(ctx.similarEntities.length, 5)
  assert.equal(ctx.similarEntities[0].path, "F018")
  assert.equal(ctx.similarEntities[0].score, 0.78)
  // old-junk (0.3 < 0.4) 被过滤
  assert.ok(!ctx.similarEntities.some((e) => e.path === "old-junk"))
})

test("preCompile: entityMetadataLookup 把 messageId 映射到 path/title/summary", async () => {
  const ctx = await preCompile(
    "raw",
    { ingestMessageId: "msg-1", fromUserDrop: true, date: "2026-05-12" },
    {
      embedding: makeMockEmbedding({
        searchReturn: [{ messageId: "key-1", chunkText: "fallback chunk", score: 0.7 }],
      }),
      indexLoader: makeIndexLoader(),
    },
    {
      threadIds: ["wiki-pool"],
      entityMetadataLookup: async (key) => {
        if (key === "key-1") {
          return { path: "F018-context-resume-rebuild", title: "F018", summary: "F018 摘要" }
        }
        return null
      },
    },
  )
  assert.equal(ctx.similarEntities[0].path, "F018-context-resume-rebuild")
  assert.equal(ctx.similarEntities[0].title, "F018")
  assert.equal(ctx.similarEntities[0].summary, "F018 摘要")
})

// ─── Phase 2: compile-prompt ──────────────────────────────────────────

test("formatPreCompileContext: similarEntities + rules + concepts 三段拼装", () => {
  const ctx: PreCompileContext = {
    similarEntities: [
      { path: "F018", title: "F018", summary: "F018 是 F007 的架构级收尾", score: 0.78 },
      { path: "B022", title: "B022", summary: "B022 多源冗余 fail-closed", score: 0.65 },
    ],
    indexLite: {
      concepts: [{ name: "Microcompact", summary: "F007 上下文压缩" }],
      rules: [{ name: "iron-laws", summary: "4 条铁律" }],
    },
    totalContextTokens: 1500,
  }
  const text = formatPreCompileContext(ctx)
  assert.match(text, /\[\[F018\]\] \(sim 0\.78\)/)
  assert.match(text, /\[\[B022\]\] \(sim 0\.65\)/)
  assert.match(text, /\[\[iron-laws\]\]/)
  assert.match(text, /\[\[Microcompact\]\]/)
})

test("buildCompileLLMSystemPrompt: handbook + context + task 三段顺序固定", () => {
  const prompt = buildCompileLLMSystemPrompt({
    context: {
      similarEntities: [],
      indexLite: { concepts: [], rules: [] },
      totalContextTokens: 1500,
    },
    handbookCompileRules: "[[handbook compile rules]]",
  })
  // handbook 在最前
  const handbookIdx = prompt.indexOf("[[handbook compile rules]]")
  const contextIdx = prompt.indexOf("【参考上下文")
  const taskIdx = prompt.indexOf("【任务】")
  assert.ok(handbookIdx < contextIdx, `handbook 应在 context 前 (${handbookIdx} < ${contextIdx})`)
  assert.ok(contextIdx < taskIdx, "context 应在 task 前")
  // task 段含 schema
  assert.match(prompt, /"cross_refs"/)
  assert.match(prompt, /extends.*supersedes.*references.*contradicts.*implements/)
})

// ─── Phase 2: schema-validator ─────────────────────────────────────────

test("parseLLMCompileJSON: 直接 JSON parse", () => {
  const v = parseLLMCompileJSON('{"a":1}')
  assert.deepEqual(v, { a: 1 })
})

test("parseLLMCompileJSON: 剥 ```json fence", () => {
  const v = parseLLMCompileJSON('```json\n{"a":1}\n```')
  assert.deepEqual(v, { a: 1 })
})

test("parseLLMCompileJSON: invalid → LLMCompileSchemaError", () => {
  assert.throws(
    () => parseLLMCompileJSON("{not json}"),
    (err) => err instanceof LLMCompileSchemaError && err.invalidField === "<root>",
  )
})

test("validateLLMCompileOutput: fixture rag-tutorial-expected.json 通过", () => {
  const valid = loadExpectedLLMOutput()
  assert.equal(valid.title, "RAG (Retrieval-Augmented Generation) 入门")
  assert.equal(valid.type, "concept")
  assert.equal(valid.cross_refs.length, 2)
  assert.equal(valid.dedup_decision.verdict, "new_entity")
})

test("validateLLMCompileOutput: invalid relation → 抛错", () => {
  const expected = loadExpectedLLMOutput()
  const invalid = {
    ...expected,
    cross_refs: [{ target: "X", relation: "weird-rel", rationale: "x" }],
  }
  assert.throws(
    () => validateLLMCompileOutput(invalid),
    (err) =>
      err instanceof LLMCompileSchemaError &&
      err.invalidField === "relation" &&
      /weird-rel/.test(err.message),
  )
})

test("validateLLMCompileOutput: invalid verdict → 抛错", () => {
  const expected = loadExpectedLLMOutput()
  const invalid = {
    ...expected,
    dedup_decision: { verdict: "weird", target_entity: null, rationale: "x" },
  }
  assert.throws(
    () => validateLLMCompileOutput(invalid),
    (err) =>
      err instanceof LLMCompileSchemaError &&
      err.invalidField === "verdict" &&
      /weird/.test(err.message),
  )
})

test("validateLLMCompileOutput: merge_into 无 target_entity → 抛错", () => {
  const expected = loadExpectedLLMOutput()
  const invalid = {
    ...expected,
    dedup_decision: { verdict: "merge_into", target_entity: null, rationale: "x" },
  }
  assert.throws(
    () => validateLLMCompileOutput(invalid),
    (err) =>
      err instanceof LLMCompileSchemaError &&
      err.invalidField === "dedup_decision.target_entity",
  )
})

test("validateLLMCompileOutput: invalid canonical_owner_suggestion → 抛错", () => {
  const expected = loadExpectedLLMOutput()
  const invalid = { ...expected, canonical_owner_suggestion: "wiki/random/" }
  assert.throws(
    () => validateLLMCompileOutput(invalid),
    (err) =>
      err instanceof LLMCompileSchemaError &&
      err.invalidField === "canonical_owner_suggestion",
  )
})

test("validateLLMCompileOutput: completeness 越界 → 抛错", () => {
  const expected = loadExpectedLLMOutput()
  const invalid = {
    ...expected,
    draft_quality: { ...expected.draft_quality, completeness: 1.5 },
  }
  assert.throws(
    () => validateLLMCompileOutput(invalid),
    (err) =>
      err instanceof LLMCompileSchemaError &&
      err.invalidField === "draft_quality.completeness",
  )
})

// ─── Phase 3: post-compile ─────────────────────────────────────────────

test("postCompile: cross_refs 死链过滤", async () => {
  const llm = loadExpectedLLMOutput()
  const checker = makeMockEntityChecker(new Set(["F018-context-resume-rebuild"]))
  // B022 不在 set → 算死链
  const wiki = makeMockWikiEvents()
  const result = await postCompile(
    llm,
    { ingestMessageId: "msg-1", fromUserDrop: true, date: "2026-05-12" },
    { title: "RAG", sources: [{ type: "user-drop", contributed_by: "小孙" }] },
    { entityChecker: checker, wikiEvents: wiki.writer },
  )
  assert.equal(result.deadRefs.length, 1)
  assert.equal(result.deadRefs[0].ref.target, "B022-prompt-injection")
  assert.equal(result.frontmatter.cross_refs.length, 1)
  assert.equal(result.frontmatter.cross_refs[0].target, "F018-context-resume-rebuild")
})

test("postCompile: 19 字段三段 fill (agent 3 + LLM 13 + post derive 3)", async () => {
  const llm = loadExpectedLLMOutput()
  const checker = makeMockEntityChecker(
    new Set(["F018-context-resume-rebuild", "B022-prompt-injection"]),
  )
  const wiki = makeMockWikiEvents()
  const agentDraft: AgentDraftFrontmatter = {
    title: "RAG (Retrieval-Augmented Generation) 入门",
    sources: [
      {
        type: "user-drop",
        path: "wiki/raw/user-drops/2026-05-12-rag-tutorial.md",
        contributed_by: "小孙",
      },
    ],
  }
  const result = await postCompile(
    llm,
    {
      ingestMessageId: "msg-rag-1",
      userReason: "看到这篇 RAG paper，跟 F018 思路类似",
      fromUserDrop: true,
      date: "2026-05-12",
      seriesId: null,
    },
    agentDraft,
    { entityChecker: checker, wikiEvents: wiki.writer },
  )

  // A. agent 3
  assert.equal(result.frontmatter.title, agentDraft.title)
  assert.equal(result.frontmatter.type, "concept")
  assert.equal(result.frontmatter.sources, agentDraft.sources)

  // B. LLM 输出主体（验代表字段）
  assert.equal(result.frontmatter.summary, llm.summary)
  assert.equal(result.frontmatter.facts.length, llm.facts.length)
  assert.equal(result.frontmatter.cross_refs.length, 2)
  assert.equal(result.frontmatter.dedup_decision.verdict, "new_entity")
  assert.equal(result.frontmatter.draft_quality.completeness, 0.85)
  assert.equal(result.frontmatter.canonical_owner_suggestion, "wiki/concepts/")

  // C. post derive 3
  assert.equal(
    result.frontmatter.canonical_owner_path,
    "wiki/concepts/draft/2026-05-12-rag-retrieval-augmented-generation-入门.md",
  )
  assert.equal(
    result.frontmatter.proposed_promote_to,
    "wiki/concepts/rag-retrieval-augmented-generation-入门.md",
  )
  assert.equal(result.frontmatter.tainted_source, true)
  assert.equal(result.frontmatter.ingest_metadata.ingest_event_id, "msg-rag-1")
  assert.equal(result.frontmatter.ingest_metadata.user_reason, "看到这篇 RAG paper，跟 F018 思路类似")
  assert.equal(result.frontmatter.ingest_metadata.series_id, null)

  // wiki_events 写入
  assert.equal(wiki.calls.length, 1)
  assert.equal(wiki.calls[0].action, "ingest")
  assert.equal(wiki.calls[0].path, result.draftPath)
  assert.equal(wiki.calls[0].sourceMessageIds[0], "msg-rag-1")
  assert.match(wiki.calls[0].contentHash, /^[a-f0-9]{16}$/)
})

test("postCompile: dedup verdict=merge_into → 写 merge_target", async () => {
  const llm = loadExpectedLLMOutput()
  llm.dedup_decision = {
    verdict: "merge_into",
    target_entity: "F018-context-resume-rebuild",
    rationale: "本质同概念",
  }
  const checker = makeMockEntityChecker(
    new Set(["F018-context-resume-rebuild", "B022-prompt-injection"]),
  )
  const wiki = makeMockWikiEvents()
  const result = await postCompile(
    llm,
    { ingestMessageId: "msg-1", fromUserDrop: true, date: "2026-05-12" },
    { title: "x", sources: [{ type: "x", contributed_by: "x" }] },
    { entityChecker: checker, wikiEvents: wiki.writer },
  )
  assert.equal(result.frontmatter.merge_target, "F018-context-resume-rebuild")
  assert.equal(result.frontmatter.supersedes, undefined)
})

test("postCompile: dedup verdict=supersedes → 写 supersedes 数组", async () => {
  const llm = loadExpectedLLMOutput()
  llm.dedup_decision = {
    verdict: "supersedes",
    target_entity: "old-rag-entity",
    rationale: "替代旧版",
  }
  const checker = makeMockEntityChecker(new Set([]))
  const wiki = makeMockWikiEvents()
  const result = await postCompile(
    llm,
    { ingestMessageId: "msg-1", fromUserDrop: true, date: "2026-05-12" },
    { title: "x", sources: [{ type: "x", contributed_by: "x" }] },
    { entityChecker: checker, wikiEvents: wiki.writer },
  )
  assert.deepEqual(result.frontmatter.supersedes, ["old-rag-entity"])
  assert.equal(result.frontmatter.merge_target, undefined)
})

test("postCompile: canonical_owner_suggestion=wiki/rules/ → requires_user_review=true", async () => {
  const llm = loadExpectedLLMOutput()
  llm.canonical_owner_suggestion = "wiki/rules/"
  const checker = makeMockEntityChecker(new Set([]))
  const wiki = makeMockWikiEvents()
  const result = await postCompile(
    llm,
    { ingestMessageId: "msg-1", fromUserDrop: true, date: "2026-05-12" },
    { title: "x", sources: [{ type: "x", contributed_by: "x" }] },
    { entityChecker: checker, wikiEvents: wiki.writer },
  )
  assert.equal(result.frontmatter.requires_user_review, true)
  assert.equal(result.frontmatter.suggested_promote_to, "wiki/rules/")
})

test("derivePromoteTarget: 拼装目录前缀 + slug + .md", () => {
  assert.equal(
    derivePromoteTarget("wiki/concepts/", "rag-tutorial"),
    "wiki/concepts/rag-tutorial.md",
  )
  assert.equal(
    derivePromoteTarget("wiki/rules/", "iron-laws"),
    "wiki/rules/iron-laws.md",
  )
})

test("slugifyTitle: 中文 + 标点 + 空格 → kebab", () => {
  assert.equal(slugifyTitle("RAG (Retrieval-Augmented Generation) 入门"), "rag-retrieval-augmented-generation-入门")
  assert.equal(slugifyTitle("@@@ 全是标点 @@@"), "全是标点")
  assert.equal(slugifyTitle(""), "untitled")
})

test("computeContentHash: 稳定 hash（key 顺序不影响）", () => {
  const llm1 = loadExpectedLLMOutput()
  const llm2 = JSON.parse(JSON.stringify(llm1))
  // 重排 key（在 JSON.stringify 时 key 顺序变化）
  const reordered = Object.fromEntries(Object.entries(llm2).reverse()) as unknown as LLMCompileOutput
  assert.equal(computeContentHash(llm1), computeContentHash(reordered))
})

// ─── 端到端 pipeline ──────────────────────────────────────────────────

test("runCompilePipeline: RAG fixture 端到端 mock-LLM → DraftResult", async () => {
  const expected = loadExpectedLLMOutput()
  const result = await runCompilePipeline({
    rawContent: loadRagTutorialInput(),
    rawMetadata: {
      ingestMessageId: "msg-rag-1",
      userReason: "看到这篇 RAG paper",
      fromUserDrop: true,
      date: "2026-05-12",
      seriesId: null,
    },
    agentDraft: {
      title: expected.title,
      sources: [{ type: "user-drop", contributed_by: "小孙" }],
    },
    handbookCompileRules: "## 编译规则\n[handbook compile rules content here]",
    deps: {
      embedding: makeMockEmbedding(),
      indexLoader: makeIndexLoader(),
      llmClient: makeMockLLMClient(expected),
      entityChecker: makeMockEntityChecker(
        new Set(["F018-context-resume-rebuild", "B022-prompt-injection"]),
      ),
      wikiEvents: makeMockWikiEvents().writer,
    },
  })
  // 完整 frontmatter 19 字段都要 fill
  assert.equal(result.frontmatter.type, "concept")
  assert.equal(result.frontmatter.cross_refs.length, 2) // 都活
  assert.equal(result.deadRefs.length, 0)
  assert.equal(result.dedupDecision.verdict, "new_entity")
  assert.match(result.draftPath, /^wiki\/concepts\/draft\/2026-05-12-/)
})

test("runCompilePipelineWithRetry: schema 失败 N 次 → 抛 CompilePipelineError", async () => {
  let attempts = 0
  const failingClient: CompileLLMClient = {
    compile: async () => {
      attempts++
      throw new LLMCompileSchemaError("title", "missing")
    },
  }
  await assert.rejects(
    runCompilePipelineWithRetry(
      {
        rawContent: "x",
        rawMetadata: { ingestMessageId: "m", fromUserDrop: true, date: "2026-05-12" },
        agentDraft: { title: "x", sources: [{ type: "x", contributed_by: "x" }] },
        handbookCompileRules: "rules",
        deps: {
          embedding: makeMockEmbedding(),
          indexLoader: makeIndexLoader(),
          llmClient: failingClient,
          entityChecker: makeMockEntityChecker(new Set()),
          wikiEvents: makeMockWikiEvents().writer,
        },
      },
      { maxAttempts: 2 },
    ),
    (err) =>
      err instanceof CompilePipelineError &&
      err.stage === "compile" &&
      /2 times/.test(err.message),
  )
  assert.equal(attempts, 2)
})

test("runCompilePipelineWithRetry: 第 2 次成功不熔断", async () => {
  const expected = loadExpectedLLMOutput()
  let attempts = 0
  const flakyClient: CompileLLMClient = {
    compile: async () => {
      attempts++
      if (attempts === 1) throw new LLMCompileSchemaError("title", "first try fail")
      return expected
    },
  }
  const result = await runCompilePipelineWithRetry(
    {
      rawContent: "x",
      rawMetadata: { ingestMessageId: "m", fromUserDrop: true, date: "2026-05-12" },
      agentDraft: { title: "x", sources: [{ type: "x", contributed_by: "x" }] },
      handbookCompileRules: "rules",
      deps: {
        embedding: makeMockEmbedding(),
        indexLoader: makeIndexLoader(),
        llmClient: flakyClient,
        entityChecker: makeMockEntityChecker(
          new Set(["F018-context-resume-rebuild", "B022-prompt-injection"]),
        ),
        wikiEvents: makeMockWikiEvents().writer,
      },
    },
    { maxAttempts: 3 },
  )
  assert.equal(attempts, 2)
  assert.equal(result.dedupDecision.verdict, "new_entity")
})
