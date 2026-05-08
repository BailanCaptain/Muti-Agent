import assert from "node:assert/strict"
import test from "node:test"
import { resolveRuntimeLifecycleConfig } from "./base-runtime"

// B023 AC5: livenessStallWarningMs 默认值 180s → 1_200_000 (20min)
// Opus 4.7 / GPT-5.4 thinking budget 高时 5min+ silent 是正常的，原 180s
// 偶发误杀（DB 实测：范德彪 4a4ca8b3 5/8 02:08 8min 工作 + 5min silent
// 被强制 kill）。放宽默认到 20min 兜底，env override 仍生效。
test("B023 AC5: livenessStallWarningMs 默认值 1_200_000 (20min)", () => {
  const config = resolveRuntimeLifecycleConfig(undefined, {})
  assert.equal(config.livenessStallWarningMs, 1_200_000)
})

test("B023 AC5: env MULTI_AGENT_LIVENESS_STALL_WARNING_MS override 仍生效", () => {
  const config = resolveRuntimeLifecycleConfig(undefined, {
    MULTI_AGENT_LIVENESS_STALL_WARNING_MS: "600000",
  })
  assert.equal(config.livenessStallWarningMs, 600_000)
})

test("B023 AC5: runtime 参数 override 优先于 env", () => {
  const config = resolveRuntimeLifecycleConfig(
    { livenessStallWarningMs: 900_000 },
    { MULTI_AGENT_LIVENESS_STALL_WARNING_MS: "600000" },
  )
  assert.equal(config.livenessStallWarningMs, 900_000)
})
