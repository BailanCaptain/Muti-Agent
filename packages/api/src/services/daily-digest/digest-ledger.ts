import fs from "node:fs"
import path from "node:path"
import type { DigestLedger, DigestLedgerState } from "./types"

/**
 * D10 幂等 ledger：attempted 计数 + sent 唯一终态（失败只记在 attempt note，非终态）。
 * 文件级原子：tmp 写 + renameSync 替换；损坏 JSON 视为空状态（kill -9 容错），只 warn 不抛。
 */
export function createFileDigestLedger(baseDir: string): DigestLedger {
  const ledgerDir = path.join(baseDir, "ledger")

  function fileFor(businessDate: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate))
      throw new Error(`invalid businessDate: ${businessDate}`)
    return path.join(ledgerDir, `${businessDate}.json`)
  }

  function read(businessDate: string): DigestLedgerState {
    try {
      const raw = fs.readFileSync(fileFor(businessDate), "utf8")
      const j = JSON.parse(raw) as DigestLedgerState
      if (!Array.isArray(j.attempts)) return { attempts: [], sent: null }
      return { attempts: j.attempts, sent: j.sent ?? null }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[daily-digest] ledger read fallback to empty (${businessDate}): ${String(err)}`,
        )
      }
      return { attempts: [], sent: null }
    }
  }

  function writeAtomic(businessDate: string, state: DigestLedgerState): void {
    fs.mkdirSync(ledgerDir, { recursive: true })
    const target = fileFor(businessDate)
    const tmp = `${target}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1))
    fs.renameSync(tmp, target)
  }

  return {
    read,
    recordAttempt(businessDate, note) {
      const s = read(businessDate)
      s.attempts.push({ at: new Date().toISOString(), note })
      writeAtomic(businessDate, s)
    },
    recordSent(businessDate, meta) {
      const s = read(businessDate)
      if (s.sent) return // 幂等：终态只写一次
      s.sent = { at: new Date().toISOString(), ...meta }
      writeAtomic(businessDate, s)
    },
  }
}
