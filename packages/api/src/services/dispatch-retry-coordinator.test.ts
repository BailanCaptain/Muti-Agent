import assert from "node:assert/strict"
import test from "node:test"
import type { ProviderAliases } from "../orchestrator/mention-router"
import {
  MAX_DISPATCH_RETRIES_DEFAULT,
  buildCorrectionPrompt,
  decideRetryAction,
} from "./dispatch-retry-coordinator"

/**
 * F026 P3.1 Task4 · 派发协议 retry 决策状态机（纯函数）
 *
 * 输入：assistant final accumulatedContent + 当前 retryState (attemptIndex, priorReasons)
 * 输出：accept / retry / exhaust 三态决策
 *
 * AC-7: assistant final 入库前 hook 命中即拒收
 * AC-9: MAX_DISPATCH_RETRIES=3 上限；耗尽后 status=exhausted 兜底入库
 */

const aliases: ProviderAliases = {
  claude: "黄仁勋",
  codex: "范德彪",
  gemini: "桂芬",
}

test("AC-7 第一次合规 → action=accept · retryCount=0", () => {
  const r = decideRetryAction({
    content: "[Call: @范德彪 review F026]",
    aliases,
    attemptIndex: 1,
    priorReasons: [],
  })
  assert.equal(r.action, "accept")
  assert.equal(r.retryCount, 0)
  assert.deepEqual(r.retryReasons, [])
})

test("AC-7 第一次嵌套 → action=retry · reason=nested_call_tag · 仍未达上限", () => {
  const r = decideRetryAction({
    content: "[Call: @A 描述 [Call: @B] 接力]",
    aliases,
    attemptIndex: 1,
    priorReasons: [],
  })
  assert.equal(r.action, "retry")
  assert.equal(r.reason, "nested_call_tag")
  assert.equal(r.nextAttemptIndex, 2)
  assert.equal(r.maxAttempts, MAX_DISPATCH_RETRIES_DEFAULT)
})

test("AC-7 第二次仍嵌套 → action=retry · 仍未达上限（attemptIndex=2 < MAX 3）", () => {
  const r = decideRetryAction({
    content: "[Call: @A foo [Call: @B bar]]",
    aliases,
    attemptIndex: 2,
    priorReasons: ["nested_call_tag"],
  })
  assert.equal(r.action, "retry")
  assert.equal(r.reason, "nested_call_tag")
  assert.equal(r.nextAttemptIndex, 3)
})

test("AC-9 第三次仍错 → action=exhaust · retryCount=3 · status=exhausted", () => {
  const r = decideRetryAction({
    content: "[Call: @范德彪 重复 [Call: @桂芬 hi]]",
    aliases,
    attemptIndex: 3,
    priorReasons: ["nested_call_tag", "nested_call_tag"],
  })
  assert.equal(r.action, "exhaust")
  assert.equal(r.retryCount, 3)
  assert.deepEqual(r.retryReasons, ["nested_call_tag", "nested_call_tag", "nested_call_tag"])
})

test("AC-9 第三次终于合规 → action=accept · retryCount=2", () => {
  const r = decideRetryAction({
    content: "[Call: @桂芬 重写完了，请你确认]",
    aliases,
    attemptIndex: 3,
    priorReasons: ["nested_call_tag", "nested_call_tag"],
  })
  assert.equal(r.action, "accept")
  assert.equal(r.retryCount, 2)
  assert.deepEqual(r.retryReasons, ["nested_call_tag", "nested_call_tag"])
})

test("AC-19 R-057 行首裸真实队友 @ → action=retry · reason=naked_at_with_real_teammate", () => {
  // R-057 场景：assistant 漏写 [Call:] 包装，链路静默断
  // 兜底层重启后：行首裸真实队友 @ + 全文无 [Call:] → 触发 retry，要求 LLM 补包装
  for (const text of [
    "@范德彪 review 这个 PR",
    "@桂芬 帮我看下 F012 这个 bug 还能不能复现",
    "@桂芬 也帮过我",
    "前面铺垫\n\n@范德彪 接力实现下一步",
  ]) {
    const r = decideRetryAction({
      content: text,
      aliases,
      attemptIndex: 1,
      priorReasons: [],
    })
    assert.equal(r.action, "retry", `text="${text}" should retry (R-057 fail-visible)`)
    if (r.action === "retry") {
      assert.equal(r.reason, "naked_at_with_real_teammate")
    }
  }
})

test("AC-19b 句中（非行首）@ + 全文无 [Call:] → action=accept（叙述句不触发）", () => {
  for (const text of ["我和 @桂芬 之前聊过这个事", "刚才提到的 @范德彪 在 F012 那块儿熟"]) {
    const r = decideRetryAction({
      content: text,
      aliases,
      attemptIndex: 1,
      priorReasons: [],
    })
    assert.equal(r.action, "accept", `text="${text}" should accept (mid-sentence @ is descriptive)`)
  }
})

test("AC-19c 同篇有合法 [Call:] + 行首裸 @（叙述）→ action=accept（已派发轮短路）", () => {
  const text = "[Call: @范德彪 review F026]\n\n顺带一提，@桂芬 之前也帮过我类似的事。"
  const r = decideRetryAction({
    content: text,
    aliases,
    attemptIndex: 1,
    priorReasons: [],
  })
  assert.equal(r.action, "accept")
})

test("AC-9 自定义 MAX：env override → 上限可调", () => {
  const r1 = decideRetryAction({
    content: "[Call: @A [Call: @B]]",
    aliases,
    attemptIndex: 1,
    priorReasons: [],
    maxAttempts: 1,
  })
  // attemptIndex=1, max=1 → 没有更多机会，直接 exhaust
  assert.equal(r1.action, "exhaust")
  assert.equal(r1.retryCount, 1)
})

test("buildCorrectionPrompt · nested_call_tag → 含中文教育 + 错误样本", () => {
  const prompt = buildCorrectionPrompt({
    reason: "nested_call_tag",
    originalText: "[Call: @A 描述 [Call: @B] 接力]",
    attemptIndex: 1,
    maxAttempts: 3,
  })
  assert.match(prompt, /派发格式不合契约/)
  assert.match(prompt, /嵌套/)
  assert.match(prompt, /\[Call: @人名 任务/)
  assert.match(prompt, /禁止嵌套/)
  // 带原文样本帮 LLM 看到自己写错的具体内容
  assert.match(prompt, /\[Call: @A/)
})

test("buildCorrectionPrompt · naked_at_with_real_teammate → 教 LLM 把行首 @ 改成 [Call:] 包装", () => {
  const prompt = buildCorrectionPrompt({
    reason: "naked_at_with_real_teammate",
    originalText: "@范德彪 接力修 R-057",
    attemptIndex: 2,
    maxAttempts: 3,
  })
  assert.match(prompt, /派发格式不合契约/)
  assert.match(prompt, /行首裸 @/)
  assert.match(prompt, /\[Call: @队友名 任务描述/)
  // 给出"叙述/装饰句应改成句中 @"的逃生口
  assert.match(prompt, /叙述|提及|句中/)
  // 带原文样本
  assert.match(prompt, /@范德彪/)
})
