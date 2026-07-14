import fs from "node:fs"
import path from "node:path"

/**
 * E1 跨日「已见」账本（07-07 小孙「昨天的日报和今天的日报有很多重复的信息」）。
 *
 * 每天发送成功后，把最终 publication 中实际展示（含 alsoItemIds）的条目 dedupeKey
 * 落 `<baseDir>/<businessDate>/shown.json`；次日构建时取近 N 天
 * 并集，把已见条目从选材视野剔除（items.jsonl 证据底料不受影响，仍落全量）。
 *
 * 语义要点：
 * - 喂过样但没发布不算已见，避免一次模型漏选造成 30 天永久漏报；
 * - github 榜单不记（周榜/月榜蝉联是榜单固有语义，调用方自行豁免）；
 * - 只读**往日**账本（不含当日）→ 当日 force 重发结果与首发一致；
 * - 同日重写=并集（德彪 r-final P1-2）：force 重发与首发内容不同时，两批已见都要留住——
 *   裸覆盖会让首发条目次日回流；
 * - 回看 30 天（德彪 r-final P2-2）：有日期条目 7 天新鲜窗先兜；无日期条目（热榜/X 类）
 *   唯一靠账本压回流，7 天回看会让它们每 ~8 天重新获得资格；
 * - 读侧 fail-open：缺文件/坏 JSON 一律当无历史（宁可重复一天，不误杀整报）。
 */

const SHOWN_FILE = "shown.json"
const DEFAULT_LOOKBACK_DAYS = 30

/** F037 正式首发切换：此前试发账本保留取证，但不参与 2026-07-15 首封正式日报选材。 */
export const F037_FORMAL_DEDUP_START_DATE = "2026-07-15"

export interface LoadShownKeysOptions {
  days?: number
  /** 只读取该业务日（含）之后的账本；YYYY-MM-DD 可按字典序比较。 */
  notBefore?: string
}

/** 业务日（YYYY-MM-DD 日历字符串）平移，UTC 语义无时区坑 */
export function shiftBusinessDate(date: string, deltaDays: number): string {
  const [y, m, d] = date.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10)
}

/** 近 days 天（不含 businessDate 当日）的已见 dedupeKey 并集 */
export function loadShownKeys(
  baseDir: string,
  businessDate: string,
  options: number | LoadShownKeysOptions = {},
): Set<string> {
  const days = typeof options === "number" ? options : (options.days ?? DEFAULT_LOOKBACK_DAYS)
  const notBefore = typeof options === "number" ? undefined : options.notBefore
  const out = new Set<string>()
  for (let i = 1; i <= days; i++) {
    const ledgerDate = shiftBusinessDate(businessDate, -i)
    if (notBefore && ledgerDate < notBefore) break
    const file = path.join(baseDir, ledgerDate, SHOWN_FILE)
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { keys?: unknown }
      if (Array.isArray(parsed.keys)) {
        for (const k of parsed.keys) if (typeof k === "string") out.add(k)
      }
    } catch {
      // 缺文件（当天没发报）/坏 JSON → 当无历史
    }
  }
  return out
}

export function writeShownLedger(
  baseDir: string,
  businessDate: string,
  keys: Iterable<string>,
): void {
  const dayDir = path.join(baseDir, businessDate)
  fs.mkdirSync(dayDir, { recursive: true })
  const file = path.join(dayDir, SHOWN_FILE)
  // 同日并集（P1-2）：force 重发选材可能与首发不同，两批都算这一天「已见过」
  const merged = new Set<string>()
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { keys?: unknown }
    if (Array.isArray(parsed.keys)) {
      for (const k of parsed.keys) if (typeof k === "string") merged.add(k)
    }
  } catch {
    // 当日首写/坏 JSON → 当空集起步
  }
  for (const k of keys) merged.add(k)
  fs.writeFileSync(file, JSON.stringify({ businessDate, keys: [...merged].sort() }, null, 2))
}
