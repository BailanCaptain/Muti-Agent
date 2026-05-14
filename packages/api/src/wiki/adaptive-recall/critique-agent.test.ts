/**
 * F027 P13.2 · Critique Agent 单元测试
 * 测 buildCritiquePrompt 结构 + parseCritiqueJson 防 hallucination + LlmCritiqueAgent runner 集成。
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  buildCritiquePrompt,
  LlmCritiqueAgent,
  parseCritiqueJson,
  type ClaudeRunner,
} from "./critique-agent"
import type { CritiqueInput } from "./types"
import type { RecallHit } from "../memory-preflight/types"

function input(level: 1 | 2 | 3 | 4, hits: RecallHit[] = []): CritiqueInput {
  return {
    trigger: "history_keyword",
    query: "F011 drizzle 优化",
    level,
    hits,
    visitedLevels: [],
  }
}

function hit(path: string, score = 0.8, excerpt = "..."): RecallHit {
  return { path, score, excerpt }
}

describe("F027 P13.2 · buildCritiquePrompt", () => {
  it("含 query / trigger / level / hits / 硬约束 5 大要素", () => {
    const prompt = buildCritiquePrompt(input(2, [hit("wiki/concepts/F011.md", 0.85, "drizzle 优化讨论")]))
    assert.match(prompt, /F011 drizzle 优化/)
    assert.match(prompt, /history_keyword/)
    assert.match(prompt, /当前级\] 2/)
    assert.match(prompt, /wiki\/concepts\/F011\.md/)
    assert.match(prompt, /next_level 必须严格大于当前级/)
    assert.match(prompt, /next_level=4 必须配 specific_path/)
  })

  it("0 hits 时显示 (本级 0 命中)", () => {
    const prompt = buildCritiquePrompt(input(2, []))
    assert.match(prompt, /本级 0 命中/)
  })

  it("visitedLevels 非空时显示已走过的级", () => {
    const prompt = buildCritiquePrompt({
      ...input(3),
      visitedLevels: [1, 2],
    })
    assert.match(prompt, /已走过的级: \[1, 2\]/)
  })
})

describe("F027 P13.2 · parseCritiqueJson", () => {
  it("satisfied=true → CritiqueVerdict satisfied:true", () => {
    const v = parseCritiqueJson(
      '{"satisfied": true, "reason": "L2 hits 直接含 F011 决策"}',
      input(2),
    )
    assert.equal(v.satisfied, true)
    assert.match(v.reason, /F011 决策/)
  })

  it("satisfied=false + next_level=3 → CritiqueVerdict nextLevel:3", () => {
    const v = parseCritiqueJson(
      '{"satisfied": false, "next_level": 3, "reason": "L2 hits 偏概念，需查消息"}',
      input(2),
    )
    assert.equal(v.satisfied, false)
    assert.ok("nextLevel" in v && v.nextLevel === 3)
  })

  it("satisfied=false + next_level=4 + specific_path → CritiqueVerdict L4 严格", () => {
    const v = parseCritiqueJson(
      '{"satisfied": false, "next_level": 4, "specific_path": "wiki/concepts/F011-deep.md", "reason": "需读原文"}',
      input(3),
    )
    assert.equal(v.satisfied, false)
    assert.ok("nextLevel" in v && v.nextLevel === 4)
    assert.ok("specificPath" in v && v.specificPath === "wiki/concepts/F011-deep.md")
  })

  it("satisfied=false + escalate=true → CritiqueVerdict escalate", () => {
    const v = parseCritiqueJson(
      '{"satisfied": false, "escalate": true, "reason": "项目从未讨论过"}',
      input(3),
    )
    assert.equal(v.satisfied, false)
    assert.ok("escalate" in v && v.escalate === true)
  })

  it("markdown fence 包裹也能解析", () => {
    const v = parseCritiqueJson(
      '```json\n{"satisfied": true, "reason": "ok"}\n```',
      input(2),
    )
    assert.equal(v.satisfied, true)
  })

  it("invalid JSON 抛 critique-parse-failed", () => {
    assert.throws(
      () => parseCritiqueJson("not json", input(2)),
      /critique-parse-failed/,
    )
  })

  it("next_level=4 缺 specific_path → 抛", () => {
    assert.throws(
      () =>
        parseCritiqueJson(
          '{"satisfied": false, "next_level": 4, "reason": "fuzzy"}',
          input(3),
        ),
      /next_level=4 必须配 specific_path/,
    )
  })

  it("next_level <= current level → 抛（防反复推回）", () => {
    assert.throws(
      () =>
        parseCritiqueJson(
          '{"satisfied": false, "next_level": 2, "reason": "回 L2"}',
          input(3),
        ),
      /next_level=2 <= current level=3/,
    )
  })

  it("next_level=4 specific_path 不形如 wiki/... 也不在 hits 中 → 抛（防 hallucination）", () => {
    assert.throws(
      () =>
        parseCritiqueJson(
          '{"satisfied": false, "next_level": 4, "specific_path": "/etc/passwd", "reason": "..."}',
          input(3, [hit("wiki/concepts/real.md")]),
        ),
      /不合法/,
    )
  })

  it("【范-r1 P2-1】next_level=4 严格只接受 wiki/...md：即使在本级 hits 中，messages path 也抛（小孙 Open #3 strict）", () => {
    assert.throws(
      () =>
        parseCritiqueJson(
          '{"satisfied": false, "next_level": 4, "specific_path": "messages/m-xxx", "reason": "..."}',
          input(3, [hit("messages/m-xxx", 0.7)]),
        ),
      /不合法/,
      "L4 严格模式只接受 wiki/...md，hits 中 messages path 不放宽（避免 backend 注定返 null 浪费 critique）",
    )
  })

  it("【范-r1 P2-2】next_level=5 由 parser 转 escalate verdict（防 executor 不识别 nextLevel=5 而 fall through）", () => {
    const v = parseCritiqueJson(
      '{"satisfied": false, "next_level": 5, "reason": "exhausted"}',
      input(4),
    )
    assert.equal(v.satisfied, false)
    assert.ok("escalate" in v && v.escalate === true, "next_level=5 必须转 escalate verdict")
    assert.match(v.reason, /exhausted/)
  })

  it("【范-r2 P2-B】L2 + next_level=5 → 转 escalate（防 fall through 到 L3）", () => {
    const v = parseCritiqueJson(
      '{"satisfied": false, "next_level": 5, "reason": "no_history_topic"}',
      input(2),
    )
    assert.equal(v.satisfied, false)
    assert.ok("escalate" in v && v.escalate === true)
    assert.match(v.reason, /no_history_topic/)
  })

  it("【范-r2 P2-B】L3 + next_level=5 → 转 escalate（防 fall through 到 L4 attempt）", () => {
    const v = parseCritiqueJson(
      '{"satisfied": false, "next_level": 5, "reason": "exhausted_l3"}',
      input(3),
    )
    assert.equal(v.satisfied, false)
    assert.ok("escalate" in v && v.escalate === true)
  })

  it("next_level 非整数 / 越界 → 抛", () => {
    assert.throws(
      () =>
        parseCritiqueJson(
          '{"satisfied": false, "next_level": "two", "reason": "..."}',
          input(2),
        ),
      /invalid next_level/,
    )
    assert.throws(
      () =>
        parseCritiqueJson(
          '{"satisfied": false, "next_level": 6, "reason": "..."}',
          input(2),
        ),
      /invalid next_level/,
    )
  })

  it("非 object JSON（数组）→ 抛", () => {
    assert.throws(() => parseCritiqueJson("[]", input(2)), /not an object/)
  })
})

describe("F027 P13.2 · LlmCritiqueAgent", () => {
  function fakeRunner(response: { ok: boolean; text?: string; error?: string }): ClaudeRunner {
    return {
      async runPrompt() {
        return {
          ok: response.ok,
          text: response.text ?? "",
          error: response.error,
          durationMs: 1234,
        }
      },
    }
  }

  it("runner 返合法 JSON → evaluate 返 CritiqueVerdict", async () => {
    const agent = new LlmCritiqueAgent(
      fakeRunner({
        ok: true,
        text: '{"satisfied": true, "reason": "L2 hits 充分"}',
      }),
    )
    const v = await agent.evaluate(input(2, [hit("wiki/x.md")]))
    assert.equal(v.satisfied, true)
  })

  it("runner 失败 → evaluate 抛 critique-runner-failed", async () => {
    const agent = new LlmCritiqueAgent(
      fakeRunner({ ok: false, error: "timeout" }),
    )
    await assert.rejects(
      () => agent.evaluate(input(2)),
      /critique-runner-failed.*timeout/,
    )
  })

  it("runner 返非法 JSON → evaluate 抛 critique-parse-failed", async () => {
    const agent = new LlmCritiqueAgent(
      fakeRunner({ ok: true, text: "<not json>" }),
    )
    await assert.rejects(() => agent.evaluate(input(2)), /critique-parse-failed/)
  })
})
