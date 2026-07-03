import assert from "node:assert/strict"
import { test } from "node:test"

import { buildE2eEnv, type E2eEnv } from "./e2e-env"

/**
 * F038 · buildE2eEnv 契约（对齐 preview-env.ts 布线键集，但走独立隔离面）：
 * - 四个 NEXT_PUBLIC_API_* 键 + CORS 与 preview 同构（前端布线契约单一真相源级对齐）
 * - SQLITE_PATH/UPLOADS_DIR/RUNTIME_EVENTS_DIR/WIKI_ROOT 全落 E2E runRoot（temp）
 * - 德彪设计审 r1 P1-1：MULTI_AGENT_SKIP_SCHEDULER=1 + MULTI_AGENT_DOCS_WATCHER=0
 *   （E2E 不跑 scheduler/docs-watcher/wiki reindex，不碰真实 docs/ 与 .runtime/wiki）
 * - 不设 WORKTREE_PREVIEW（preview seed loader 不得在 E2E 里点火）
 * - Iron Law 1 护栏：SQLITE_PATH 命中主库/preview 库路径特征 → throw
 */

const INPUT = {
  apiPort: 8999,
  webPort: 3999,
  runRoot: "C:/tmp/multi-agent-e2e-abc123",
}

test("F038 · buildE2eEnv wires ports, urls, cors and title prefix", () => {
  const env: E2eEnv = buildE2eEnv(INPUT)
  assert.equal(env.API_PORT, "8999")
  assert.equal(env.PORT, "3999")
  assert.equal(env.CORS_ORIGIN, "http://localhost:3999")
  assert.equal(env.NEXT_PUBLIC_API_HTTP_URL, "http://localhost:8999")
  assert.equal(env.NEXT_PUBLIC_API_WS_URL, "ws://localhost:8999/ws")
  assert.equal(env.NEXT_PUBLIC_API_URL, "http://localhost:8999")
  assert.equal(env.NEXT_PUBLIC_API_BASE_URL, "http://localhost:8999")
  assert.equal(env.NEXT_PUBLIC_APP_TITLE_PREFIX, "[E2E] ")
})

test("F038 · buildE2eEnv isolates sqlite/uploads/runtime-events/wiki under runRoot", () => {
  const env = buildE2eEnv(INPUT)
  assert.equal(env.SQLITE_PATH, "C:/tmp/multi-agent-e2e-abc123/e2e.sqlite")
  assert.equal(env.UPLOADS_DIR, "C:/tmp/multi-agent-e2e-abc123/uploads")
  assert.equal(env.RUNTIME_EVENTS_DIR, "C:/tmp/multi-agent-e2e-abc123/runtime-events")
  assert.equal(env.WIKI_ROOT, "C:/tmp/multi-agent-e2e-abc123/wiki-root")
})

test("F038 · buildE2eEnv kills scheduler/docs-watcher and never sets WORKTREE_PREVIEW", () => {
  const env = buildE2eEnv(INPUT)
  assert.equal(env.MULTI_AGENT_SKIP_SCHEDULER, "1")
  assert.equal(env.MULTI_AGENT_DOCS_WATCHER, "0")
  assert.equal("WORKTREE_PREVIEW" in env, false)
})

test("F038 · buildE2eEnv rejects runRoot that points at real DB locations (Iron Law 1)", () => {
  assert.throws(() => buildE2eEnv({ ...INPUT, runRoot: "C:/repo/data" }), /Iron Law/)
  assert.throws(
    () => buildE2eEnv({ ...INPUT, runRoot: "C:/repo/.runtime/worktree-preview/data" }),
    /Iron Law/,
  )
  // 德彪 r2 P3：data 的「子路径」也必须挡（C:/repo/data/e2e-run 曾漏网）
  assert.throws(() => buildE2eEnv({ ...INPUT, runRoot: "C:/repo/data/e2e-run" }), /Iron Law/)
  assert.throws(() => buildE2eEnv({ ...INPUT, runRoot: "C:\\repo\\data\\nested\\x" }), /Iron Law/)
})

test("F038 · buildE2eEnv guard does not false-positive on legit temp paths", () => {
  // AppData / data-xyz 段不是独立 data 段，不应误伤
  assert.doesNotThrow(() =>
    buildE2eEnv({ ...INPUT, runRoot: "C:/Users/x/AppData/Local/Temp/multi-agent-e2e-1" }),
  )
  assert.doesNotThrow(() => buildE2eEnv({ ...INPUT, runRoot: "/tmp/data-xyz" }))
})
