import assert from "node:assert/strict"
import test from "node:test"

import { judgeAdoption } from "./adoption-heuristic"

const hits = [
  { path: "wiki/concepts/F031-WS序列恢复.md", title: "F031-WS序列恢复" },
  { path: "wiki/methods/worktree-预览端口.md", title: "worktree-预览端口" },
]

test("回复引用条目标题 → adopted + 命中路径", () => {
  const r = judgeAdoption("F031-WS序列恢复 已经合并了，seq/epoch 机制见 wiki。", hits)
  assert.ok(r)
  assert.equal(r.adopted, true)
  assert.deepEqual(
    r.matches.map((m) => m.path),
    ["wiki/concepts/F031-WS序列恢复.md"],
  )
})

test("回复引用 [[wiki-link]] 形态（带/不带 .md 后缀）→ adopted", () => {
  const r = judgeAdoption("参考 [[wiki/methods/worktree-预览端口]]。", hits)
  assert.ok(r)
  assert.equal(r.adopted, true)
  const r2 = judgeAdoption("参考 [[wiki/methods/worktree-预览端口.md]]。", hits)
  assert.ok(r2)
  assert.equal(r2.adopted, true)
})

test("回复只引用 basename（无目录/扩展名）→ adopted（title 缺省时的兜底信号）", () => {
  const r = judgeAdoption("看 worktree-预览端口 那篇。", [
    { path: "wiki/methods/worktree-预览端口.md" },
  ])
  assert.ok(r)
  assert.equal(r.adopted, true)
})

test("回复与召回无交集 → adopted=false + matches 空", () => {
  const r = judgeAdoption("今天天气不错。", hits)
  assert.ok(r)
  assert.equal(r.adopted, false)
  assert.equal(r.matches.length, 0)
})

test("空召回 → null（不可判，勿计入标注）", () => {
  assert.equal(judgeAdoption("任意回复", []), null)
})

test("纯 ASCII title 按词边界匹配（rapid 内的 api 子串不误报）", () => {
  const apiHit = [{ path: "wiki/concepts/API.md", title: "API" }]
  const r = judgeAdoption("the api is fine", apiHit)
  assert.ok(r)
  assert.equal(r.adopted, true)
  const r2 = judgeAdoption("rapid response needed", apiHit)
  assert.ok(r2)
  assert.equal(r2.adopted, false)
})

test("超短 term（<2 字符）不参与匹配（防单字噪音）", () => {
  const r = judgeAdoption("a b c 到处都是", [{ path: "wiki/concepts/a.md", title: "a" }])
  assert.ok(r)
  assert.equal(r.adopted, false)
})

test("每条目只记一次 match（wiki-link 命中后不再重复计 title/basename）", () => {
  const r = judgeAdoption(
    "见 [[wiki/concepts/F031-WS序列恢复]]，F031-WS序列恢复 讲得很全。",
    hits,
  )
  assert.ok(r)
  assert.equal(r.matches.filter((m) => m.path === hits[0].path).length, 1)
})
