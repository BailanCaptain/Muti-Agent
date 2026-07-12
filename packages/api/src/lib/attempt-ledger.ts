import fs from "node:fs"
import path from "node:path"

/**
 * attempted/sent 幂等账本原语（自 F037 daily-digest 提升共享 · F041 W7，D10/D11 禁 copy-first）：
 * attempted 计数 + sent 唯一终态（失败只记在 attempt note，非终态）。
 * 文件级原子：tmp 写 + renameSync 替换；损坏 JSON 视为空状态（kill -9 容错），只 warn 不抛。
 * key=按日分片（YYYY-MM-DD）——现有消费方（日报/投研简报）都是 per-day 单发账。
 */

export interface AttemptLedgerState {
  attempts: Array<{ at: string; note: string }>
  sent: { at: string; messageId: string; to: string } | null
}

export interface AttemptLedger {
  read(key: string): AttemptLedgerState
  recordAttempt(key: string, note: string): void
  recordSent(key: string, meta: { messageId: string; to: string }): void
}

export function createFileAttemptLedger(baseDir: string, logPrefix: string): AttemptLedger {
  const ledgerDir = path.join(baseDir, "ledger")

  function fileFor(key: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error(`invalid ledger key: ${key}`)
    return path.join(ledgerDir, `${key}.json`)
  }

  function read(key: string): AttemptLedgerState {
    try {
      const raw = fs.readFileSync(fileFor(key), "utf8")
      const j = JSON.parse(raw) as AttemptLedgerState
      if (!Array.isArray(j.attempts)) return { attempts: [], sent: null }
      return { attempts: j.attempts, sent: j.sent ?? null }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`${logPrefix} ledger read fallback to empty (${key}): ${String(err)}`)
      }
      return { attempts: [], sent: null }
    }
  }

  function writeAtomic(key: string, state: AttemptLedgerState): void {
    fs.mkdirSync(ledgerDir, { recursive: true })
    const target = fileFor(key)
    const tmp = `${target}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1))
    fs.renameSync(tmp, target)
  }

  return {
    read,
    recordAttempt(key, note) {
      const s = read(key)
      s.attempts.push({ at: new Date().toISOString(), note })
      writeAtomic(key, s)
    },
    recordSent(key, meta) {
      const s = read(key)
      if (s.sent) return // 幂等：终态只写一次
      s.sent = { at: new Date().toISOString(), ...meta }
      writeAtomic(key, s)
    },
  }
}
