/**
 * F026 P3 · a2a-gateway sibling-guard 集成测试
 *
 * R-096 重放：仁勋派 [@桂芬][@德彪] 之后，桂芬 reply 写 [Call: @德彪] —— sibling
 * 互调，应在 openCall 之前被 a2a-gateway 拦下，reason="sibling-cross-call"。
 *
 * 边界：
 *   - 反向接力（child → parent）仍允许：parent alias 不在 sibling 集合里
 *   - 缺 worklistRegistry deps 时静默放行（向后兼容旧测试 harness）
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { SqliteStore } from "../db/sqlite"
import { planBetaDispatch } from "./a2a-gateway"
import { CallRegistry } from "./call-registry"
import { MentionRateLimiter, type ProviderAliases } from "./mention-router"
import { WorklistRegistry } from "./worklist-registry"

const aliases: ProviderAliases = {
  claude: "黄仁勋",
  codex: "范德彪",
  gemini: "桂芬",
}

const FUTURE = "2026-05-05T18:00:00.000Z"

function mkDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-p3-sibling-"))
  const store = new SqliteStore(path.join(dir, "db.sqlite"))
  return {
    db: store.db,
    cleanup: () => {
      try {
        store.db.close()
      } catch {}
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    },
  }
}

test("R-096 sibling 互调（桂芬 → 德彪）被 a2a-gateway 拦下", () => {
  const { db, cleanup } = mkDb()
  try {
    const registry = new CallRegistry({ db })
    const worklistRegistry = new WorklistRegistry({ db })
    const rateLimiter = new MentionRateLimiter()

    // 1) root call: user → 仁勋（directTurn）
    const rootCallId = registry.openCall({
      issuerId: "user",
      convenerId: "user",
      replyTo: "claude:黄仁勋",
      sessionGroupId: "sg-1",
      deadlineAt: FUTURE,
    })

    // 2) 仁勋第一棒：派 [@桂芬][@德彪]，创建两条 child call
    const callGuifen = registry.openCall({
      parentCallId: rootCallId,
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "claude:黄仁勋",
      sessionGroupId: "sg-1",
      deadlineAt: FUTURE,
    })
    registry.openCall({
      parentCallId: rootCallId,
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "claude:黄仁勋",
      sessionGroupId: "sg-1",
      deadlineAt: FUTURE,
    })

    // 3) 仁勋的 root worklist：parentCallId = rootCallId, items = [桂芬, 德彪]
    worklistRegistry.register({
      parentWorklistId: null,
      parentCallId: rootCallId,
      rootCallId,
      sessionGroupId: "sg-1",
      items: [
        { alias: "桂芬", status: "pending" },
        { alias: "范德彪", status: "pending" },
      ],
    })

    // 4) 桂芬 reply 写 [Call: @德彪 工程视角] —— assistant role
    const result = planBetaDispatch(
      { db, registry, rateLimiter, aliases, worklistRegistry },
      {
        sourceAgentId: "桂芬",
        sourceReplyTo: "gemini:桂芬",
        messageId: "msg-桂芬-reply-1",
        content: "我帮你看看 [Call: @范德彪 工程视角参考]",
        sessionGroupId: "sg-1",
        parentCallId: callGuifen,
        sourceRole: "assistant",
      },
    )

    assert.equal(result.dispatched.length, 0, "sibling 互调不应派发")
    assert.equal(result.blocked.length, 1, "应被 blocked 一次")
    assert.equal(result.blocked[0]?.reason, "sibling-cross-call")
    assert.equal(result.blocked[0]?.mention.alias, "范德彪")
  } finally {
    cleanup()
  }
})

test("反向接力 child → parent（德彪 → 仁勋）不被 sibling-guard 拦", () => {
  const { db, cleanup } = mkDb()
  try {
    const registry = new CallRegistry({ db })
    const worklistRegistry = new WorklistRegistry({ db })
    const rateLimiter = new MentionRateLimiter()

    // root: user → 仁勋
    const rootCallId = registry.openCall({
      issuerId: "user",
      convenerId: "user",
      replyTo: "claude:黄仁勋",
      sessionGroupId: "sg-1",
      deadlineAt: FUTURE,
    })
    // 仁勋 → 桂芬
    const callGuifen = registry.openCall({
      parentCallId: rootCallId,
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "claude:黄仁勋",
      sessionGroupId: "sg-1",
      deadlineAt: FUTURE,
    })
    // 桂芬 → 德彪（嵌套：桂芬作为 issuer 派出）
    const callDebiao = registry.openCall({
      parentCallId: callGuifen,
      issuerId: "桂芬",
      convenerId: "桂芬",
      replyTo: "gemini:桂芬",
      sessionGroupId: "sg-1",
      deadlineAt: FUTURE,
    })

    // 桂芬的 worklist: items=[德彪]（桂芬派出去的 fan-out）
    worklistRegistry.register({
      parentWorklistId: null,
      parentCallId: callGuifen,
      rootCallId,
      sessionGroupId: "sg-1",
      items: [{ alias: "范德彪", status: "pending" }],
    })

    // 德彪 reply 写 [Call: @黄仁勋 重新 review] —— 反向回 grandparent
    const result = planBetaDispatch(
      { db, registry, rateLimiter, aliases, worklistRegistry },
      {
        sourceAgentId: "范德彪",
        sourceReplyTo: "codex:范德彪",
        messageId: "msg-德彪-reply-1",
        content: "[Call: @黄仁勋 反向交回]",
        sessionGroupId: "sg-1",
        parentCallId: callDebiao,
        sourceRole: "assistant",
      },
    )

    // 仁勋 alias = 黄仁勋 ∉ 桂芬 worklist items=[德彪] → 不算 sibling 互调
    assert.equal(
      result.blocked.filter((b) => b.reason === "sibling-cross-call").length,
      0,
      "反向接力不应被 sibling-guard 拦",
    )
  } finally {
    cleanup()
  }
})

test("缺 worklistRegistry deps 时 sibling-guard 静默放行（向后兼容）", () => {
  const { db, cleanup } = mkDb()
  try {
    const registry = new CallRegistry({ db })
    const rateLimiter = new MentionRateLimiter()

    const rootCallId = registry.openCall({
      issuerId: "user",
      convenerId: "user",
      replyTo: "claude:黄仁勋",
      sessionGroupId: "sg-1",
      deadlineAt: FUTURE,
    })
    const callGuifen = registry.openCall({
      parentCallId: rootCallId,
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "claude:黄仁勋",
      sessionGroupId: "sg-1",
      deadlineAt: FUTURE,
    })

    const result = planBetaDispatch(
      { db, registry, rateLimiter, aliases }, // 注意：没传 worklistRegistry
      {
        sourceAgentId: "桂芬",
        sourceReplyTo: "gemini:桂芬",
        messageId: "msg-no-wl",
        content: "[Call: @范德彪 看下]",
        sessionGroupId: "sg-1",
        parentCallId: callGuifen,
        sourceRole: "assistant",
      },
    )

    // 缺 deps → guard 不动 → 派发照常
    assert.equal(result.blocked.filter((b) => b.reason === "sibling-cross-call").length, 0)
    assert.equal(result.dispatched.length, 1)
  } finally {
    cleanup()
  }
})
