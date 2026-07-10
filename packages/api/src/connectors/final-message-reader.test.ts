import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { SqliteStore } from "../db/sqlite"
import { readFinalMessageFromDb } from "./final-message-reader"

/**
 * r4 P3：provider→花名映射四路真表测试（claude/codex/gemini/无线程）。
 * gateway 出站测试的 fake 署名是定值，测不到 JOIN + PROVIDER_ALIASES 这层——
 * 这里用真 SqliteStore 建 threads/messages 验映射，防"德彪的话署成仁勋"。
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-fmr-"))
const store = new SqliteStore(path.join(tmpRoot, "db.sqlite"))
after(() => {
  store.db.close()
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {}
})

function seedThread(id: string, provider: string, alias: string) {
  store.db
    .prepare(
      "INSERT INTO threads (id, session_group_id, provider, alias, updated_at) VALUES (?, 'sg-1', ?, ?, '2026-07-04T00:00:00.000Z')",
    )
    .run(id, provider, alias)
}

function seedMessage(id: string, threadId: string, content: string) {
  store.db
    .prepare(
      "INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, '2026-07-04T00:00:01.000Z')",
    )
    .run(id, threadId, content)
}

/** orderSeq 期望值 = 真表 rowid（reader 的合同就是原样透出 rowid，DB 自证不写死数字） */
function rowidOf(id: string): number {
  return (store.db.prepare("SELECT rowid AS r FROM messages WHERE id = ?").get(id) as { r: number })
    .r
}

describe("readFinalMessageFromDb（出站署名映射）", () => {
  it("claude / codex / gemini → 各自花名", () => {
    seedThread("t-claude", "claude", "黄仁勋")
    seedThread("t-codex", "codex", "范德彪")
    seedThread("t-gemini", "gemini", "桂芬")
    seedMessage("m-c", "t-claude", "仁勋的话")
    seedMessage("m-x", "t-codex", "德彪的话")
    seedMessage("m-g", "t-gemini", "桂芬的话")

    const CREATED = "2026-07-04T00:00:01.000Z"
    assert.deepEqual(readFinalMessageFromDb(store, "m-c"), {
      content: "仁勋的话",
      senderAlias: "黄仁勋",
      createdAt: CREATED,
      orderSeq: rowidOf("m-c"),
      model: null,
    })
    assert.deepEqual(readFinalMessageFromDb(store, "m-x"), {
      content: "德彪的话",
      senderAlias: "范德彪",
      createdAt: CREATED,
      orderSeq: rowidOf("m-x"),
      model: null,
    })
    assert.deepEqual(readFinalMessageFromDb(store, "m-g"), {
      content: "桂芬的话",
      senderAlias: "桂芬",
      createdAt: CREATED,
      orderSeq: rowidOf("m-g"),
      model: null,
    })
  })

  it("P2-2：同 created_at 的消息 orderSeq 单调可分（tie-breaker 键与房间列表同源）", () => {
    // m-c / m-x / m-g 共享同一 created_at —— rowid 必须严格递增可比
    const a = readFinalMessageFromDb(store, "m-c")
    const b = readFinalMessageFromDb(store, "m-x")
    assert.ok(a && b)
    assert.equal(a?.createdAt, b?.createdAt, "前置：确实同毫秒")
    assert.ok(typeof a?.orderSeq === "number" && typeof b?.orderSeq === "number")
    assert.ok((a?.orderSeq ?? 0) < (b?.orderSeq ?? 0), "先插入者 orderSeq 更小（房间序）")
  })

  it("线程缺失（LEFT JOIN 无命中）→ senderAlias null，内容照投", () => {
    seedMessage("m-orphan", "t-nonexistent", "孤儿消息")
    assert.deepEqual(readFinalMessageFromDb(store, "m-orphan"), {
      content: "孤儿消息",
      senderAlias: null,
      createdAt: "2026-07-04T00:00:01.000Z",
      orderSeq: rowidOf("m-orphan"),
      model: null,
    })
  })

  it("未知 provider（未来新 agent）→ 花名表查不到时回退 provider 原名", () => {
    seedThread("t-new", "newbot", "新同事")
    seedMessage("m-new", "t-new", "新人报到")
    assert.deepEqual(readFinalMessageFromDb(store, "m-new"), {
      content: "新人报到",
      senderAlias: "newbot",
      createdAt: "2026-07-04T00:00:01.000Z",
      orderSeq: rowidOf("m-new"),
      model: null,
    })
  })

  it("AC-N4：messages.model 快照透出（追加时冻结的真实型号）；旧行无值 → null", () => {
    seedThread("t-modeled", "claude", "黄仁勋")
    store.db
      .prepare(
        "INSERT INTO messages (id, thread_id, role, content, model, created_at) VALUES ('m-modeled','t-modeled','assistant','带型号的话','claude-opus-4-8','2026-07-04T00:00:02.000Z')",
      )
      .run()
    assert.equal(readFinalMessageFromDb(store, "m-modeled")?.model, "claude-opus-4-8")
    // F021 前旧行 / relay 行 model 为 NULL → null（卡片退回纯花名，不编造）
    assert.equal(readFinalMessageFromDb(store, "m-c")?.model, null)
  })

  it("消息不存在 → null", () => {
    assert.equal(readFinalMessageFromDb(store, "m-missing"), null)
  })
})

describe("P3 AC16：content_blocks → mediaBlocks", () => {
  it("image（alt→name）+ file 提取；text 块忽略；无媒体/破损/空 → undefined", () => {
    store.db
      .prepare(
        `INSERT INTO messages (id, thread_id, role, content, content_blocks, created_at)
         VALUES ('m-media','t-claude','assistant','带媒体', ?, '2026-07-04T00:00:03.000Z')`,
      )
      .run(
        JSON.stringify([
          { type: "text", text: "忽略我" },
          { type: "image", url: "/uploads/a.png", alt: "截图" },
          { type: "image", url: "/uploads/b.png" },
          { type: "file", url: "/uploads/c.pdf", name: "报告.pdf" },
        ]),
      )
    const withMedia = readFinalMessageFromDb(store, "m-media")
    assert.deepEqual(withMedia?.mediaBlocks, [
      { kind: "image", url: "/uploads/a.png", name: "截图" },
      { kind: "image", url: "/uploads/b.png", name: "图片" },
      { kind: "file", url: "/uploads/c.pdf", name: "报告.pdf" },
    ])

    store.db
      .prepare(
        `INSERT INTO messages (id, thread_id, role, content, content_blocks, created_at)
         VALUES ('m-textonly','t-claude','assistant','纯文本', '[{"type":"text","text":"x"}]', '2026-07-04T00:00:04.000Z'),
                ('m-broken','t-claude','assistant','破损', '{oops', '2026-07-04T00:00:05.000Z')`,
      )
      .run()
    assert.equal(readFinalMessageFromDb(store, "m-textonly")?.mediaBlocks, undefined)
    assert.equal(readFinalMessageFromDb(store, "m-broken")?.mediaBlocks, undefined)
  })

  it("P2 回归：非 /uploads 单层 URL 全拒（外部 URL/子路径/反斜杠/裸相对路径），混入时只留合法项", () => {
    // confused-deputy 面：外部 URL 经 basename 会误读 uploadsDir 同名文件
    store.db
      .prepare(
        `INSERT INTO messages (id, thread_id, role, content, content_blocks, created_at)
         VALUES ('m-evil','t-claude','assistant','带毒媒体', ?, '2026-07-04T00:00:06.000Z')`,
      )
      .run(
        JSON.stringify([
          { type: "file", url: "https://evil.example/report.pdf", name: "外部URL" },
          { type: "file", url: "/uploads/deep/../../etc/passwd", name: "子路径" },
          { type: "image", url: "/uploads/sub\\dir.png", alt: "反斜杠" },
          { type: "image", url: "relative.png", alt: "裸相对" },
          { type: "file", url: "/uploads/legit.pdf", name: "合法.pdf" },
        ]),
      )
    assert.deepEqual(readFinalMessageFromDb(store, "m-evil")?.mediaBlocks, [
      { kind: "file", url: "/uploads/legit.pdf", name: "合法.pdf" },
    ])
  })

  it("T7 修10（德彪 r7 P2）：/uploads/. 与 /uploads/.. 拒——单层正则放行后 basename+resolve 会逃出容器（/uploads/.. → uploadsDir 父目录）", () => {
    store.db
      .prepare(
        `INSERT INTO messages (id, thread_id, role, content, content_blocks, created_at)
         VALUES ('m-dot','t-claude','assistant','dot-segment', ?, '2026-07-04T00:00:08.000Z')`,
      )
      .run(
        JSON.stringify([
          { type: "file", url: "/uploads/..", name: "逃逸" },
          { type: "file", url: "/uploads/.", name: "点" },
          // 绝对址 dot：WHATWG URL 把 /uploads/.. 归一成 / → 前缀闸拒（回归钉住）
          { type: "image", url: "http://100.64.0.7:8803/uploads/..", alt: "绝对逃逸" },
          // 编码 dot 不解码 = 字面文件名（fs 无二次解码，无穿越面）——留在容器内可收
          { type: "image", url: "/uploads/ok.png", alt: "合法" },
        ]),
      )
    assert.deepEqual(readFinalMessageFromDb(store, "m-dot")?.mediaBlocks, [
      { kind: "image", url: "/uploads/ok.png", name: "合法" },
    ])
  })

  it("T7 真机回归：绝对 URL pathname 过 /uploads 单层闸 → 收并归一化回相对（截图块是 resolveUploadUrl 前缀过的绝对址）", () => {
    store.db
      .prepare(
        `INSERT INTO messages (id, thread_id, role, content, content_blocks, created_at)
         VALUES ('m-abs','t-claude','assistant','截图来了', ?, '2026-07-04T00:00:07.000Z')`,
      )
      .run(
        JSON.stringify([
          // Tailscale/局域网真机形态（NEXT_PUBLIC_API_HTTP_URL 前缀）
          { type: "image", url: "http://100.64.0.7:8803/uploads/shot.png", alt: "项目截图" },
          { type: "file", url: "https://localhost:8803/uploads/log.txt", name: "日志" },
          // host 无关性：字节恒来自本地 uploadsDir，path 才是契约——恶意 host 不新增能力
          { type: "image", url: "https://evil.example/uploads/feishu-x.png", alt: "异 host" },
          // 绝对址穿越：WHATWG URL 把 /../ 归一成 /etc/passwd → 单层闸拒
          { type: "file", url: "http://100.64.0.7:8803/uploads/../../etc/passwd", name: "穿越" },
          // 绝对址反斜杠：URL 解析转正斜杠变子路径 → 拒
          { type: "image", url: "http://100.64.0.7:8803/uploads/sub\\x.png", alt: "反斜杠" },
        ]),
      )
    assert.deepEqual(readFinalMessageFromDb(store, "m-abs")?.mediaBlocks, [
      { kind: "image", url: "/uploads/shot.png", name: "项目截图" },
      { kind: "file", url: "/uploads/log.txt", name: "日志" },
      { kind: "image", url: "/uploads/feishu-x.png", name: "异 host" },
    ])
  })
})
