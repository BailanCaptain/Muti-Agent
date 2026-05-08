/**
 * F026-P3 Task9 · Scenario 3 · cold-target 100 条长对话集成测试。
 *
 * AC（spec §场景3）：
 * - cold-target burst 注入仅在三连 AND 命中（nativeSession=null + threadMemory=null + previousDigest=null）
 * - user @ 与 A2A @ 两条路径同等覆盖
 * - 100 条 fixture（前 88 紧密、gap 60min、后 12 紧密）→ burst 命中 12 条 + tombstone 标识 88 条
 * - 下游 prompt content 含 [Burst]+[Tombstone]，无需主动调 MCP 即可看主线
 */

import assert from "node:assert/strict"
import test from "node:test"
import { assemblePrompt } from "../../orchestrator/context-assembler"
import { POLICY_FULL } from "../../orchestrator/context-policy"
import type { ContextMessage } from "../../orchestrator/context-snapshot"
import { tryBuildColdTargetBurst } from "../../services/message-service"

const BASE_TS = new Date("2026-04-25T00:00:00.000Z").getTime()

function build100MessagesWithLateBurst(): ContextMessage[] {
  const msgs: ContextMessage[] = []
  // 88 条紧密（每条间隔 60 秒），分散在 88 分钟
  for (let i = 0; i < 88; i++) {
    msgs.push({
      id: `msg-${i + 1}`,
      role: i % 3 === 0 ? "user" : "assistant",
      agentId: i % 3 === 0 ? "user" : i % 2 === 0 ? "黄仁勋" : "范德彪",
      content: `老话题 ${i + 1}：F012 前端硬化讨论 review feedback iteration`,
      createdAt: new Date(BASE_TS + i * 60_000).toISOString(),
    })
  }
  // 60 分钟 gap
  const tailStart = 88 * 60_000 + 60 * 60_000
  // 后 12 条紧密
  for (let i = 0; i < 12; i++) {
    msgs.push({
      id: `msg-${88 + i + 1}`,
      role: i === 0 ? "user" : "assistant",
      agentId: i === 0 ? "user" : i % 2 === 1 ? "桂芬" : "黄仁勋",
      content: `新话题 ${i + 1}：诗歌评价 韵律 意境 风格`,
      createdAt: new Date(BASE_TS + tailStart + i * 60_000).toISOString(),
    })
  }
  return msgs
}

const ROOM_100 = build100MessagesWithLateBurst()

// ── tryBuildColdTargetBurst (helper 集成) ───────────────────────────

test("F026-P3 scenario-3 · cold (三连 AND 命中) → burst+tombstone 都生成", () => {
  const r = tryBuildColdTargetBurst({
    nativeSessionId: null,
    threadMemoryEmpty: true,
    previousDigestEmpty: true,
    roomSnapshot: ROOM_100,
  })

  assert.ok(r, "cold-target 必须返回 burst")
  assert.match(r!.burstSection, /\[Burst — 最近 \d+ 条相关讨论\]/)
  assert.match(r!.burstSection, /新话题/, "burst 应含 tail 12 条 (新话题)")
  assert.ok(!r!.burstSection.includes("老话题"), "burst 不该包含 head 88 条 (老话题)")
  assert.ok(r!.tombstoneSection, "tombstone 不该 null（88 条 omitted）")
  assert.match(r!.tombstoneSection!, /\[Tombstone\] 此前省略 \d+ 条/)
  assert.match(r!.tombstoneSection!, /MCP get_room_context, msg_id=msg-1~msg-/)
})

test("F026-P3 scenario-3 · hot (nativeSession 非 null) → undefined", () => {
  const r = tryBuildColdTargetBurst({
    nativeSessionId: "live-session-123",
    threadMemoryEmpty: true,
    previousDigestEmpty: true,
    roomSnapshot: ROOM_100,
  })
  assert.equal(r, undefined)
})

test("F026-P3 scenario-3 · hot (threadMemory 非空) → undefined", () => {
  const r = tryBuildColdTargetBurst({
    nativeSessionId: null,
    threadMemoryEmpty: false,
    previousDigestEmpty: true,
    roomSnapshot: ROOM_100,
  })
  assert.equal(r, undefined)
})

test("F026-P3 scenario-3 · hot (previousDigest 非空) → undefined", () => {
  const r = tryBuildColdTargetBurst({
    nativeSessionId: null,
    threadMemoryEmpty: true,
    previousDigestEmpty: false,
    roomSnapshot: ROOM_100,
  })
  assert.equal(r, undefined)
})

test("F026-P3 scenario-3 · empty room → undefined（无对话池就无 burst）", () => {
  const r = tryBuildColdTargetBurst({
    nativeSessionId: null,
    threadMemoryEmpty: true,
    previousDigestEmpty: true,
    roomSnapshot: [],
  })
  assert.equal(r, undefined)
})

// ── 端到端：tryBuildColdTargetBurst → assemblePrompt → prompt content ───

test("F026-P3 scenario-3 · A2A 路径：黄仁勋 → 冷桂芬 → prompt 含 burst + tombstone", async () => {
  const coldBurst = tryBuildColdTargetBurst({
    nativeSessionId: null,
    threadMemoryEmpty: true,
    previousDigestEmpty: true,
    roomSnapshot: ROOM_100,
  })
  assert.ok(coldBurst)

  const result = await assemblePrompt(
    {
      provider: "claude",
      threadId: "t1",
      sessionGroupId: "sg1",
      nativeSessionId: null,
      policy: POLICY_FULL,
      task: "请评价这首诗",
      roomSnapshot: ROOM_100,
      sourceAlias: "黄仁勋",
      targetAlias: "桂芬",
      threadMemory: null,
      previousDigest: null,
      coldTargetBurst: coldBurst,
    },
    null,
  )

  assert.match(result.content, /\[Burst — 最近 \d+ 条相关讨论\]/)
  assert.match(result.content, /\[Tombstone\] 此前省略/)
  // burst 在 [A2A 协作请求] header 之前
  const burstIdx = result.content.indexOf("[Burst")
  const headerIdx = result.content.indexOf("[A2A 协作请求 from 黄仁勋]")
  assert.ok(burstIdx >= 0 && headerIdx > burstIdx)
  // 主线（"新话题"）下游能直接看到，无需调 MCP
  assert.match(result.content, /新话题/)
})

test("F026-P3 scenario-3 · user 路径：user @ 冷桂芬 → prompt 同样含 burst + tombstone", async () => {
  const coldBurst = tryBuildColdTargetBurst({
    nativeSessionId: null,
    threadMemoryEmpty: true,
    previousDigestEmpty: true,
    roomSnapshot: ROOM_100,
  })
  assert.ok(coldBurst)

  const result = await assemblePrompt(
    {
      provider: "claude",
      threadId: "t1",
      sessionGroupId: "sg1",
      nativeSessionId: null,
      policy: POLICY_FULL,
      task: "请评价这首诗",
      roomSnapshot: ROOM_100,
      sourceAlias: "user", // 关键：user 路径同等覆盖
      targetAlias: "桂芬",
      threadMemory: null,
      previousDigest: null,
      coldTargetBurst: coldBurst,
    },
    null,
  )

  assert.match(result.content, /\[Burst — 最近/)
  assert.match(result.content, /\[Tombstone\]/)
  // burst 在 [用户请求] header 之前
  const burstIdx = result.content.indexOf("[Burst")
  const headerIdx = result.content.indexOf("[用户请求]")
  assert.ok(burstIdx >= 0 && headerIdx > burstIdx, "user-mention 路径同等覆盖")
})
