// B019 Phase 4 — 端到端 AC 验收脚本
//
// 不起完整 API（避免 schema/auth/MCP 重 boot）。直接走 EmbeddingService 生产路径：
//   1. SqliteStore 临时库（不动主库 — 铁律：禁止改/删持久化数据）
//   2. EmbeddingService 默认 pipelineLoader（走 B019 P2 离线优先实现）
//   3. generateAndStore 写 embedding（与 message-service.ts:1199 同 API）
//   4. searchSimilarFromDb 召回（与 server.ts:414 callback 同 API）
//   5. 断言：表行数 ≥ N，hits.length ≥ 1，score ∈ (0,1]
//
// 跑：`pnpm tsx scripts/B019-verify.ts`

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SqliteStore } from "../packages/api/src/db/sqlite"
import { EmbeddingService } from "../packages/api/src/services/embedding-service"

const SAMPLES = [
  { id: "msg-1", text: "the cat sat on the mat" },
  { id: "msg-2", text: "I love TypeScript and functional programming" },
  { id: "msg-3", text: "a feline rested on a soft rug" },
  { id: "msg-4", text: "quantum chromodynamics in particle physics" },
  { id: "msg-5", text: "我的代码 review 结果显示有 3 个 bug" },
]

const QUERY = "kittens and cats"
const THREAD_ID = "thread-b019-verify"

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), "b019-verify-"))
  const dbPath = path.join(dir, "verify.db")
  console.log(`[B019-verify] tmp db: ${dbPath}`)

  const warns: Array<{ obj: unknown; msg?: string }> = []
  const store = new SqliteStore(dbPath)
  const svc = new EmbeddingService({
    store,
    logger: { warn: (obj, msg) => warns.push({ obj, msg }) },
  })

  // Step 1: ensureModel — 离线加载本地权重
  console.log("[B019-verify] step 1: ensureModel ...")
  const t0 = Date.now()
  const ok = await svc.ensureModel()
  console.log(`  → ${ok ? "OK" : "FAIL"} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  if (!ok) {
    console.error("  warns:", warns)
    throw new Error("ensureModel failed — offline weights not loadable")
  }

  // Step 2: generateAndStore — 走生产 hook 同 API
  console.log("[B019-verify] step 2: generateAndStore × 5 ...")
  for (const s of SAMPLES) {
    await svc.generateAndStore(s.id, THREAD_ID, s.text)
    process.stdout.write(".")
  }
  console.log()

  // Step 3: 查表行数
  const rowCount = (
    store.db.prepare("SELECT COUNT(*) as n FROM message_embeddings").get() as { n: number }
  ).n
  console.log(`[B019-verify] step 3: row count = ${rowCount}`)
  if (rowCount !== SAMPLES.length) {
    throw new Error(`expected ${SAMPLES.length} rows, got ${rowCount}`)
  }

  // Step 4: searchSimilarFromDb — 走 callback 同 API
  console.log(`[B019-verify] step 4: searchSimilarFromDb("${QUERY}") ...`)
  const hits = await svc.searchSimilarFromDb(QUERY, [THREAD_ID], 3, new Set())
  console.log(`  → ${hits.length} hits`)
  if (hits.length === 0) {
    throw new Error("recall returned 0 hits — semantic match broken")
  }
  for (const h of hits) {
    console.log(
      `    score=${h.score.toFixed(4)} msg=${h.messageId} text="${h.chunkText.slice(0, 50)}..."`,
    )
    if (h.score <= 0 || h.score > 1) {
      throw new Error(`score ${h.score} out of (0, 1] for ${h.messageId}`)
    }
  }

  // Step 5: 语义合理性 — query 'kittens and cats' 应该召回 cat/feline 优先
  const top = hits[0]
  if (!/cat|feline/i.test(top.chunkText)) {
    throw new Error(
      `top hit "${top.chunkText}" should match cat/feline for query "${QUERY}"`,
    )
  }

  // Step 6: warn 计数 — 应该 0 个 model-not-ready
  const modelNotReadyWarns = warns.filter(
    (w) => typeof w.obj === "object" && w.obj !== null && "reason" in w.obj && (w.obj as { reason: string }).reason === "model-not-ready",
  )
  console.log(`[B019-verify] step 6: model-not-ready warns = ${modelNotReadyWarns.length}`)
  if (modelNotReadyWarns.length > 0) {
    throw new Error(`expected 0 model-not-ready warns, got ${modelNotReadyWarns.length}`)
  }

  console.log("\n✅ B019 AC PASS")
  console.log("  - ensureModel 离线加载本地权重 ✓")
  console.log("  - generateAndStore 写入 5/5 ✓")
  console.log(`  - row count = ${rowCount} (匹配 SAMPLES.length) ✓`)
  console.log(`  - searchSimilarFromDb 召回 ${hits.length} hits, top=${top.messageId} ✓`)
  console.log("  - top hit 语义匹配 cat/feline ✓")
  console.log("  - 0 个 model-not-ready warn ✓")

  // 清理临时库（不动主库）— Windows 上 ONNX runtime 可能仍持文件锁，
  // best-effort 即可，不让 cleanup 失败否定 AC PASS。
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    console.warn(`[B019-verify] cleanup skipped (file lock): ${(err as Error).message}`)
  }
}

main().catch((err) => {
  console.error("\n❌ B019 AC FAIL:", err.message)
  process.exit(1)
})
