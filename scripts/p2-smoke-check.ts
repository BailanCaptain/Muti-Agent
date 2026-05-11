/**
 * F027 P2 · WikiCompiler smoke check (manual verification)
 *
 * 用途：让小孙肉眼看 compile 后派生视图长什么样。一次性 throw-away 脚本，
 * 不进 CI。在 worktree 根 `cd .worktrees/F027 && pnpm exec tsx scripts/p2-smoke-check.ts`。
 *
 * 流程：
 *   1. 起临时 SQLite + 临时 wikiRoot
 *   2. 种 4 type * 2 canonical memory + 1 draft + 1 deprecated（验状态过滤）
 *   3. 种 3 wiki_events committed + 1 aborted（验事件过滤）
 *   4. 调 compileWiki()
 *   5. 打印派生文件列表 + 每个文件前 N 行 + manifest
 *   6. 不清理 — 留 path 给小孙 cat 自己看
 */

import fs from "node:fs"
import path from "node:path"

import { createDrizzleDb } from "../packages/api/src/db/drizzle-instance"
import { WikiEventsRepository } from "../packages/api/src/db/repositories/wiki-events-repository"
import { WikiMemoriesRepository } from "../packages/api/src/db/repositories/wiki-memories-repository"
import { compileWiki } from "../packages/api/src/wiki/wiki-compiler"

async function main() {
  const root = path.join(process.cwd(), ".runtime", `p2-smoke-${Date.now()}`)
  fs.mkdirSync(root, { recursive: true })
  const dbPath = path.join(root, "test.sqlite")
  const wikiRoot = path.join(root, "wiki")

  const { db, close } = createDrizzleDb(dbPath)
  const eventsRepo = new WikiEventsRepository(db)
  const memoriesRepo = new WikiMemoriesRepository(db)

  // 4 type × 2 canonical + 1 draft + 1 deprecated
  const seedConfigs: Array<{
    type: "project" | "user" | "feedback" | "work"
    name: string
    body: string
    contributedBy: string[]
  }> = [
    { type: "project", name: "Iron Laws", body: "1. 数据神圣不可删\n2. 进程自保\n3. 配置不可变\n4. 网络边界", contributedBy: ["黄仁勋"] },
    { type: "project", name: "F027 V16.5 architecture", body: "统一记忆架构：wiki entity + 派生视图 + 唯一注入合约 + 自动召回", contributedBy: ["黄仁勋", "范德彪"] },
    { type: "user", name: "小孙", body: "Multi-Agent 项目 CVO，第一性原理 + 直觉判断", contributedBy: ["黄仁勋"] },
    { type: "user", name: "范德彪", body: "Codex agent，二轮 review 必走 evidence 实跑", contributedBy: ["黄仁勋"] },
    { type: "feedback", name: "RLHF sycophancy guard", body: "小孙强质疑时不附和，立刻实测", contributedBy: ["黄仁勋"] },
    { type: "feedback", name: "Don't pivot on pushback", body: "保持技术判断，用证据说话", contributedBy: ["黄仁勋"] },
    { type: "work", name: "F027 Phase 1 Week 1 cluster", body: "P0 schema + P1 wiki_events + P10 wiki_memories + P21 manifest 全绿", contributedBy: ["黄仁勋"] },
    { type: "work", name: "F026 Round 2 closeout", body: "Call Tree + Envelope 双层 11 不变量全绿 (944b7b1)", contributedBy: ["黄仁勋", "范德彪"] },
  ]

  for (const cfg of seedConfigs) {
    const m = memoriesRepo.insert({
      type: cfg.type,
      name: cfg.name,
      canonicalOwnerPath: `wiki/${cfg.type}/${slug(cfg.name)}.md`,
      contributedBy: cfg.contributedBy,
      body: cfg.body,
    })
    memoriesRepo.updateState(m.id, "draft", "canonical")
  }

  // 1 draft + 1 deprecated（验状态过滤）
  memoriesRepo.insert({
    type: "project",
    name: "Draft idea (still WIP)",
    canonicalOwnerPath: "wiki/project/draft-idea.md",
    contributedBy: ["黄仁勋"],
    body: "草稿，应不出现在 project.md 派生视图",
  })
  const dep = memoriesRepo.insert({
    type: "project",
    name: "Deprecated old plan",
    canonicalOwnerPath: "wiki/project/old-plan.md",
    contributedBy: ["黄仁勋"],
    body: "废稿，应不出现在 project.md 派生视图",
  })
  memoriesRepo.updateState(dep.id, "draft", "deprecated")

  // 3 committed events + 1 aborted（验日志过滤）
  for (let i = 1; i <= 3; i++) {
    const e = eventsRepo.appendPending({
      ts: `2026-05-11T10:0${i}:00Z`,
      alias: i % 2 ? "黄仁勋" : "范德彪",
      action: "write",
      path: `wiki/project/sample-${i}.md`,
      attemptedHash: `sha256:smoke-attempt-${i}`,
      fencingToken: String(1000 + i),
      leaderTerm: "term-smoke",
    })
    eventsRepo.commit(e.id, { contentHash: `sha256:smoke-final-${i}` })
  }
  const aborted = eventsRepo.appendPending({
    ts: "2026-05-11T10:09:00Z",
    alias: "桂芬",
    action: "write",
    path: "wiki/project/aborted-sample.md",
    attemptedHash: "sha256:smoke-aborted",
    fencingToken: "9999",
    leaderTerm: "term-smoke",
  })
  eventsRepo.abort(aborted.id, { reason: "smoke-test", error: "demo aborted" })

  const allEvents = eventsRepo.getByState("committed", 1000)
    .concat(eventsRepo.getByState("aborted", 1000))
    .concat(eventsRepo.getByState("pending", 1000))
  const allMemories = memoriesRepo.listAll()

  const result = compileWiki({
    wikiRoot,
    version: "smoke-" + new Date().toISOString().replace(/[:.]/g, "").slice(0, 14),
    events: allEvents,
    memories: allMemories,
    generatedAt: new Date().toISOString(),
  })

  console.log("=".repeat(72))
  console.log("F027 P2 WikiCompiler smoke check — 派生视图")
  console.log("=".repeat(72))
  console.log("")
  console.log(`wikiRoot: ${wikiRoot}`)
  console.log(`version: ${result.version}`)
  console.log(`events: ${result.stats.totalEvents} 总 / ${result.stats.committedEvents} committed`)
  console.log("canonical by type:", result.stats.canonicalByType)
  console.log("")
  console.log(`-- 落盘 ${result.filesWritten.length} 文件:`)
  for (const f of result.filesWritten) {
    const abs = path.join(wikiRoot, f)
    const size = fs.statSync(abs).size
    console.log(`  ${f}  (${size} bytes)`)
  }
  console.log("")

  // 打印 wiki/index.md 全文（最值得肉眼看的一份）
  const idxAbs = path.join(wikiRoot, "index.md")
  console.log("-- wiki/index.md (顶层一级摘要):")
  console.log("-".repeat(72))
  console.log(fs.readFileSync(idxAbs, "utf-8"))
  console.log("-".repeat(72))
  console.log("")

  // 打印 manifest.json
  const manifestAbs = path.join(wikiRoot, "index", "manifest.json")
  console.log("-- index/manifest.json:")
  console.log("-".repeat(72))
  console.log(fs.readFileSync(manifestAbs, "utf-8"))
  console.log("-".repeat(72))
  console.log("")

  console.log(`📂 完整派生文件留在: ${wikiRoot}`)
  console.log("   小孙可以 cd 进去 cat 各 type 文件 / log.md / sources.md 看效果。")
  console.log(`   清理：rm -r ${root}`)

  close()
}

function slug(s: string): string {
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  if (base.length > 0) return base
  // 中文/全 unicode 兜底：sha8 防 wiki/user/.md 这种空 slug
  return Array.from(s).map((c) => c.charCodeAt(0).toString(36)).join("").slice(0, 8) || "x"
}

main().catch((err) => {
  console.error("smoke check failed:", err)
  process.exit(1)
})
