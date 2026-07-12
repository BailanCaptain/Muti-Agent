import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  analyzeClauseMatches,
  compileRecallFtsQuery,
  quoteFtsTerm,
  type CompiledFtsQuery,
} from "./fts-query-compiler"

describe("compileRecallFtsQuery · CJK 自然句（LL-036 三字滑窗）", () => {
  it("中文自然问句 → 三字滑窗 OR，无长 phrase（修复恒空主根因）", () => {
    const c = compileRecallFtsQuery("异步验证：探针协议的核心规则有几条？")
    assert.equal(c.unsupported, false)
    assert.deepEqual(c.mustClauses, [])
    // 滑窗必含关键三字段
    assert.ok(c.orClauses.includes("探针协"))
    assert.ok(c.orClauses.includes("针协议"))
    assert.ok(c.orClauses.includes("核心规"))
    // 不允许任何 >3 字的 CJK phrase 残留（旧 sanitize 的病灶形态）
    for (const cl of c.orClauses) {
      if (/\p{Script=Han}/u.test(cl)) assert.ok(cl.length <= 3, `CJK clause 超长: ${cl}`)
    }
    // matchExpr 为 OR 连接且每 term 带引号
    assert.match(c.matchExpr, /"探针协" OR/)
    assert.doesNotMatch(c.matchExpr, /AND/)
  })

  it("滑窗去重：重复窗口只出现一次", () => {
    const c = compileRecallFtsQuery("探针探针探针")
    const uniq = new Set(c.orClauses)
    assert.equal(uniq.size, c.orClauses.length)
  })

  it("纯 1-2 字 CJK 碎片 → unsupported（trigram 物理死 token，显式不支持）", () => {
    const c = compileRecallFtsQuery("你好")
    assert.equal(c.unsupported, true)
    assert.equal(c.matchExpr, "")
    assert.deepEqual(c.droppedShortFragments, ["你好"])
  })

  it("混合 token：英文与 CJK 连写各自按规则切", () => {
    const c = compileRecallFtsQuery("api召回链")
    assert.ok(c.orClauses.includes("api"))
    assert.ok(c.orClauses.includes("召回链"))
  })

  it("<3 字符英文 token 丢弃（trigram 同样搜不到）", () => {
    const c = compileRecallFtsQuery("js 框架选型")
    assert.ok(!c.orClauses.includes("js"))
    assert.ok(c.droppedShortFragments.includes("js"))
    assert.ok(c.orClauses.includes("框架选"))
    assert.ok(c.orClauses.includes("架选型"))
  })
})

describe("compileRecallFtsQuery · 实体信号 MUST（ADR-005）", () => {
  it("F 编号提取为 must；must+or → optional-boost 表达式（德彪 AC6-r1 P1-2）", () => {
    const c = compileRecallFtsQuery("F042 召回管道怎么修")
    assert.deepEqual(c.mustClauses, ["F042"])
    assert.ok(c.orClauses.includes("召回管"))
    assert.ok(c.orClauses.includes("管道怎"))
    // `((must) AND (or…)) OR (must)`：OR 命中参与 BM25 让真目标排前，
    // 同时保留 must-only fallback 召回面（滑窗不在目标文档时不杀正确命中）
    assert.match(c.matchExpr, /^\(\("F042"\) AND \(/)
    assert.match(c.matchExpr, /\)\) OR \("F042"\)$/)
  })

  it("R-xxx / LL-xxx / Bxxx 编号均提取（连字符不被 normalize 拆碎）", () => {
    const c = compileRecallFtsQuery("R-205 和 LL-036 还有 B026 那个坑")
    assert.ok(c.mustClauses.includes("R-205"))
    assert.ok(c.mustClauses.includes("LL-036"))
    assert.ok(c.mustClauses.includes("B026"))
  })

  it("wiki path 提取到 pathMusts（不进 MATCH——path 列 UNINDEXED，德彪 AC6-r1 P2-3）", () => {
    const c = compileRecallFtsQuery("看下 concepts/foo-bar.md 的内容")
    assert.deepEqual(c.pathMusts, ["concepts/foo-bar.md"])
    assert.ok(!c.mustClauses.includes("concepts/foo-bar.md"))
    assert.ok(!c.matchExpr.includes("concepts/foo-bar.md"))
    assert.equal(c.unsupported, false, "纯 path 查询（剩余词全短）也可用")
  })

  it("「」内 ≥3 字术语提取为 must", () => {
    const c = compileRecallFtsQuery("「探针协议」是什么")
    assert.ok(c.mustClauses.includes("探针协议"))
  })

  it("must 单独成立（无 or 内容时不 unsupported）", () => {
    const c = compileRecallFtsQuery("F042")
    assert.equal(c.unsupported, false)
    assert.equal(c.matchExpr, '"F042"')
  })
})

describe("analyzeClauseMatches · pathMusts 0/1/N 边界", () => {
  function compiled(pathMusts: string[]): CompiledFtsQuery {
    return {
      matchExpr: "",
      mustClauses: [],
      orClauses: [],
      pathMusts,
      unsupported: false,
      droppedShortFragments: [],
    }
  }

  it("0 path：不得虚标 exactPathMatch", () => {
    const { evidence } = analyzeClauseMatches("", compiled([]), "wiki/concepts/a.md")
    assert.equal(evidence.exactPathMatch, false)
  })

  it("1 path：候选匹配该 path 时为 true", () => {
    const { evidence } = analyzeClauseMatches(
      "",
      compiled(["concepts/a.md"]),
      "wiki/concepts/a.md",
    )
    assert.equal(evidence.exactPathMatch, true)
  })

  it("N paths：每个候选匹配任一点名 path 即为 true", () => {
    const query = compiled(["concepts/a.md", "concepts/b.md"])
    const a = analyzeClauseMatches("", query, "wiki/concepts/a.md").evidence
    const b = analyzeClauseMatches("", query, "wiki/concepts/b.md").evidence
    const decoy = analyzeClauseMatches("", query, "wiki/concepts/c.md").evidence

    assert.equal(a.exactPathMatch, true)
    assert.equal(b.exactPathMatch, true)
    assert.equal(decoy.exactPathMatch, false)
  })
})

describe("compileRecallFtsQuery · 安全与上限", () => {
  it("FTS DSL 注入被 quote 中和：引号外只允许连接词与括号", () => {
    const c = compileRecallFtsQuery('body MATCH * OR 1 NEAR("x")')
    // 去掉全部 quoted phrase 后，残余只能是 AND/OR/括号/空格
    const residue = c.matchExpr.replace(/"(?:[^"]|"")*"/g, "")
    assert.match(residue, /^[\sANDOR()]*$/)
  })

  it("phrase 内引号双倍转义", () => {
    assert.equal(quoteFtsTerm('a"b'), '"a""b"')
  })

  it("超长消息 clause 总数封顶 32", () => {
    const long = "记忆召回管道修复方案讨论".repeat(60)
    const c = compileRecallFtsQuery(long)
    assert.ok(c.mustClauses.length + c.orClauses.length <= 32)
  })

  it("空串/纯标点 → unsupported", () => {
    assert.equal(compileRecallFtsQuery("").unsupported, true)
    assert.equal(compileRecallFtsQuery("？！。，").unsupported, true)
  })
})
