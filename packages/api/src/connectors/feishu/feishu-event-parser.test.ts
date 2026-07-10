import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseFeishuMessageEvent } from "./feishu-event-parser"

/**
 * F040 T4：把飞书 im.message.receive_v1 的 WS handler data（官方类型 index.d.ts:298718，
 * 无 header envelope）解析成 InboundChannelMessage | { skip }。
 * chat_kind 只做标注（p2p/group），拒绝由 gateway 门做；非 text / 破损 content / 缺 open_id → skip。
 */

function p2pTextEvent(overrides: Record<string, unknown> = {}) {
  return {
    sender: { sender_id: { open_id: "ou_sun" }, sender_type: "user" },
    message: {
      message_id: "om_msg_1",
      chat_id: "oc_chat_1",
      chat_type: "p2p",
      message_type: "text",
      create_time: "1720000000000",
      content: JSON.stringify({ text: "你好范德彪" }),
    },
    ...overrides,
  }
}

describe("parseFeishuMessageEvent", () => {
  it("p2p text → InboundChannelMessage（字段全提取，chatKind=p2p）", () => {
    const r = parseFeishuMessageEvent(p2pTextEvent())
    assert.ok(!("skip" in r))
    if ("skip" in r) return
    assert.equal(r.connectorId, "feishu")
    assert.equal(r.externalChatId, "oc_chat_1")
    assert.equal(r.externalMessageId, "om_msg_1")
    assert.equal(r.senderOpenId, "ou_sun")
    assert.equal(r.chatKind, "p2p")
    assert.equal(r.text, "你好范德彪")
  })

  it("group text → chatKind=group（parser 只标注不拒）", () => {
    const ev = p2pTextEvent()
    ;(ev.message as Record<string, unknown>).chat_type = "group"
    const r = parseFeishuMessageEvent(ev)
    assert.ok(!("skip" in r))
    if ("skip" in r) return
    assert.equal(r.chatKind, "group")
  })

  it("text/image/file 之外的类型 → skip（P3 起 image/file 是合法媒体，见媒体 describe）", () => {
    const ev = p2pTextEvent()
    ;(ev.message as Record<string, unknown>).message_type = "sticker"
    ;(ev.message as Record<string, unknown>).content = JSON.stringify({ file_key: "stk_x" })
    const r = parseFeishuMessageEvent(ev)
    assert.ok("skip" in r)
  })

  it("content JSON 破损 → skip 不抛", () => {
    const ev = p2pTextEvent()
    ;(ev.message as Record<string, unknown>).content = "{not json"
    const r = parseFeishuMessageEvent(ev)
    assert.ok("skip" in r)
  })

  it("text 字段缺失/非字符串 → skip", () => {
    const ev = p2pTextEvent()
    ;(ev.message as Record<string, unknown>).content = JSON.stringify({ notText: 1 })
    assert.ok("skip" in parseFeishuMessageEvent(ev))
  })

  it("缺 sender open_id → skip（无法归因/鉴权）", () => {
    const ev = p2pTextEvent({ sender: { sender_id: {}, sender_type: "user" } })
    assert.ok("skip" in parseFeishuMessageEvent(ev))
  })

  it("缺 message 结构 → skip 不抛", () => {
    assert.ok("skip" in parseFeishuMessageEvent({ sender: { sender_id: { open_id: "x" } } }))
    assert.ok("skip" in parseFeishuMessageEvent(null))
    assert.ok("skip" in parseFeishuMessageEvent({}))
  })

  it("未知 chat_type → skip（不是 p2p/group 一律不认）", () => {
    const ev = p2pTextEvent()
    ;(ev.message as Record<string, unknown>).chat_type = "topic"
    assert.ok("skip" in parseFeishuMessageEvent(ev))
  })

  it("P3-2：正文保留原样（含前后空白/换行），仅纯空白 → skip", () => {
    // 德彪 r1 P3-2：trim 只判空，不改注入正文
    const ev = p2pTextEvent()
    ;(ev.message as Record<string, unknown>).content = JSON.stringify({ text: "  在吗\n第二行  " })
    const r = parseFeishuMessageEvent(ev)
    assert.ok(!("skip" in r))
    if ("skip" in r) return
    assert.equal(r.text, "  在吗\n第二行  ", "正文原样保留")

    const ev2 = p2pTextEvent()
    ;(ev2.message as Record<string, unknown>).content = JSON.stringify({ text: "   " })
    assert.ok("skip" in parseFeishuMessageEvent(ev2), "纯空白 skip")
  })
})

/**
 * F040 Phase 2 T5：群 mentions 解析（@bot 判定 + 占位符处理）。
 * fixture 按官方 im.message.receive_v1 schema 手写（mentions[].key/id.open_id/name）；
 * 07-04 真机 raw event 已复核一致（见文末 T4 真机 fixture 块）。
 */

const BOT = "ou_bot_self"

function groupTextEvent(text: string, mentions: unknown[]) {
  return {
    sender: { sender_id: { open_id: "ou_li" }, sender_type: "user" },
    message: {
      message_id: `om_${Math.random().toString(36).slice(2)}`,
      chat_id: "oc_g1",
      chat_type: "group",
      message_type: "text",
      create_time: "1720000000000",
      content: JSON.stringify({ text }),
      mentions,
    },
  }
}

describe("parseFeishuMessageEvent · 群 mentions（T5）", () => {
  it("@bot → mentionsBot=true，bot 占位符剥除且行首保留（@bot @范德彪 混排样例）", () => {
    const r = parseFeishuMessageEvent(
      groupTextEvent("@_user_1 @范德彪 在吗", [
        { key: "@_user_1", id: { open_id: BOT }, name: "multi-agent" },
      ]),
      { botOpenId: BOT },
    )
    assert.ok(!("skip" in r))
    if ("skip" in r) return
    assert.equal(r.mentionsBot, true)
    assert.equal(r.text, "@范德彪 在吗", "bot 占位剥除后 @范德彪 必须保行首")
  })

  it("未 @bot（@ 的是别人）→ mentionsBot=false", () => {
    const r = parseFeishuMessageEvent(
      groupTextEvent("@_user_1 你看下", [
        { key: "@_user_1", id: { open_id: "ou_wang" }, name: "老王" },
      ]),
      { botOpenId: BOT },
    )
    assert.ok(!("skip" in r))
    if ("skip" in r) return
    assert.equal(r.mentionsBot, false)
  })

  it("botOpenId 未注入（boot 取失败）→ mentionsBot 恒 false（fail-closed）", () => {
    const r = parseFeishuMessageEvent(
      groupTextEvent("@_user_1 test", [
        { key: "@_user_1", id: { open_id: BOT }, name: "multi-agent" },
      ]),
      {},
    )
    assert.ok(!("skip" in r))
    if ("skip" in r) return
    assert.equal(r.mentionsBot, false)
  })

  it("非 bot 人名占位符 → 替换为去 @ 展示名（防改名注入派发面）", () => {
    const r = parseFeishuMessageEvent(
      groupTextEvent("@_user_1 @_user_2 帮他看看", [
        { key: "@_user_1", id: { open_id: BOT }, name: "multi-agent" },
        { key: "@_user_2", id: { open_id: "ou_evil" }, name: "@范德彪" },
      ]),
      { botOpenId: BOT },
    )
    assert.ok(!("skip" in r))
    if ("skip" in r) return
    assert.equal(r.mentionsBot, true)
    assert.equal(
      r.text,
      "范德彪 帮他看看",
      "人名渲染必须去 @：user 路径 anywhere 匹配下，带 @ 的改名就是免白名单派发注入",
    )
  })

  it("纯 @bot 无正文 → skip（不注入空消息）", () => {
    const r = parseFeishuMessageEvent(
      groupTextEvent("@_user_1 ", [{ key: "@_user_1", id: { open_id: BOT }, name: "bot" }]),
      { botOpenId: BOT },
    )
    assert.ok("skip" in r)
  })

  it("p2p 零回归：不带 opts 仍 mentionsBot=true 文本原样", () => {
    const r = parseFeishuMessageEvent(p2pTextEvent())
    assert.ok(!("skip" in r))
    if ("skip" in r) return
    assert.equal(r.mentionsBot, true)
    assert.equal(r.text, "你好范德彪")
  })
})

/**
 * F040 T4 真机 fixture：2026-07-04 预览 FEISHU_DEBUG_EVENTS=1 抓到的 im.message.receive_v1
 * 原始 WS handler data（小孙在测试群发「@multi-agent 测试」），逐字冻结。
 * 校准结论：mentions[].key="@_user_N" / id.open_id / name 与文档 schema 假设一致；
 * 真机多出 mentioned_type:"bot" 字段（本 parser 不依赖——按 open_id 精确比对，多 bot 群里
 * @别家 bot 不会误判成 @我们）。bot open_id 已与 bot/v3/info 实测相等（探针 MATCH=true）。
 */
const REAL_GROUP_EVENT = {
  schema: "2.0",
  event_id: "0c784388dc55f805efab0352df29b77f",
  token: "",
  create_time: "1783157559472",
  event_type: "im.message.receive_v1",
  tenant_key: "192d0f6043591c9e",
  app_id: "cli_aac22e3d98a21cc9",
  message: {
    chat_id: "oc_23e616f6cbff9a586b51239fa1f751c9",
    chat_type: "group",
    content: '{"text":"@_user_1 测试"}',
    create_time: "1783157559133",
    mentions: [
      {
        id: {
          open_id: "ou_e02e7f381ee955c0754b0fe4180109a0",
          union_id: "on_55ff554917322ff0a6059e6ebf9ffe2a",
          user_id: null,
        },
        key: "@_user_1",
        mentioned_type: "bot",
        name: "multi-agent",
        tenant_key: "192d0f6043591c9e",
      },
    ],
    message_id: "om_x100b6bb97dbd6534c2115e05c27b59a",
    message_type: "text",
    update_time: "1783157559133",
  },
  sender: {
    sender_id: {
      open_id: "ou_78b3e44691488af9ddc439388daed685",
      union_id: "on_eae61534ed26865aa1330f3db9963cd4",
      user_id: null,
    },
    sender_type: "user",
    tenant_key: "192d0f6043591c9e",
  },
}

const REAL_BOT_OPEN_ID = "ou_e02e7f381ee955c0754b0fe4180109a0"

describe("parseFeishuMessageEvent · T4 真机 fixture（07-04 抓包逐字）", () => {
  it("真机群事件 + 正确 botOpenId → 全字段提取 + mentionsBot=true + 占位符剥净", () => {
    const r = parseFeishuMessageEvent(REAL_GROUP_EVENT, { botOpenId: REAL_BOT_OPEN_ID })
    assert.ok(!("skip" in r))
    if ("skip" in r) return
    assert.equal(r.connectorId, "feishu")
    assert.equal(r.externalChatId, "oc_23e616f6cbff9a586b51239fa1f751c9")
    assert.equal(r.externalMessageId, "om_x100b6bb97dbd6534c2115e05c27b59a")
    assert.equal(r.senderOpenId, "ou_78b3e44691488af9ddc439388daed685")
    assert.equal(r.chatKind, "group")
    assert.equal(r.mentionsBot, true)
    assert.equal(r.text, "测试", "bot 占位符整体剥除 + 首行 trimStart")
  })

  it("真机群事件 + botOpenId 缺失 → mentionsBot=false（fail-closed 静默忽略分支）", () => {
    const r = parseFeishuMessageEvent(REAL_GROUP_EVENT, { botOpenId: null })
    assert.ok(!("skip" in r))
    if ("skip" in r) return
    assert.equal(r.mentionsBot, false)
  })

  it("真机群事件 + 错误 botOpenId → mentionsBot=false（open_id 精确比对不靠 mentioned_type）", () => {
    const r = parseFeishuMessageEvent(REAL_GROUP_EVENT, { botOpenId: "ou_some_other_bot" })
    assert.ok(!("skip" in r))
    if ("skip" in r) return
    assert.equal(r.mentionsBot, false)
  })
})

describe("parseFeishuMessageEvent · 媒体消息（F040 P3 AC16）", () => {
  it("p2p image → media{kind:image,key} + text 标签 + mentionsBot=true", () => {
    const r = parseFeishuMessageEvent(
      p2pTextEvent({
        message: {
          message_id: "om_img_1",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "image",
          content: JSON.stringify({ image_key: "img_v3_abc" }),
        },
      }),
    )
    assert.ok(!("skip" in r))
    if ("skip" in r) return
    assert.equal(r.text, "[图片]")
    assert.equal(r.mentionsBot, true)
    assert.deepEqual(r.media, { kind: "image", key: "img_v3_abc", name: "图片" })
  })

  it("p2p file → media{kind:file,key,name=file_name} + text 带名字", () => {
    const r = parseFeishuMessageEvent(
      p2pTextEvent({
        message: {
          message_id: "om_file_1",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "file",
          content: JSON.stringify({ file_key: "file_v3_xyz", file_name: "周报.pdf" }),
        },
      }),
    )
    assert.ok(!("skip" in r))
    if ("skip" in r) return
    assert.equal(r.text, "[文件] 周报.pdf")
    assert.deepEqual(r.media, { kind: "file", key: "file_v3_xyz", name: "周报.pdf" })
  })

  it("群裸图（无 mentions）→ mentionsBot=false（落「未 @」忽略分支，fail-closed 同文本门）", () => {
    const r = parseFeishuMessageEvent(
      p2pTextEvent({
        message: {
          message_id: "om_img_2",
          chat_id: "oc_group_1",
          chat_type: "group",
          message_type: "image",
          content: JSON.stringify({ image_key: "img_v3_g" }),
        },
      }),
      { botOpenId: "ou_bot" },
    )
    assert.ok(!("skip" in r))
    if ("skip" in r) return
    assert.equal(r.chatKind, "group")
    assert.equal(r.mentionsBot, false)
    assert.equal(r.media?.kind, "image")
  })

  it("媒体 content 破损 / 缺 key → skip（不击穿）", () => {
    const broken = parseFeishuMessageEvent(
      p2pTextEvent({
        message: {
          message_id: "om_img_3",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "image",
          content: "not-json",
        },
      }),
    )
    assert.ok("skip" in broken)
    const noKey = parseFeishuMessageEvent(
      p2pTextEvent({
        message: {
          message_id: "om_img_4",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "image",
          content: JSON.stringify({}),
        },
      }),
    )
    assert.ok("skip" in noKey)
  })

  it("其余 message_type（audio/sticker）仍 skip", () => {
    const r = parseFeishuMessageEvent(
      p2pTextEvent({
        message: {
          message_id: "om_a_1",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "audio",
          content: "{}",
        },
      }),
    )
    assert.ok("skip" in r)
  })
})
