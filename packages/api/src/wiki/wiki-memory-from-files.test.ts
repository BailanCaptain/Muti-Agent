/**
 * F027 B2/B1-c · wikiEntityToWikiMemory — 文件实体 → WikiMemory 适配器。
 *
 * 背景（wiring gap 审计 2026-06-05）：compileWiki（全局索引唯一生产者）输入吃
 * `CompileInput.memories: WikiMemory[]`，原来自被 chunk B 砍的 wiki_memories 表 → 永空。
 * 本适配器把扫描到的 wiki 文件（WikiEntity{path,frontmatter,body}）映射成 WikiMemory，
 * 让 compileWiki 改吃文件源（V16.5 chap 14「记忆=文件单一真相源」）。
 *
 * heuristic（frontmatter 缺字段时）：
 *   - state: 显式 frontmatter.state 优先；缺 → path 含 /draft/ 则 draft，否则 canonical
 *     （canonical 树里的文件默认 canonical，draft 子目录默认 draft；B3 backfill 后字段显式化）
 *   - type: 显式优先；缺 → path 推断（/rooms/→room, /agents|/people/→user, /lessons/→feedback,
 *     /episodes|/work/→work, 其余 project）
 *   - canonicalOwnerPath: frontmatter.canonical_owner_path ?? entity.path
 *   - name: frontmatter.name ?? basename(path)
 */

import assert from "node:assert/strict"
import test from "node:test"
import {
  buildWikiMemoriesFromEntities,
  isCompiledMemoryEntity,
  wikiEntityToWikiMemory,
} from "./wiki-memory-from-files"

test("B2 · 全 frontmatter → 字段全映射", () => {
  const m = wikiEntityToWikiMemory(
    {
      path: "wiki/concepts/F027.md",
      frontmatter: {
        type: "project",
        name: "F027 统一记忆架构",
        canonical_owner_path: "wiki/concepts/F027.md",
        state: "canonical",
        supersedes: ["wiki/concepts/old.md"],
        sources: ["msg-1", "msg-2"],
        contributed_by: ["黄仁勋"],
        ttl_days: 90,
        created_at: "2026-05-11T00:00:00.000Z",
        updated_at: "2026-06-01T00:00:00.000Z",
      },
      body: "F027 body...",
    },
    7,
  )
  assert.equal(m.id, 7)
  assert.equal(m.type, "project")
  assert.equal(m.name, "F027 统一记忆架构")
  assert.equal(m.canonicalOwnerPath, "wiki/concepts/F027.md")
  assert.equal(m.state, "canonical")
  assert.deepEqual(m.supersedes, ["wiki/concepts/old.md"])
  assert.deepEqual(m.sourceMessageIds, ["msg-1", "msg-2"])
  assert.deepEqual(m.contributedBy, ["黄仁勋"])
  assert.equal(m.ttlDays, 90)
  assert.equal(m.createdAt, "2026-05-11T00:00:00.000Z")
  assert.equal(m.updatedAt, "2026-06-01T00:00:00.000Z")
  assert.equal(m.body, "F027 body...")
})

test("B2 · 缺 state + 非 draft 路径 → 推断 canonical（canonical 树默认 canonical）", () => {
  const m = wikiEntityToWikiMemory(
    { path: "wiki/concepts/foo.md", frontmatter: {}, body: "b" },
    1,
  )
  assert.equal(m.state, "canonical")
})

test("B2 · 缺 state + /draft/ 路径 → 推断 draft（不进 canonical 索引）", () => {
  const m = wikiEntityToWikiMemory(
    { path: "wiki/concepts/draft/_auto/foo.md", frontmatter: {}, body: "b" },
    1,
  )
  assert.equal(m.state, "draft")
})

test("B2 · 缺 type → path 推断（/rooms/→room, /agents/→user, 其余 project）", () => {
  assert.equal(
    wikiEntityToWikiMemory({ path: "wiki/rooms/R-201/viewfinder.md", frontmatter: {}, body: "" }, 1).type,
    "room",
  )
  assert.equal(
    wikiEntityToWikiMemory({ path: "wiki/agents/黄仁勋/current.md", frontmatter: {}, body: "" }, 1).type,
    "user",
  )
  assert.equal(
    wikiEntityToWikiMemory({ path: "wiki/concepts/x.md", frontmatter: {}, body: "" }, 1).type,
    "project",
  )
})

test("B2 · 缺 name → basename(path) 去 .md", () => {
  const m = wikiEntityToWikiMemory({ path: "wiki/concepts/F018.md", frontmatter: {}, body: "" }, 1)
  assert.equal(m.name, "F018")
})

test("B2 · 缺 canonical_owner_path → 用 entity.path 兜底", () => {
  const m = wikiEntityToWikiMemory({ path: "wiki/rules/iron-laws.md", frontmatter: {}, body: "" }, 1)
  assert.equal(m.canonicalOwnerPath, "wiki/rules/iron-laws.md")
})

test("B2 · 非法 state 值 → 回退 heuristic（不信任意字符串）", () => {
  const m = wikiEntityToWikiMemory(
    { path: "wiki/concepts/x.md", frontmatter: { state: "garbage" }, body: "" },
    1,
  )
  assert.equal(m.state, "canonical") // 非法值 → 非 draft 路径 → canonical
})

// ─── 过滤契约：只有带 canonical_owner_path 的编译记忆实体进索引 ───────────

test("B2 · isCompiledMemoryEntity: 有 canonical_owner_path → true", () => {
  assert.equal(
    isCompiledMemoryEntity({
      path: "wiki/concepts/F027.md",
      frontmatter: { canonical_owner_path: "wiki/concepts/F027.md" },
      body: "",
    }),
    true,
  )
})

test("B2 · isCompiledMemoryEntity: 派生视图/日志（无 canonical_owner_path）→ false", () => {
  // 排除 RoomCompiler 派生视图 / 未编译文件
  assert.equal(
    isCompiledMemoryEntity({ path: "wiki/rooms/R-201/viewfinder.md", frontmatter: {}, body: "" }),
    false,
  )
  assert.equal(
    isCompiledMemoryEntity({ path: "wiki/rooms/R-201/log.md", frontmatter: { generated_by: "RoomCompiler" }, body: "" }),
    false,
  )
})

test("B2 · buildWikiMemoriesFromEntities: 过滤非记忆文件 + 按序 id", () => {
  const entities = [
    { path: "wiki/concepts/F027.md", frontmatter: { canonical_owner_path: "wiki/concepts/F027.md", state: "canonical" }, body: "a" },
    { path: "wiki/rooms/R-201/viewfinder.md", frontmatter: {}, body: "派生视图，无 marker" },
    { path: "wiki/rules/iron.md", frontmatter: { canonical_owner_path: "wiki/rules/iron.md", state: "canonical" }, body: "c" },
    { path: "wiki/index/v-1/index.md", frontmatter: {}, body: "index 派生，无 marker" },
  ]
  const memories = buildWikiMemoriesFromEntities(entities)
  assert.equal(memories.length, 2, "只 2 个带 canonical_owner_path 的实体进")
  assert.deepEqual(memories.map((m) => m.canonicalOwnerPath).sort(), [
    "wiki/concepts/F027.md",
    "wiki/rules/iron.md",
  ])
  assert.deepEqual(memories.map((m) => m.id).sort(), [1, 2], "id 按序 1-based")
})

test("B2 · buildWikiMemoriesFromEntities: 全无 marker（现状）→ 空（索引空，等 B3 backfill）", () => {
  const entities = [
    { path: "wiki/rooms/R-201/viewfinder.md", frontmatter: {}, body: "" },
    { path: "wiki/concepts/draft/_auto/x.md", frontmatter: {}, body: "" },
  ]
  assert.deepEqual(buildWikiMemoriesFromEntities(entities), [])
})
