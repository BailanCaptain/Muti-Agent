/**
 * F026 · server 启动路径 A2A Gateway hook 安装契约
 *
 * 这组测试定义修复契约：
 *   (A) `installA2AGateway(dispatch, deps)` 装完后，enqueuePublicMentions
 *       返回的 QueueEntry 必有 `callId` 且 a2a_calls 表有对应记录。
 *   (B) 不调用 installA2AGateway 时（baseline / 回归标志），dispatch 退回旧路径
 *       —— 这条就是 review P1-1 bug 的 regression anchor。
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import type { Provider } from "@multi-agent/shared"

import { SqliteStore } from "../../db/sqlite"
import { installA2AGateway } from "../a2a-gateway-bootstrap"
import { DispatchOrchestrator } from "../dispatch"

const aliases = { claude: "黄仁勋", codex: "范德彪", gemini: "桂芬" } as const

function createSessionsStub() {
  const threads = [
    {
      id: "thread-codex",
      sessionGroupId: "group-1",
      provider: "codex" as Provider,
      alias: "范德彪",
    },
    {
      id: "thread-claude",
      sessionGroupId: "group-1",
      provider: "claude" as Provider,
      alias: "黄仁勋",
    },
    {
      id: "thread-gemini",
      sessionGroupId: "group-1",
      provider: "gemini" as Provider,
      alias: "桂芬",
    },
  ]
  return {
    findThread: (id: string) => threads.find((t) => t.id === id) ?? null,
    findThreadByGroupAndProvider: (sg: string, p: string) =>
      threads.find((t) => t.sessionGroupId === sg && t.provider === p) ?? null,
    listGroupThreads: (sg: string) => threads.filter((t) => t.sessionGroupId === sg),
  }
}

// noop wrapper kept after F026 flag removal — body runs unchanged so existing
// tests need only structural rename (test name + comments). Drop next pass.
function withFlag<T>(_on: boolean, fn: () => T): T {
  return fn()
}

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-bootstrap-"))
  const store = new SqliteStore(path.join(dir, "db.sqlite"))
  return {
    store,
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

test("P1-1 修复契约 (A): installA2AGateway 装完后 flag-on 真实走 CallRegistry + a2a_calls 有记录", () => {
  const { store, cleanup } = mkStore()
  try {
    const dispatch = new DispatchOrchestrator(createSessionsStub() as never, aliases)
    installA2AGateway(dispatch, { db: store.db, aliases })
    dispatch.registerUserRoot("root-A", "group-1")

    withFlag(true, () => {
      const result = dispatch.enqueuePublicMentions({
        messageId: "msg-A",
        sessionGroupId: "group-1",
        sourceProvider: "codex",
        sourceAlias: "范德彪",
        rootMessageId: "root-A",
        content: "[Call: @黄仁勋 review PR]",
      })
      assert.equal(result.queued.length, 1, "one entry queued")
      const entry = result.queued[0]!
      assert.equal(entry.to.provider, "claude")
      assert.ok(entry.callId, "QueueEntry must carry callId from gateway hook")

      const row = store.db
        .prepare("SELECT call_id, issuer_id, status FROM a2a_calls WHERE call_id = ?")
        .get(entry.callId!) as { call_id: string; issuer_id: string; status: string } | undefined
      assert.ok(row, "a2a_calls row must exist (CallRegistry.openCall ran)")
      assert.equal(row!.call_id, entry.callId)
      assert.equal(row!.issuer_id, "范德彪")
      assert.equal(row!.status, "pending")
    })
  } finally {
    cleanup()
  }
})

test("P1-1 regression anchor (B): 不装 hook 时 flag-on 静默退回旧路径 — 这就是 review 发现的 bug 基线", () => {
  const { store, cleanup } = mkStore()
  try {
    const dispatch = new DispatchOrchestrator(createSessionsStub() as never, aliases)
    // 故意不调 installA2AGateway — 复现 bug 基线
    dispatch.registerUserRoot("root-B", "group-1")

    withFlag(true, () => {
      const result = dispatch.enqueuePublicMentions({
        messageId: "msg-B",
        sessionGroupId: "group-1",
        sourceProvider: "codex",
        sourceAlias: "范德彪",
        rootMessageId: "root-B",
        content: "[Call: @黄仁勋 看下]",
        matchMode: "anywhere",
      })
      assert.equal(result.queued.length, 1)
      assert.equal(result.queued[0]!.callId, undefined, "no hook → no callId")
      const count = (store.db.prepare("SELECT COUNT(*) AS n FROM a2a_calls").get() as { n: number })
        .n
      assert.equal(count, 0, "no hook → a2a_calls untouched")
    })
  } finally {
    cleanup()
  }
})

test("F026-P5 follow-up · parent_call_id 桥接：bindInvocation 后 child mention 写回 parent_call_id (acceptance-guardian R-204 红灯)", () => {
  // Red 现状（acceptance-guardian 03:10 报告）：
  //   a2a-gateway-bootstrap.ts:73-76 deferred TODO `parentCallId: undefined` 写死，
  //   生产 DB 240/240 a2a_calls.parent_call_id == NULL —— call tree 全 root,
  //   下游 P5 视觉原语（Visual Silo / 折叠群组 / 结论卡片）依赖 sibling 关系全部熄灯,
  //   R-066 discussion.concluded 因「同 parent ≥2 sibling 终态」永远不满足而 0 fired。
  //
  // 修复契约：父 invocation 派发 mention 时，bindInvocation 时存入的 dispatchedCallId
  //   通过 hook 桥接到 a2a-gateway openCall.parentCallId，于是 child a2a_calls 行
  //   parent_call_id == 父 callId（不再 NULL）。
  const { store, cleanup } = mkStore()
  try {
    const dispatch = new DispatchOrchestrator(createSessionsStub() as never, aliases)
    installA2AGateway(dispatch, { db: store.db, aliases })
    dispatch.registerUserRoot("root-E", "group-1")

    withFlag(true, () => {
      // 第一跳：user @范德彪
      const first = dispatch.enqueuePublicMentions({
        messageId: "msg-E1",
        sessionGroupId: "group-1",
        sourceProvider: "claude",
        sourceAlias: "user",
        rootMessageId: "root-E",
        content: "@范德彪 帮我 review",
      })
      assert.equal(first.queued.length, 1, "first dispatch enqueued")
      const parentCallId = first.queued[0]!.callId
      assert.ok(parentCallId, "parent dispatch must produce callId")

      // 范德彪启动 invocation 处理 parentCallId（模拟 message-service runThreadTurn 的 bindInvocation）
      const invocationId = "inv-codex-E"
      dispatch.bindInvocation(invocationId, {
        rootMessageId: "root-E",
        sessionGroupId: "group-1",
        sourceProvider: "codex",
        parentInvocationId: null,
        dispatchedCallId: parentCallId,
      })

      // 第二跳：范德彪在 invocation 内 [Call: @桂芬]
      const second = dispatch.enqueuePublicMentions({
        messageId: "msg-E2",
        sessionGroupId: "group-1",
        sourceProvider: "codex",
        sourceAlias: "范德彪",
        rootMessageId: "root-E",
        content: "[Call: @桂芬 看下视觉]",
        parentInvocationId: invocationId,
      })
      assert.equal(second.queued.length, 1, "second dispatch enqueued")
      const childCallId = second.queued[0]!.callId
      assert.ok(childCallId, "child dispatch must produce callId")

      // 关键断言：child a2a_calls.parent_call_id 必须 == 父 callId（不是 NULL）
      const childRow = store.db
        .prepare("SELECT call_id, parent_call_id, root_call_id FROM a2a_calls WHERE call_id = ?")
        .get(childCallId!) as
        | { call_id: string; parent_call_id: string | null; root_call_id: string }
        | undefined
      assert.ok(childRow, "child a2a_calls row exists")
      assert.equal(
        childRow!.parent_call_id,
        parentCallId,
        "child parent_call_id must bridge from parent dispatchedCallId (acceptance-guardian R-204 fix)",
      )
      assert.equal(
        childRow!.root_call_id,
        parentCallId,
        "child root_call_id traces back to root parent",
      )
    })
  } finally {
    cleanup()
  }
})

test("R-204 follow-up · 生产路径时序 release-before-enqueue：显式 parentCallId 必须接通 call tree（DB 0/275 实证 bug）", () => {
  // Bug 证据 (worktree DB 实测 2026-05-01)：a2a_calls.parent_call_id 全表 0/275 接通，
  //   即使 R-204 commit 4614c13 自称 "桥接接通" 也没生效。根因：message-service.ts:1685
  //   `releaseInvocation` 早于 line 1892 `enqueuePublicMentions` 调用 200 行，
  //   此时 `invocationContexts.get(parentInvocationId)` 已被 delete → 反查 `dispatchedCallId`
  //   永远 null → 子 a2a_calls 全 orphan root。
  //
  // 修复契约：enqueuePublicMentions 必须接受显式 `parentCallId` param，
  //   caller (final flow / return-path) 传 runThreadTurn options.dispatchedCallId 直传，
  //   不依赖 in-memory invocationContexts 反查（绕开 release 时序敏感）。
  const { store, cleanup } = mkStore()
  try {
    const dispatch = new DispatchOrchestrator(createSessionsStub() as never, aliases)
    installA2AGateway(dispatch, { db: store.db, aliases })
    dispatch.registerUserRoot("root-F", "group-1")

    withFlag(true, () => {
      // 第一跳：user @范德彪
      const first = dispatch.enqueuePublicMentions({
        messageId: "msg-F1",
        sessionGroupId: "group-1",
        sourceProvider: "claude",
        sourceAlias: "user",
        rootMessageId: "root-F",
        content: "@范德彪 帮我 review",
      })
      const parentCallId = first.queued[0]!.callId
      assert.ok(parentCallId, "first dispatch must produce callId")

      // 范德彪 invocation 跑完 final → release（模拟 message-service.ts:1685 时序）
      const invocationId = "inv-codex-F"
      dispatch.bindInvocation(invocationId, {
        rootMessageId: "root-F",
        sessionGroupId: "group-1",
        sourceProvider: "codex",
        parentInvocationId: null,
        dispatchedCallId: parentCallId,
      })
      dispatch.releaseInvocation(invocationId) // ← 关键：context 已被 delete

      // 第二跳：final flow 在 release 之后调 enqueuePublicMentions，
      // 直接显式传 parentCallId（绕过反查）
      const second = dispatch.enqueuePublicMentions({
        messageId: "msg-F2",
        sessionGroupId: "group-1",
        sourceProvider: "codex",
        sourceAlias: "范德彪",
        rootMessageId: "root-F",
        content: "[Call: @桂芬 看下视觉]",
        parentInvocationId: invocationId,
        parentCallId, // ← Red→Green 关键 param：caller 显式传，绕开 in-memory 反查
      })
      const childCallId = second.queued[0]!.callId
      assert.ok(childCallId, "child dispatch must produce callId after parent release")

      const childRow = store.db
        .prepare("SELECT call_id, parent_call_id, root_call_id FROM a2a_calls WHERE call_id = ?")
        .get(childCallId!) as
        | { call_id: string; parent_call_id: string | null; root_call_id: string }
        | undefined
      assert.ok(childRow, "child a2a_calls row exists after parent release")
      assert.equal(
        childRow!.parent_call_id,
        parentCallId,
        "explicit parentCallId param must bridge call tree even after parent release (R-204 follow-up)",
      )
    })
  } finally {
    cleanup()
  }
})

test("R-204 follow-up · 多跳 call tree 护栏：链式 user→A→B→C 全 release-then-enqueue 后 parent_call_id 不能 orphan", () => {
  // 这条护栏对应小孙 2026-05-01 的「verification gap 累计第 4 次」反馈：
  //   commit claim 修了，DB 0/275 实证没生效。本测试断言「凡 issuer != user 的
  //   非 root call,parent_call_id 必须非空」—— 把生产期望写进单测,挡住第 5 次塌方。
  const { store, cleanup } = mkStore()
  try {
    const dispatch = new DispatchOrchestrator(createSessionsStub() as never, aliases)
    installA2AGateway(dispatch, { db: store.db, aliases })
    dispatch.registerUserRoot("root-G", "group-1")

    withFlag(true, () => {
      // Hop 1: user @范德彪
      const hop1 = dispatch.enqueuePublicMentions({
        messageId: "msg-G1",
        sessionGroupId: "group-1",
        sourceProvider: "claude",
        sourceAlias: "user",
        rootMessageId: "root-G",
        content: "@范德彪 看一眼",
      })
      const callA = hop1.queued[0]!.callId!

      // 范德彪 invocation 跑完 → release（生产时序）
      dispatch.bindInvocation("inv-codex-G", {
        rootMessageId: "root-G",
        sessionGroupId: "group-1",
        sourceProvider: "codex",
        parentInvocationId: null,
        dispatchedCallId: callA,
      })
      dispatch.releaseInvocation("inv-codex-G")

      // Hop 2: 范德彪 [Call: @桂芬] —— release 后调 enqueue,显式传 parentCallId
      const hop2 = dispatch.enqueuePublicMentions({
        messageId: "msg-G2",
        sessionGroupId: "group-1",
        sourceProvider: "codex",
        sourceAlias: "范德彪",
        rootMessageId: "root-G",
        content: "[Call: @桂芬 同步意见]",
        parentInvocationId: "inv-codex-G",
        parentCallId: callA,
      })
      const callB = hop2.queued[0]!.callId!

      // 桂芬 invocation 跑完 → release
      dispatch.bindInvocation("inv-gemini-G", {
        rootMessageId: "root-G",
        sessionGroupId: "group-1",
        sourceProvider: "gemini",
        parentInvocationId: "inv-codex-G",
        dispatchedCallId: callB,
      })
      dispatch.releaseInvocation("inv-gemini-G")

      // Hop 3: 桂芬 [Call: @黄仁勋] —— 同样 release 后 enqueue
      const hop3 = dispatch.enqueuePublicMentions({
        messageId: "msg-G3",
        sessionGroupId: "group-1",
        sourceProvider: "gemini",
        sourceAlias: "桂芬",
        rootMessageId: "root-G",
        content: "[Call: @黄仁勋 收尾]",
        parentInvocationId: "inv-gemini-G",
        parentCallId: callB,
      })
      const callC = hop3.queued[0]!.callId!

      // 护栏断言：凡 issuer != user 的非 root call,parent_call_id 必须非空
      const orphans = store.db
        .prepare(
          "SELECT call_id, issuer_id, parent_call_id FROM a2a_calls " +
            "WHERE issuer_id != 'user' AND (parent_call_id IS NULL OR parent_call_id = '')",
        )
        .all() as Array<{ call_id: string; issuer_id: string; parent_call_id: string | null }>
      assert.equal(
        orphans.length,
        0,
        `production-path orphan guardrail: agent-issued calls must always have parent_call_id. Found ${orphans.length} orphans: ${JSON.stringify(orphans)}`,
      )

      // 链路完整性：A.parent=null, B.parent=A, C.parent=B, 全部 root_call_id=A
      const rows = store.db
        .prepare("SELECT call_id, parent_call_id, root_call_id FROM a2a_calls WHERE call_id IN (?,?,?)")
        .all(callA, callB, callC) as Array<{
        call_id: string
        parent_call_id: string | null
        root_call_id: string
      }>
      const byId = new Map(rows.map((r) => [r.call_id, r]))
      assert.equal(byId.get(callA)!.parent_call_id, null, "hop1 (user→A) is root")
      assert.equal(byId.get(callB)!.parent_call_id, callA, "hop2 (A→B) parent = callA")
      assert.equal(byId.get(callC)!.parent_call_id, callB, "hop3 (B→C) parent = callB")
      assert.equal(byId.get(callA)!.root_call_id, callA, "callA self-root")
      assert.equal(byId.get(callB)!.root_call_id, callA, "callB roots to callA")
      assert.equal(byId.get(callC)!.root_call_id, callA, "callC roots to callA")
    })
  } finally {
    cleanup()
  }
})

test("P1-1 gateway gray-zone surfaces as blockedByGateway (fail-closed preserved)", () => {
  const { store, cleanup } = mkStore()
  try {
    const dispatch = new DispatchOrchestrator(createSessionsStub() as never, aliases)
    installA2AGateway(dispatch, { db: store.db, aliases })
    dispatch.registerUserRoot("root-D", "group-1")

    withFlag(true, () => {
      // 代码块内 @ 应落到 gray-zone（mention-router L3），不入 dispatch
      const result = dispatch.enqueuePublicMentions({
        messageId: "msg-D",
        sessionGroupId: "group-1",
        sourceProvider: "codex",
        sourceAlias: "范德彪",
        rootMessageId: "root-D",
        content: "看这段代码:\n```\n// @黄仁勋 注释里的\n```\n无事。",
      })
      assert.equal(result.queued.length, 0, "code-block @ must not dispatch (fail-closed)")
    })
  } finally {
    cleanup()
  }
})
