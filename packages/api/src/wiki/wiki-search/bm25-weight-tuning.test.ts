/**
 * F027 P11.b prep · BM25 nameWeight 调参 benchmark（范-P15 P3 follow-up）
 *
 * 范的建议：P11.b 接 hybrid 前用真实/近真实 fixture 跑 3x/5x/10x nameWeight 曲线选最终
 * 默认，否则 recall threshold 调参会把权重经验值一起吞掉。
 *
 * Fixture（11 entities：5 期望命中 + 3 业务干扰 + 3 stress 干扰）：
 *   - 期望命中：F011 / F021 / F018 / B022 / F004（design/bug 文档，name 含 entity ID）
 *   - 业务干扰：F019 / F022 / B019（真实 wiki entity，可能 noise 但非 dominant）
 *   - stress 干扰：db-driver-overview / security-fundamentals / agent-runtime-overview
 *     （name 完全不沾 query keyword，body 多次重复 query 词，专测 weight 真力）
 *
 * Query 集（7 个，混合 name-hit / body-only / 多 entity body 都含的边界 case）：
 *   - "drizzle migration"（F011，B019 body 也含）
 *   - "context window resolver"（F021）
 *   - "prompt injection"（B022，F004 body 含 injection 干扰）
 *   - "backend hardening"（F011）
 *   - "session bootstrap"（F018）
 *   - "TOCTOU 防御"（F011，body-only 命中）
 *   - "rolling summary"（F018，多 entity body 都含）
 *
 * Metric：
 *   - MRR (Mean Reciprocal Rank): 1/rank of expected entity, averaged across queries
 *   - Top-3 hit rate: expected entity 是否在 top-3
 *   - 排序合理性：F011/F021/B022 query 时对应 entity 排首位
 *
 * 输出：stderr 写 markdown 报告（caller 跑后 grep "[bm25-tuning]" 看）
 *
 * 本测试不强制具体 weight 选择 — 只跑 benchmark + 输出。决策由小孙根据报告拍板。
 */

import { promises as fsAsync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { drizzle as drizzleBetter } from "drizzle-orm/better-sqlite3"
import { createDrizzleDb } from "../../db/drizzle-instance"
import * as schema from "../../db/schema"
import { WikiEntityFtsProvider } from "./wiki-entity-fts-provider"
import { reindexWikiEntities } from "./wiki-entity-indexer"

interface FixtureEntity {
  /** 不含 wiki/ 前缀的相对路径 */
  relPath: string
  body: string
}

interface QueryCase {
  query: string
  /** 期望 top-1 命中的 entity 文件名（不含目录前缀，含 .md） */
  expectedTop: string
  /** 期望进 top-3 的全部 entities（含 expectedTop） */
  expectedInTop3: string[]
}

const FIXTURE: FixtureEntity[] = [
  {
    relPath: "concepts/F011-backend-hardening-drizzle.md",
    body: "F011 drizzle 优化 backend hardening. drizzle migration safety + backfill 安全策略, 把 SELECT max + INSERT 包在 db.transaction 防 TOCTOU. BEGIN IMMEDIATE 锁串行写. drizzle better-sqlite3 driver wrapper.immediate. 优化 query 改 prepared statement 防 sql injection 同时减 plan parse 开销。",
  },
  {
    relPath: "concepts/F021-context-window-resolver.md",
    body: "F021 上下文窗口 / Seal 阈值齿轮可配 + fillRatio 实时观测 + seal 感知. context window resolver 动态调整 prompt token 预算. seal 阈值由 config 控制 + 实时 metrics 输出. 与 F018 ThreadMemory rolling summary 集成.",
  },
  {
    relPath: "concepts/F018-session-bootstrap.md",
    body: "F018 SessionBootstrap 续接逻辑. ThreadMemory rolling summary + 7 entries prelude. 新 session 注入 reference-only 上下文.",
  },
  {
    relPath: "bugReport/B022-prompt-injection-redundancy.md",
    body: "B022 prompt 注入四源冗余 + L0_DIGEST drift. fail-closed 防御.",
  },
  {
    relPath: "concepts/F004-prompt-assembly.md",
    body: "F004 assemblePrompt 统一注入合约. 5 reference-only section: viewfinder / recall-pack / handbook / collaboration-contract / capability-digest.",
  },
  // 干扰项（不应在大多数 query 命中 top-1，但可能 noise）
  {
    relPath: "concepts/F019-workflow-sop.md",
    body: "F019 WorkflowSop 告示牌引擎. backlog stage state machine kickoff impl quality_gate review merge completion.",
  },
  {
    relPath: "concepts/F022-room-namespace.md",
    body: "F022 R-XXX namespace 全局递增 ROOM ID. session_groups 加 room_id UNIQUE. backfillRoomIds 启动时回填历史 NULL.",
  },
  {
    relPath: "concepts/B019-vector-search-fix.md",
    body: "B019 vector search drizzle migration 修复. embedding service threadIds scope 由 sessionGroup 内所有 threads 聚合.",
  },
  // ── 真 stress 干扰：name 完全不沾 query keyword，但 body 多次重复 ──────
  // 这些是测 weight 真力的关键 fixture：name 5x 时不应让它们排过 expectedTop
  {
    relPath: "concepts/db-driver-overview.md",
    body: "drizzle is one of many ORM options. Other ORMs include Prisma, TypeORM. drizzle migration tooling is similar across them. drizzle drizzle drizzle 多次重复让 body BM25 拉高.",
  },
  {
    relPath: "concepts/security-fundamentals.md",
    body: "prompt injection is one attack class among many. Prompt injection in LLM systems exploits trust boundaries. defense against prompt injection requires sanitize layers. injection injection injection 多次重复.",
  },
  {
    relPath: "concepts/agent-runtime-overview.md",
    body: "session bootstrap session bootstrap session bootstrap 重复占位 body. 涉及 ThreadMemory rolling summary. context window estimation.",
  },
]

// 注（范-r1 P3 修）：query 是关键词 / 短语而非 wiki 路径搜。多数 query 仍会命中
// entity name 中的 token（如 "context window resolver" 对应 F021-context-window-resolver.md），
// nameWeight benchmark 本就需要测 name token 命中场景。weight 压力关键不是"name 不命中"，
// 而是 stress 干扰项（name 完全不沾 + body 多次重复同 keyword）能否被 name 命中文档压过。
const QUERIES: QueryCase[] = [
  // 1. F011 主要由 name 命中（"backend" / "hardening" 都在 name 里），body 含相同 keyword
  //    干扰：B019 body 也含 "drizzle migration"
  {
    query: "drizzle migration",
    expectedTop: "F011-backend-hardening-drizzle.md",
    expectedInTop3: ["F011-backend-hardening-drizzle.md", "B019-vector-search-fix.md"],
  },
  // 2. F021 主要由 name "context-window-resolver" 命中
  {
    query: "context window resolver",
    expectedTop: "F021-context-window-resolver.md",
    expectedInTop3: ["F021-context-window-resolver.md"],
  },
  // 3. B022 name "prompt-injection" 命中；F004 body 含 "injection" 干扰
  {
    query: "prompt injection",
    expectedTop: "B022-prompt-injection-redundancy.md",
    expectedInTop3: ["B022-prompt-injection-redundancy.md", "F004-prompt-assembly.md"],
  },
  // 4. F011 name "backend-hardening" 命中
  {
    query: "backend hardening",
    expectedTop: "F011-backend-hardening-drizzle.md",
    expectedInTop3: ["F011-backend-hardening-drizzle.md"],
  },
  // 5. F018 name "session-bootstrap" 命中
  {
    query: "session bootstrap",
    expectedTop: "F018-session-bootstrap.md",
    expectedInTop3: ["F018-session-bootstrap.md"],
  },
  // 6. 困难：query 是 body 关键词不在任何 name 里 — body BM25 该赢
  //    "TOCTOU" 只在 F011 body 里出现一次，weight 高 name 不该让别的胜出
  {
    query: "TOCTOU 防御",
    expectedTop: "F011-backend-hardening-drizzle.md",
    expectedInTop3: ["F011-backend-hardening-drizzle.md"],
  },
  // 7. 困难：query 在多个 entity body 里都有 — 高 name weight 会让有 keyword 在 name 的胜出
  //    "rolling summary" F018 body 含 + F021 body 提到 ThreadMemory rolling summary
  {
    query: "rolling summary",
    expectedTop: "F018-session-bootstrap.md",
    expectedInTop3: ["F018-session-bootstrap.md", "F021-context-window-resolver.md"],
  },
]

const WEIGHTS_TO_TEST = [1, 3, 5, 8, 10, 20]

describe("BM25 nameWeight 调参 benchmark (P11.b prep)", () => {
  it("跑 6 个 weight × 7 queries 输出 MRR + Top-3 hit rate 报告", async () => {
    const dbDir = mkdtempSync(path.join(tmpdir(), "bm25-tuning-db-"))
    const fsRoot = mkdtempSync(path.join(tmpdir(), "bm25-tuning-fs-"))
    const dbPath = path.join(dbDir, "test.sqlite")

    try {
      // Setup: 写 11 个 fixture entity 进 wiki/（5 期望命中 + 3 业务干扰 + 3 stress 干扰），reindex 进 wiki_entity_index
      for (const ent of FIXTURE) {
        const abs = path.join(fsRoot, "wiki", ent.relPath)
        await fsAsync.mkdir(path.dirname(abs), { recursive: true })
        await fsAsync.writeFile(abs, ent.body, "utf8")
      }
      const { raw, close } = createDrizzleDb(dbPath)
      const db = drizzleBetter(raw as never, { schema })
      await reindexWikiEntities({ wikiRoot: fsRoot, db })

      // 跑 benchmark 矩阵
      type WeightResult = {
        weight: number
        mrr: number
        top3HitRate: number
        topPositions: { query: string; expected: string; rank: number; topPath: string }[]
      }
      const results: WeightResult[] = []

      for (const w of WEIGHTS_TO_TEST) {
        const provider = new WikiEntityFtsProvider(db, { nameWeight: w, bodyWeight: 1 })
        const positions: WeightResult["topPositions"] = []
        let mrrSum = 0
        let top3HitCount = 0
        let totalChecks = 0

        for (const qc of QUERIES) {
          const hits = provider.queryFts(qc.query, { topK: 10 })

          // expectedTop rank
          const expectedRank = hits.findIndex((h) => h.path.endsWith(qc.expectedTop)) + 1 // 1-indexed; 0 = miss
          const reciprocalRank = expectedRank > 0 ? 1 / expectedRank : 0
          mrrSum += reciprocalRank

          positions.push({
            query: qc.query,
            expected: qc.expectedTop,
            rank: expectedRank,
            topPath: hits[0]?.path ?? "(no hit)",
          })

          // top-3 hit check（每个 expectedInTop3 entity 是否在 top-3 都算一次 check）
          const top3Paths = new Set(hits.slice(0, 3).map((h) => h.path))
          for (const expEnt of qc.expectedInTop3) {
            totalChecks++
            if ([...top3Paths].some((p) => p.endsWith(expEnt))) top3HitCount++
          }
        }

        results.push({
          weight: w,
          mrr: mrrSum / QUERIES.length,
          top3HitRate: top3HitCount / totalChecks,
          topPositions: positions,
        })
      }

      // 输出 markdown 报告到 stderr
      let report = "\n[bm25-tuning] ──────────────────────────────────────────────\n"
      report += "[bm25-tuning] BM25 nameWeight 调参报告（bodyWeight 固定 1.0）\n"
      report += `[bm25-tuning] Fixture: ${FIXTURE.length} wiki entities × ${QUERIES.length} queries\n`
      report += "[bm25-tuning] ──────────────────────────────────────────────\n"
      report += "[bm25-tuning] | nameWeight | MRR    | Top-3 hit rate |\n"
      report += "[bm25-tuning] |-----------:|-------:|---------------:|\n"
      for (const r of results) {
        report += `[bm25-tuning] | ${String(r.weight).padStart(10)} | ${r.mrr.toFixed(3)} | ${(r.top3HitRate * 100).toFixed(1).padStart(13)}% |\n`
      }
      report += "[bm25-tuning] ──────────────────────────────────────────────\n"
      report +=
        "[bm25-tuning] 各 weight 下每 query 命中详情（rank=0 表示 expected 未命中 top-10）：\n"
      for (const r of results) {
        report += "[bm25-tuning] \n"
        report += `[bm25-tuning] === nameWeight=${r.weight} ===\n`
        for (const p of r.topPositions) {
          const okMark = p.rank === 1 ? "✓" : p.rank === 0 ? "✗" : "·"
          report += `[bm25-tuning] ${okMark} query="${p.query}" expected="${p.expected}" rank=${p.rank} top1="${p.topPath.split("/").pop()}"\n`
        }
      }
      report += "[bm25-tuning] ──────────────────────────────────────────────\n"

      // 找推荐 weight：MRR 最高 + tiebreak top-3 hit rate
      const sorted = [...results].sort((a, b) => {
        if (b.mrr !== a.mrr) return b.mrr - a.mrr
        return b.top3HitRate - a.top3HitRate
      })
      report += `[bm25-tuning] 推荐 weight: ${sorted[0].weight} (MRR=${sorted[0].mrr.toFixed(3)}, Top-3=${(sorted[0].top3HitRate * 100).toFixed(1)}%)\n`
      report += "[bm25-tuning] ──────────────────────────────────────────────\n"

      process.stderr.write(report)

      close()
    } finally {
      rmSync(dbDir, { recursive: true, force: true })
      rmSync(fsRoot, { recursive: true, force: true })
    }
  })
})
