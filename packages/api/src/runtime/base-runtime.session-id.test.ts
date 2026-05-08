import assert from "node:assert/strict"
import test from "node:test"
import { findSessionId } from "./base-runtime"

// B023 AC2: codex CLI stdout 第一帧实测格式（区别于磁盘 rollout jsonl 格式）
// Before fix: findSessionId returned null on codex frames → threads.native_session_id
// stayed empty for 8 weeks since 2026-03-15 → codex never resumed.
//
// 实测调研踩坑（自我修正）：先看 ~/.codex/sessions/2026/.../*.jsonl 第一帧
// 是 {type:"session_meta", payload:{id:"..."}} 格式 → 加 session_meta 分支
// → preview 实测发现 stdout **不是** session_meta 而是 thread.started！
// codex 写到磁盘 rollout 用 session_meta，但 stdout 给 caller 用 thread.started。
// 双格式都加分支才稳。
test("B023 AC2: findSessionId 识别 codex stdout thread.started.thread_id (实测格式)", () => {
  const codexStdoutFrame = {
    type: "thread.started",
    thread_id: "019e0801-1d7e-72f3-adf0-a121a881d75c",
  }
  assert.equal(findSessionId(codexStdoutFrame), "019e0801-1d7e-72f3-adf0-a121a881d75c")
})

test("B023 AC2 兼容: findSessionId 仍识别 codex 磁盘 rollout session_meta.payload.id", () => {
  const codexRolloutFrame = {
    timestamp: "2026-03-11T14:36:17.115Z",
    type: "session_meta",
    payload: {
      id: "019cdd4f-e8e3-7ff0-ba69-f479ebf5808c",
      cli_version: "0.114.0",
    },
  }
  assert.equal(findSessionId(codexRolloutFrame), "019cdd4f-e8e3-7ff0-ba69-f479ebf5808c")
})

// B023 AC3: regression guard — Claude format must still work after the codex branch.
test("B023 AC3: findSessionId 仍识别 Claude system+session_id 格式（不退化）", () => {
  const claudeFrame = {
    type: "system",
    subtype: "init",
    session_id: "27f115fd-1f6e-4bca-8bf7-3985f329bcde",
  }
  assert.equal(findSessionId(claudeFrame), "27f115fd-1f6e-4bca-8bf7-3985f329bcde")
})

// B017 守卫不退化：Claude 错误回包带的假 session_id 仍要被拒绝
test("B023: B017 Claude error envelope 守卫仍生效", () => {
  const claudeErrorFrame = {
    type: "result",
    is_error: true,
    num_turns: 0,
    session_id: "junk-fresh-id",
  }
  assert.equal(findSessionId(claudeErrorFrame), null)
})

// codex payload.id 为空字符串时不应返回（视为无效）
test("B023: codex session_meta payload.id 为空字符串返回 null", () => {
  const codexFrameEmptyId = {
    type: "session_meta",
    payload: {
      id: "",
    },
  }
  assert.equal(findSessionId(codexFrameEmptyId), null)
})
