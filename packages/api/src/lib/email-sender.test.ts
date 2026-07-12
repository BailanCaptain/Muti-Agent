import assert from "node:assert/strict"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { beforeEach, describe, it } from "node:test"
import SMTPConnection from "nodemailer/lib/smtp-connection"
import {
  appendOutboundLedger,
  createAllowlistedSender,
  createMockSender,
  createQqSmtpSender,
  parseRecipients,
  type QqSmtpOptions,
} from "./email-sender"

const mail = { to: "a@b.c", subject: "s", html: "<p>h</p>", text: "t" }
type TestSmtpConnection = ReturnType<NonNullable<QqSmtpOptions["connectionFactory"]>>

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "f037-mail-"))
})

/** fake SMTPConnection：close() 对齐真类——清 response action、emit end，但不回调 send cb。 */
function fakeConn(
  behavior: { hang?: boolean; loginError?: Error; sendError?: Error } = {},
) {
  const errorHandlers: Array<(err: Error) => void> = []
  const endHandlers: Array<() => void> = []
  const state = {
    auth: null as null | { credentials: { user: string; pass: string } },
    envelope: null as null | { from?: string; to?: string[] },
    message: "",
    quit: 0,
    closed: 0,
    sendCbCount: 0,
    endEvents: 0,
    pendingSendCb: null as null | ((err: Error | null) => void),
  }
  const conn = {
    on(event: "error" | "end", handler: ((err: Error) => void) | (() => void)) {
      if (event === "error") errorHandlers.push(handler as (err: Error) => void)
      else endHandlers.push(handler as () => void)
    },
    connect(cb: (err?: Error) => void) {
      cb()
    },
    login(auth: { credentials: { user: string; pass: string } }, cb: (err?: Error) => void) {
      state.auth = auth
      cb(behavior.loginError)
    },
    send(
      envelope: { from?: string; to?: string[] },
      message: Buffer,
      cb: (err: Error | null, info?: { response?: string }) => void,
    ) {
      state.envelope = envelope
      state.message = message.toString()
      if (behavior.hang) {
        state.pendingSendCb = cb
        return
      }
      state.sendCbCount++
      cb(behavior.sendError ?? null, { response: "250 OK" })
    },
    quit() {
      state.quit++
    },
    close() {
      state.closed++
      state.pendingSendCb = null
      state.endEvents++
      for (const handler of endHandlers) handler()
    },
    emitEnd() {
      state.endEvents++
      for (const handler of endHandlers) handler()
    },
  }
  return { conn, state }
}

async function startFakeSmtp(behavior: {
  withholdQuit?: boolean
  withholdDataFinal?: boolean
}) {
  const sockets: net.Socket[] = []
  const stats = { dataBodies: 0, quitCommands: 0 }
  const server = net.createServer((socket) => {
    sockets.push(socket)
    socket.write("220 localhost test smtp\r\n")
    let buffered = ""
    let dataMode = false
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8")
      while (true) {
        if (dataMode) {
          const end = buffered.indexOf("\r\n.\r\n")
          if (end < 0) return
          buffered = buffered.slice(end + 5)
          dataMode = false
          stats.dataBodies++
          if (behavior.withholdDataFinal) return
          socket.write("250 queued\r\n")
          continue
        }
        const lineEnd = buffered.indexOf("\r\n")
        if (lineEnd < 0) return
        const line = buffered.slice(0, lineEnd)
        buffered = buffered.slice(lineEnd + 2)
        if (/^EHLO /i.test(line)) {
          socket.write("250-localhost\r\n250 AUTH PLAIN\r\n")
        } else if (/^AUTH PLAIN /i.test(line)) {
          socket.write("235 authenticated\r\n")
        } else if (/^(MAIL FROM|RCPT TO):/i.test(line)) {
          socket.write("250 ok\r\n")
        } else if (/^DATA$/i.test(line)) {
          dataMode = true
          socket.write("354 end with dot\r\n")
        } else if (/^QUIT$/i.test(line)) {
          stats.quitCommands++
          if (!behavior.withholdQuit) socket.end("221 bye\r\n")
        } else {
          socket.write("250 ok\r\n")
        }
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { server, sockets, stats, port: (server.address() as net.AddressInfo).port }
}

async function waitForSocketClose(socket: net.Socket, timeoutMs = 500): Promise<void> {
  if (socket.destroyed) return
  await new Promise<void>((resolve, reject) => {
    const onClose = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      socket.off("close", onClose)
      reject(new Error(`socket 未在 ${timeoutMs}ms 内关闭`))
    }, timeoutMs)
    socket.once("close", onClose)
  })
}

describe("createQqSmtpSender", () => {
  it("固定 smtp.qq.com:465 secure 三段超时 + 凭证走 login + BCC 信封/头姿态", async () => {
    const cfgs: Record<string, unknown>[] = []
    const { conn, state } = fakeConn()
    const sender = createQqSmtpSender({
      user: "u@qq.com",
      pass: "authcode",
      connectionFactory: (cfg) => {
        cfgs.push(cfg)
        return conn
      },
    })
    const r = await sender.send(mail)
    assert.ok(r.messageId.length > 0)
    // 连接参数只有网络面；凭证不进连接 cfg（走 login 阶段）
    assert.deepEqual(cfgs[0], {
      host: "smtp.qq.com",
      port: 465,
      secure: true,
      connectionTimeout: 60_000,
      greetingTimeout: 30_000,
      socketTimeout: 120_000,
    })
    assert.deepEqual(state.auth, { credentials: { user: "u@qq.com", pass: "authcode" } })
    // BCC 密送（07-11 小孙）：真实收件人只进 SMTP 信封（RCPT），message 头永无 Bcc；
    // To 头=发件人自身（newsletter 惯例）——信封含发件人自收份+BCC 清单
    assert.deepEqual(state.envelope?.to, ["u@qq.com", "a@b.c"])
    assert.ok(!/^bcc:/im.test(state.message), "message 头不许出现 Bcc（收件人互见即泄露）")
    assert.match(state.message, /^to:.*u@qq\.com/im)
    assert.match(state.message, /^from:.*u@qq\.com/im)
    assert.equal(state.quit, 1, "发送成功走 quit 优雅收尾")
    assert.equal(state.closed, 1, "成功终态也必须 close 兜底，不依赖 QUIT 响应")
  })

  it("login 失败终态必须 close 连接", async () => {
    const { conn, state } = fakeConn({ loginError: new Error("535 auth failed") })
    const sender = createQqSmtpSender({
      user: "u@qq.com",
      pass: "bad-authcode",
      connectionFactory: () => conn,
    })
    await assert.rejects(() => sender.send(mail), /535 auth failed/)
    assert.equal(state.closed, 1)
  })

  it("send 失败终态必须 close 连接", async () => {
    const { conn, state } = fakeConn({ sendError: new Error("DATA rejected") })
    const sender = createQqSmtpSender({
      user: "u@qq.com",
      pass: "authcode",
      connectionFactory: () => conn,
    })
    await assert.rejects(() => sender.send(mail), /DATA rejected/)
    assert.equal(state.closed, 1)
  })

  it("发送总 deadline：连接挂死 → 到点 reject + close 杀持有的连接 + end 事件 settle（r3 P2：sender 必须自持连接）", async () => {
    const { conn, state } = fakeConn({ hang: true })
    const sender = createQqSmtpSender({
      user: "u@qq.com",
      pass: "authcode",
      sendDeadlineMs: 50,
      connectionFactory: () => conn,
    })
    await assert.rejects(() => sender.send(mail), /deadline/)
    assert.equal(state.closed, 1, "deadline 必须 close 我们持有的这条连接（不留 ghost）")
    assert.equal(state.sendCbCount, 0, "真 SMTPConnection close 不会回调 pending send cb")
    assert.equal(state.pendingSendCb, null, "close 清理 response action，不保留悬挂回调引用")
    assert.equal(state.endEvents, 1, "底层发送靠 end 事件 settle")
  })

  it("底层只 emit end、不回调 send cb 时，send 立即 reject 并 close", async () => {
    const { conn, state } = fakeConn({ hang: true })
    const sender = createQqSmtpSender({
      user: "u@qq.com",
      pass: "authcode",
      sendDeadlineMs: 1_000,
      connectionFactory: () => conn,
    })
    const startedAt = Date.now()
    const result = sender.send(mail)
    while (!state.pendingSendCb) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    conn.emitEnd()
    await assert.rejects(() => result, /ended/)
    assert.ok(Date.now() - startedAt < 250, "end 事件必须直接 settle，不能等 deadline")
    assert.equal(state.sendCbCount, 0)
    assert.equal(state.closed, 1)
  })

  it(
    "生产 SMTPConnection：DATA 250 后 QUIT 无响应，send 返回时双端 socket 已关闭",
    { timeout: 5_000 },
    async () => {
      const smtp = await startFakeSmtp({ withholdQuit: true })
      let conn: SMTPConnection | undefined
      try {
        const sender = createQqSmtpSender({
          user: "u@qq.com",
          pass: "authcode",
          sendDeadlineMs: 2_000,
          connectionFactory: () => {
            conn = new SMTPConnection({
              host: "127.0.0.1",
              port: smtp.port,
              secure: false,
              ignoreTLS: true,
            })
            return conn as unknown as TestSmtpConnection
          },
        })
        await sender.send(mail)
        assert.equal(smtp.stats.dataBodies, 1)
        assert.ok(smtp.sockets[0], "服务端应已接到 SMTP 连接")
        await waitForSocketClose(smtp.sockets[0])
        assert.equal(smtp.stats.quitCommands, 1, "服务端已收到 QUIT，只是故意不回响应")
        const clientSocket = (conn as unknown as { _socket?: net.Socket } | undefined)?._socket
        assert.ok(clientSocket, "应捕获客户端 socket")
        await waitForSocketClose(clientSocket)
        assert.equal(clientSocket?.destroyed, true, "客户端 socket 必须销毁")
      } finally {
        conn?.close()
        for (const socket of smtp.sockets) socket.destroy()
        await new Promise<void>((resolve) => smtp.server.close(() => resolve()))
      }
    },
  )

  it(
    "生产 SMTPConnection 契约：DATA 完整送达但扣最终 250，deadline close 后 send cb=0、end 事件且双端销毁",
    { timeout: 5_000 },
    async () => {
      const smtp = await startFakeSmtp({ withholdDataFinal: true })
      let conn: SMTPConnection | undefined
      let sendCbCount = 0
      let endEvents = 0
      try {
        const sender = createQqSmtpSender({
          user: "u@qq.com",
          pass: "authcode",
          sendDeadlineMs: 50,
          connectionFactory: () => {
            conn = new SMTPConnection({
              host: "127.0.0.1",
              port: smtp.port,
              secure: false,
              ignoreTLS: true,
            })
            conn.on("end", () => endEvents++)
            const originalSend = conn.send.bind(conn)
            conn.send = ((envelope, message, cb) =>
              originalSend(envelope, message, (err, info) => {
                sendCbCount++
                cb(err, info)
              })) as typeof conn.send
            return conn as unknown as TestSmtpConnection
          },
        })
        await assert.rejects(() => sender.send(mail), /deadline/)
        assert.equal(smtp.stats.dataBodies, 1, "完整 DATA terminator 已到服务端")
        assert.equal(sendCbCount, 0, "close 不得伪造 pending send callback")
        assert.ok(endEvents >= 1, "真类用 end 事件通知连接终止")
        assert.ok(smtp.sockets[0], "服务端应已接到 SMTP 连接")
        await waitForSocketClose(smtp.sockets[0])
        const clientSocket = (conn as unknown as { _socket?: net.Socket } | undefined)?._socket
        assert.ok(clientSocket, "应捕获客户端 socket")
        await waitForSocketClose(clientSocket)
        assert.equal(clientSocket?.destroyed, true, "客户端 socket 必须销毁")
      } finally {
        conn?.close()
        for (const socket of smtp.sockets) socket.destroy()
        await new Promise<void>((resolve) => smtp.server.close(() => resolve()))
      }
    },
  )

  it(
    "生产 SMTPConnection 契约：greeting 挂死时 close() 真销毁 socket（r3 P2 依赖的取消语义，防 nodemailer 升级悄变；非 close-spy）",
    { timeout: 15_000 },
    async () => {
      // 本地假 SMTP：收连接后扣住 greeting 不回——模拟「连上了但对端不动」的挂死形态
      const serverSockets: net.Socket[] = []
      let onFirstConn: (() => void) | undefined
      const firstConn = new Promise<void>((resolve) => {
        onFirstConn = resolve
      })
      const server = net.createServer((socket) => {
        serverSockets.push(socket)
        onFirstConn?.()
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const port = (server.address() as net.AddressInfo).port
      try {
        const conn = new SMTPConnection({
          host: "127.0.0.1",
          port,
          secure: false,
          ignoreTLS: true,
          // 分段超时全放大：确保 settle 只能来自 close()，不是分段超时先到
          connectionTimeout: 60_000,
          greetingTimeout: 60_000,
          socketTimeout: 60_000,
        })
        // settle 三路等一（sender 生产实现同样 error 事件+回调双路收）：close 后
        // SMTPConnection 可能回调 connect(err)、emit error、或只静默 end/close——
        // 契约核心是「socket 真销毁 + 进程可观察 settle」，不锁死具体通知路径
        const settled = new Promise<string>((resolve) => {
          conn.on("error", () => resolve("error-event"))
          conn.on("end", () => resolve("end-event"))
          conn.connect((err?: Error) => resolve(err ? "connect-cb-error" : "connect-cb-ok"))
        })
        await firstConn // promise 先建后 connect 无竞态；此处 server 已收到 TCP 连接
        conn.close()
        const via = await settled
        assert.notEqual(via, "connect-cb-ok", "greeting 挂死不可能正常就绪")
        // socket 真销毁：server 侧观察到对端断开
        await new Promise<void>((resolve) => {
          const s = serverSockets[0]
          if (!s || s.destroyed) return resolve()
          s.once("close", () => resolve())
        })
      } finally {
        for (const s of serverSockets) s.destroy()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
  )

  it("多收件人清单全进信封 BCC 位（互相看不到彼此）", async () => {
    const { conn, state } = fakeConn()
    const sender = createQqSmtpSender({
      user: "u@qq.com",
      pass: "authcode",
      connectionFactory: () => conn,
    })
    await sender.send({ ...mail, to: "a@x.com, b@y.com" })
    assert.deepEqual(state.envelope?.to, ["u@qq.com", "a@x.com", "b@y.com"])
    assert.ok(!/^bcc:/im.test(state.message))
    assert.ok(!/^to:.*a@x\.com/im.test(state.message), "真实收件人不许出现在 To 头")
  })
})

describe("createAllowlistedSender（AC10 fail-closed · 多收件人）", () => {
  const inner = { kind: "mock", send: async () => ({ messageId: "x" }) }
  it("白名单外收件人 → 拒发", async () => {
    const s = createAllowlistedSender(inner, ["only@me.com"])
    await assert.rejects(s.send(mail), /not in allowlist/)
  })
  it("大小写敏感拒；逗号间空白容忍；精确放行", async () => {
    const s = createAllowlistedSender(inner, ["only@me.com"])
    await assert.rejects(s.send({ ...mail, to: "Only@Me.com" }), /not in allowlist/)
    const trimmed = await s.send({ ...mail, to: " only@me.com" }) // 仅去逗号间空白 → 放行
    assert.equal(trimmed.messageId, "x")
    const exact = await s.send({ ...mail, to: "only@me.com" })
    assert.equal(exact.messageId, "x")
  })
  it("多收件人：全在白名单放行；任一不在 → 整封拒（fail-closed）", async () => {
    const s = createAllowlistedSender(inner, ["a@x.com", "b@y.com"])
    const ok = await s.send({ ...mail, to: "a@x.com, b@y.com" })
    assert.equal(ok.messageId, "x")
    await assert.rejects(s.send({ ...mail, to: "a@x.com, evil@z.com" }), /evil@z.com/)
  })
  it("空收件人 → 拒发", async () => {
    const s = createAllowlistedSender(inner, ["a@x.com"])
    await assert.rejects(s.send({ ...mail, to: "" }), /not in allowlist/)
  })
})

describe("parseRecipients", () => {
  it("逗号分隔 + 去空白 + 去空 + 去重（保序）", () => {
    assert.deepEqual(parseRecipients("a@x.com, b@y.com ,,a@x.com"), ["a@x.com", "b@y.com"])
    assert.deepEqual(parseRecipients("solo@z.com"), ["solo@z.com"])
    assert.deepEqual(parseRecipients(""), [])
  })
})

describe("createMockSender + 外发账本", () => {
  it("mock 写 .eml 文件（与真 SMTP 同姿态：收件人在 Bcc 头）", async () => {
    const s = createMockSender(dir)
    const r = await s.send(mail)
    const files = fs.readdirSync(dir)
    assert.equal(files.length, 1)
    assert.ok(files[0].startsWith(r.messageId))
    const eml = fs.readFileSync(path.join(dir, files[0]), "utf8")
    assert.ok(eml.includes("Subject: s"))
    assert.ok(eml.includes("Bcc: a@b.c"))
    assert.ok(eml.includes("To: undisclosed-recipients:;"))
  })
  it("账本 JSONL 逐行可解析", () => {
    appendOutboundLedger(dir, {
      at: "t1",
      to: "a@b.c",
      subject: "s1",
      senderKind: "mock",
      messageId: "m1",
      sections: { ai: 3 },
    })
    appendOutboundLedger(dir, {
      at: "t2",
      to: "a@b.c",
      subject: "s2",
      senderKind: "mock",
      messageId: "m2",
      sections: {},
    })
    const lines = fs
      .readFileSync(path.join(dir, "outbound-ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
    assert.equal(lines.length, 2)
    assert.equal((JSON.parse(lines[0]) as { messageId: string }).messageId, "m1")
  })
})
