import fs from "node:fs"
import path from "node:path"
import MailComposer from "nodemailer/lib/mail-composer"
import SMTPConnection from "nodemailer/lib/smtp-connection"

/**
 * 邮件发送通用零件（自 F037 daily-digest 提升共享 · F041 W7 抽零件，D11 禁 copy-first。
 * 原为 F037 T12，AC10）：
 * - QQ SMTP（D3 小孙拍板）；凭证 .env 人工填（Iron Law §3，代码只读）
 * - 收件人白名单 fail-closed：to 必须严格等于配置收件人，否则拒发
 * - 每次外发落账本 outbound-ledger.jsonl
 * digest 自己的 env 面（resolveDigestEnv）留在 services/daily-digest/email-sender.ts。
 */

export interface OutgoingMail {
  to: string
  subject: string
  html: string
  text: string
}

export interface EmailSender {
  readonly kind: string
  send(mail: OutgoingMail): Promise<{ messageId: string }>
}

/** 发送总 deadline（07-11 三拍 r2 P2-2 德彪）：nodemailer 三段超时都不是总时限——
 *  socketTimeout 是「无活动」窗（零星流量可无限拖），DNS 解析/多地址 fallback 另计。
 *  真上限只能在发送外层 race + 到点杀连接。本常量是看门狗账 SMTP 腿的唯一口径
 *  （scheduler-config.test 账目关系测试据此推导）。 */
export const SMTP_SEND_DEADLINE_MS = 120_000

/** SMTPConnection 最小面（r3 P2 德彪）：不走 smtp-transport.sendMail——它在 send() 内部
 *  建**局部** SMTPConnection（smtp-transport/index.js:158），外层 transport.close() 只摘
 *  OAuth listener + emit 事件（:420），根本够不着进行中的连接 → deadline 撕不掉 = ghost
 *  send 晚到成功 + 下一整点重发 = 重复邮件。改为直接持有 SMTPConnection：它的 close()
 *  有真取消语义（smtp-connection/index.js:493 destroy/end + :516 socket.destroyed 守卫）。 */
type SmtpConnectionLike = {
  connect(cb: (err?: Error) => void): void
  login(auth: { credentials: { user: string; pass: string } }, cb: (err?: Error) => void): void
  send(
    envelope: { from?: string | false; to?: string[] },
    message: Buffer,
    cb: (err: Error | null, info?: { response?: string }) => void,
  ): void
  quit(): void
  close(): void
  on(event: "error", handler: (err: Error) => void): void
  on(event: "end", handler: () => void): void
}

export interface QqSmtpOptions {
  user: string
  pass: string
  /** 测试注入：连接工厂（生产=真 SMTPConnection） */
  connectionFactory?: (cfg: {
    host: string
    port: number
    secure: boolean
    connectionTimeout: number
    greetingTimeout: number
    socketTimeout: number
  }) => SmtpConnectionLike
  /** 测试注入：发送总 deadline 覆盖（生产恒 SMTP_SEND_DEADLINE_MS） */
  sendDeadlineMs?: number
}

export function createQqSmtpSender(opts: QqSmtpOptions): EmailSender {
  const makeConnection =
    opts.connectionFactory ??
    ((cfg) => new SMTPConnection(cfg) as unknown as SmtpConnectionLike)
  const deadlineMs = opts.sendDeadlineMs ?? SMTP_SEND_DEADLINE_MS
  return {
    kind: "qq-smtp",
    async send(mail) {
      // 收件人互不可见（小孙 07-11）：真实收件人全走 BCC；To 填发件人自身——
      // 无 To 头的邮件（undisclosed-recipients）在部分反垃圾引擎减分，newsletter
      // 惯例是 To=自己。allowlist/账本仍按 mail.to（目标清单）口径，语义不变。
      // MailComposer 语义：bcc 进 envelope（真实投递目标）但不落 message 头。
      const composed = new MailComposer({
        from: `"DailyBrief" <${opts.user}>`,
        to: `"DailyBrief" <${opts.user}>`,
        bcc: mail.to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      }).compile()
      const envelope = composed.getEnvelope()
      const messageId = composed.messageId()
      const message = await composed.build()

      // 每封新建连接（与原 smtp-transport 非 pool 行为一致），发送方持有引用
      const conn = makeConnection({
        host: "smtp.qq.com",
        port: 465,
        secure: true,
        // 三段分段超时护内部各段；总上限由下方 deadline 封死（r1/r2/r3 P2-2 链）
        connectionTimeout: 60_000,
        greetingTimeout: 30_000,
        socketTimeout: 120_000,
      })
      let closed = false
      const closeOnce = () => {
        if (closed) return
        closed = true
        try {
          conn.close()
        } catch {
          // 终态清理不得掩盖原始发送结果；SMTPConnection.close 本身也按幂等设计
        }
      }
      const sending = new Promise<{ messageId: string }>((resolve, reject) => {
        // 持续吞 error 事件：quit/close 后 socket 竞态还可能 emit，不吞会炸 EventEmitter
        conn.on("error", (err) => reject(err))
        // 真 SMTPConnection.close() 会清空 response actions、emit end，不保证回调
        conn.on("end", () => reject(new Error("SMTP connection ended before send completed")))
        conn.connect((err) => {
          if (err) return reject(err)
          conn.login({ credentials: { user: opts.user, pass: opts.pass } }, (err2) => {
            if (err2) return reject(err2)
            conn.send(envelope, message, (err3) => {
              if (err3) return reject(err3)
              conn.quit()
              resolve({ messageId })
            })
          })
        })
      })
      // deadline 败者的 late settle 不许变 unhandled（close 后会走 end/error 事件）
      sending.catch(() => {})
      let timer: NodeJS.Timeout | undefined
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // 先 reject 立 deadline 因果（close 可能同步炸出 ECONNRESET，别让它抢走错误语义），
          // 再杀我们持有的这条连接（SMTPConnection.close → socket destroy/end）——底层发送
          // 必然 settle（旁支 catch 吞），不留 ghost socket；scheduler 看门狗非抢占兜不了这层
          reject(new Error(`SMTP send 超过总 deadline ${deadlineMs}ms，连接已关闭`))
          closeOnce()
        }, deadlineMs)
      })
      try {
        return await Promise.race([sending, deadline])
      } finally {
        clearTimeout(timer)
        // 所有终态统一收口：AUTH/SEND error、成功（QUIT 只是优雅道别）和 deadline
        // 都必须释放连接；closeOnce 防 deadline 与 finally 竞态二次清理。
        closeOnce()
      }
    },
  }
}

/** 开发/测试/未配凭证：写 .eml 到归档目录，不外发 */
export function createMockSender(outDir: string): EmailSender {
  return {
    kind: "mock",
    async send(mail) {
      fs.mkdirSync(outDir, { recursive: true })
      const id = `mock-${Date.now()}`
      const file = path.join(outDir, `${id}.eml`)
      fs.writeFileSync(
        file,
        [
          // 与真 SMTP 姿态一致：收件人走 Bcc（To 是发件人占位），mock 忠实反映外发头
          "To: undisclosed-recipients:;",
          `Bcc: ${mail.to}`,
          `Subject: ${mail.subject}`,
          "Content-Type: text/html; charset=utf-8",
          "",
          mail.html,
        ].join("\r\n"),
      )
      return { messageId: id }
    },
  }
}

/**
 * 收件人清单解析（AC10 多收件人）：逗号分隔 → 去首尾空白 → 去空 → 去重（保序）。
 * 归一只容忍逗号间空白（join(", ") 的产物），**不做大小写折叠**——不同大小写视为不同地址。
 */
export function parseRecipients(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.split(",")) {
    const addr = part.trim()
    if (addr && !out.includes(addr)) out.push(addr)
  }
  return out
}

/**
 * 收件人白名单 fail-closed 包装（AC10）：mail.to 里**每个**地址都必须在 allowed 集合内，
 * 任一不在 → 整封拒发。多收件人：mail.to 与 allowed 均按 parseRecipients 归一（逗号分隔 + 去空白）。
 * 大小写仍敏感（德彪 P1r1-P2 安全口径：宁拒不放，只放宽逗号间空白以支持多收件人）；空清单一律拒。
 */
export function createAllowlistedSender(inner: EmailSender, allowed: string[]): EmailSender {
  const allowedSet = new Set(allowed)
  return {
    kind: `${inner.kind}+allowlist`,
    async send(mail) {
      const targets = parseRecipients(mail.to)
      if (targets.length === 0) {
        throw new Error("recipient not in allowlist: (empty)")
      }
      for (const t of targets) {
        if (!allowedSet.has(t)) {
          throw new Error(`recipient not in allowlist: ${t}`)
        }
      }
      return inner.send(mail)
    },
  }
}

export interface OutboundLedgerEntry {
  at: string
  to: string
  subject: string
  senderKind: string
  messageId: string
  sections: Record<string, number>
}

/** AC10 外发账本：JSONL 追加 */
export function appendOutboundLedger(baseDir: string, entry: OutboundLedgerEntry): void {
  fs.mkdirSync(baseDir, { recursive: true })
  fs.appendFileSync(path.join(baseDir, "outbound-ledger.jsonl"), `${JSON.stringify(entry)}\n`)
}
