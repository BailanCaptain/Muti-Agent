import assert from "node:assert/strict"
import test from "node:test"

import { findSameSourceEntries } from "./same-source-detector"

function entry(path: string, name: string, sourcePath?: string) {
  const fm = sourcePath
    ? `---\ntitle: ${name}\nsources:\n  - type: text/markdown\n    path: ${sourcePath}\n    contributed_by: docs-watcher\n---\n`
    : `---\ntitle: ${name}\n---\n`
  return { path, name, body: `${fm}\n# ${name}\nbody` }
}

const DOCS_PATH = "docs/features/F031-ws-recovery.md"

test("同源命中：正式区已有相同 sources[0].path 的条目 → 返回冲突", () => {
  const conflicts = findSameSourceEntries(
    {
      listIndexedEntries: () => [
        entry("wiki/concepts/F031-旧版.md", "F031-旧版", DOCS_PATH),
        entry("wiki/concepts/无关.md", "无关", "docs/other.md"),
        entry("wiki/concepts/无来源.md", "无来源"),
      ],
    },
    DOCS_PATH,
    "wiki/concepts/F031-新版.md",
  )
  assert.deepEqual(conflicts, [{ path: "wiki/concepts/F031-旧版.md", title: "F031-旧版" }])
})

test("排除：dest 自身（同路径 replace 走 dest_exists 通道）/ draft 区 / 归档区", () => {
  const conflicts = findSameSourceEntries(
    {
      listIndexedEntries: () => [
        entry("wiki/concepts/F031-新版.md", "自身", DOCS_PATH),
        entry("wiki/concepts/draft/_auto/pending.md", "draft 里的", DOCS_PATH),
        entry("wiki/_superseded/concepts/older.md", "已归档", DOCS_PATH),
        entry("wiki/_rejected/gone.md", "已拒", DOCS_PATH),
      ],
    },
    DOCS_PATH,
    "wiki/concepts/F031-新版.md",
  )
  assert.deepEqual(conflicts, [])
})

test("src 无 sources.path / frontmatter 烂 → 空（不误伤无源收录）", () => {
  const deps = {
    listIndexedEntries: () => [
      { path: "wiki/concepts/坏frontmatter.md", name: "坏", body: "---\n: : :\n---\nbody" },
      entry("wiki/concepts/好条目.md", "好", DOCS_PATH),
    ],
  }
  assert.deepEqual(findSameSourceEntries(deps, "", "wiki/x.md"), [])
  // 坏 frontmatter 行不炸整个扫描，好条目照常命中
  const conflicts = findSameSourceEntries(deps, DOCS_PATH, "wiki/x.md")
  assert.deepEqual(conflicts, [{ path: "wiki/concepts/好条目.md", title: "好" }])
})

// ── 德彪 r1 P1-4 · FS 权威 lookup（替代 5min 滞后的 wiki_entity_index）──────

test("德彪 r1 P1-4 · createFsSameSourceLookup：扫正式区文件系统零滞后，draft 子目录/非 md 不进", async () => {
  const fsMod = await import("node:fs")
  const pathMod = await import("node:path")
  const { createFsSameSourceLookup } = await import("./same-source-detector")

  const base = pathMod.join(process.cwd(), ".runtime")
  fsMod.mkdirSync(base, { recursive: true })
  const root = fsMod.mkdtempSync(pathMod.join(base, "F042-fs-lookup-"))
  try {
    const conceptsDir = pathMod.join(root, "wiki", "concepts")
    fsMod.mkdirSync(pathMod.join(conceptsDir, "draft", "_auto"), { recursive: true })
    fsMod.mkdirSync(pathMod.join(root, "wiki", "rules"), { recursive: true })
    const fm = (src: string) =>
      `---\ntitle: t\nsources:\n  - type: text/markdown\n    path: ${src}\n    contributed_by: u\n---\nbody`
    // 正式区两桶各一条；draft 子目录一条（不该进）；非 md 一个（不该进）
    fsMod.writeFileSync(pathMod.join(conceptsDir, "live.md"), fm("docs/a.md"))
    fsMod.writeFileSync(pathMod.join(root, "wiki", "rules", "rule1.md"), fm("docs/b.md"))
    fsMod.writeFileSync(pathMod.join(conceptsDir, "draft", "_auto", "pending.md"), fm("docs/a.md"))
    fsMod.writeFileSync(pathMod.join(conceptsDir, "notes.txt"), "not md")

    const lookup = createFsSameSourceLookup(root)
    const rows = lookup.listIndexedEntries()
    const paths = rows.map((r) => r.path).sort()
    assert.deepEqual(paths, ["wiki/concepts/live.md", "wiki/rules/rule1.md"])

    // 端到端：刚 promote 落盘的文件（index 还没收敛）立即可被同源检测命中
    const conflicts = findSameSourceEntries(lookup, "docs/a.md", "wiki/concepts/new.md")
    assert.deepEqual(conflicts, [{ path: "wiki/concepts/live.md", title: "live" }])
  } finally {
    fsMod.rmSync(root, { recursive: true, force: true })
  }
})

test("德彪 r2 P1-2 · FS lookup 覆盖六桶+递归子目录（feedback/work/嵌套不漏），draft/归档子树排除", async () => {
  const fsMod = await import("node:fs")
  const pathMod = await import("node:path")
  const { createFsSameSourceLookup } = await import("./same-source-detector")

  const base = pathMod.join(process.cwd(), ".runtime")
  fsMod.mkdirSync(base, { recursive: true })
  const root = fsMod.mkdtempSync(pathMod.join(base, "F042-fs-lookup-r2-"))
  try {
    const fm = (src: string) =>
      `---\ntitle: t\nsources:\n  - type: text/markdown\n    path: ${src}\n    contributed_by: u\n---\nbody`
    const put = (rel: string, src: string) => {
      const abs = pathMod.join(root, rel)
      fsMod.mkdirSync(pathMod.dirname(abs), { recursive: true })
      fsMod.writeFileSync(abs, fm(src))
    }
    put("wiki/concepts/team/nested.md", "docs/nested.md") // 嵌套子目录（r2 探针场景）
    put("wiki/feedback/fb1.md", "docs/fb.md") // feedback 桶（promote 合法面）
    put("wiki/work/w1.md", "docs/w.md") // work 桶
    put("wiki/concepts/draft/_auto/pending.md", "docs/nested.md") // draft 子树排除
    put("wiki/concepts/draft/_superseded/old.md", "docs/nested.md") // 归档 draft 排除

    const lookup = createFsSameSourceLookup(root)
    const paths = lookup.listIndexedEntries().map((r) => r.path).sort()
    assert.deepEqual(paths, [
      "wiki/concepts/team/nested.md",
      "wiki/feedback/fb1.md",
      "wiki/work/w1.md",
    ])

    // r2 探针复现：嵌套同源必须命中（旧实现返回 []=绕过 409）
    const conflicts = findSameSourceEntries(lookup, "docs/nested.md", "wiki/concepts/new.md")
    assert.deepEqual(conflicts, [{ path: "wiki/concepts/team/nested.md", title: "nested" }])
  } finally {
    fsMod.rmSync(root, { recursive: true, force: true })
  }
})
