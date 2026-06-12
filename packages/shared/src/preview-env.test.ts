import assert from "node:assert/strict"
import { test } from "node:test"

import { buildPreviewEnv, type PreviewEnv } from "./preview-env"

/**
 * F028 Task 0 · buildPreviewEnv 单一真相源迁移（scripts → shared）
 * 契约 = F024 scripts/worktree-preview.test.ts 既有断言（那边零改动保持绿 = 回归锚），
 * 此处为 shared 侧同契约钉死：迁移不是重写，逐字段语义不变。
 */

const INPUT = {
  repoRoot: "C:/repo/.worktrees/F028",
  worktreeName: "F028",
  apiPort: 8801,
  webPort: 3101,
}

test("F028 Task0 · buildPreviewEnv wires ports, urls, cors and title prefix", () => {
  const env: PreviewEnv = buildPreviewEnv(INPUT)
  assert.equal(env.API_PORT, "8801")
  assert.equal(env.PORT, "3101")
  assert.equal(env.CORS_ORIGIN, "http://localhost:3101")
  assert.equal(env.NEXT_PUBLIC_API_HTTP_URL, "http://localhost:8801")
  assert.equal(env.NEXT_PUBLIC_API_WS_URL, "ws://localhost:8801/ws")
  assert.equal(env.NEXT_PUBLIC_API_URL, "http://localhost:8801")
  assert.equal(env.NEXT_PUBLIC_API_BASE_URL, "http://localhost:8801")
  assert.equal(env.NEXT_PUBLIC_APP_TITLE_PREFIX, "[F028] ")
})

test("F028 Task0 · buildPreviewEnv isolates sqlite/uploads/runtime-events under worktree root", () => {
  const env = buildPreviewEnv(INPUT)
  assert.equal(env.SQLITE_PATH, "C:/repo/.worktrees/F028/.runtime/worktree-preview/data/multi-agent.sqlite")
  assert.equal(env.UPLOADS_DIR, "C:/repo/.worktrees/F028/.agents/acceptance/uploads")
  assert.equal(env.RUNTIME_EVENTS_DIR, "C:/repo/.worktrees/F028/.agents/acceptance/runtime-events")
})

test("F028 Task0 · buildPreviewEnv keeps WORKTREE_PREVIEW=1 primary gate", () => {
  const env = buildPreviewEnv(INPUT)
  assert.equal(env.WORKTREE_PREVIEW, "1")
})
