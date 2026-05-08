import assert from "node:assert/strict"
import test from "node:test"
import { composeFinalContentOnError } from "./compose-final-content-on-error"

// B023 AC1: catch 路径 append 不 overwrite — 保留流式累积的 assistantContent
test("B023 AC1: 流式有内容 → 保留原内容 + 末尾 append [runtime] Error", () => {
  const result = composeFinalContentOnError({
    assistantContent: "德彪 review 半截内容到这里",
    errorMessage: "Agent 进程看起来已卡住（CPU 空转）",
  })
  assert.match(result, /德彪 review 半截内容到这里/, "原 streaming 内容应保留")
  assert.match(
    result,
    /\[runtime\] Error: Agent 进程看起来已卡住/,
    "[runtime] 错误信息应 append 在末尾",
  )
  assert.ok(
    result.indexOf("德彪 review") < result.indexOf("[runtime]"),
    "原内容应在错误信息之前",
  )
  assert.match(result, /\n\n---\n/, "原内容和错误信息之间应有 markdown 分隔线")
})

// 流式什么都没产出（assistant 进程死前没来得及写） → 直接是错误信息
test("B023 AC1: 流式无内容（空 string）→ 只有 [runtime] Error，无前导分隔", () => {
  const result = composeFinalContentOnError({
    assistantContent: "",
    errorMessage: "Agent 好像睡着了",
  })
  assert.equal(result, "[runtime] Error: Agent 好像睡着了")
})

// 流式只有空白字符（trim 后空）→ 视同空，不加分隔
test("B023 AC1: 流式只有空白 → 视同空，不加分隔", () => {
  const result = composeFinalContentOnError({
    assistantContent: "   \n\n  ",
    errorMessage: "Agent 进程已异常退出",
  })
  assert.equal(result, "[runtime] Error: Agent 进程已异常退出")
})

// 错误信息保留完整不截断（前端 UI 需要看完整原因）
test("B023 AC1: 长错误信息原样保留", () => {
  const longError =
    "Agent 进程看起来已卡住（CPU 空转，无新输出 ≥ 1200 秒（约 20 分钟））。最后一次活动时间：2026-05-08T02:16:01.901Z。已强制终止，请重试一次。"
  const result = composeFinalContentOnError({
    assistantContent: "review 写到一半",
    errorMessage: longError,
  })
  assert.match(result, /review 写到一半/, "原内容保留")
  assert.match(
    result,
    /已强制终止，请重试一次。$/,
    "错误信息完整保留到末尾",
  )
})
